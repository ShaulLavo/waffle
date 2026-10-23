import { retainedFile } from "./fixtures/write-barrier-r2-fixture";
import { nextReservation, storeReservation, type StoredReservation } from "../fs/file-identity";
import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend";
import { FilesystemClient } from "../fs/client";
import { FilesystemService } from "../fs/service";

const bytes = (value: string) => new TextEncoder().encode(value);
class HeldBackend extends MemoryBackend {
  entered = Promise.withResolvers<void>();
  released = Promise.withResolvers<void>();
  async flush(): Promise<void> {
    this.entered.resolve();
    await this.released.promise;
  }
}

test("owner cut excludes a retained independent direct writer throughout held flush", async () => {
  const backend = new HeldBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const page = new FilesystemClient(pair.client);
  const guestPair = createFilesystemConnection(pair.client);
  service.connect(guestPair.server);
  const guest = new FilesystemClient(guestPair.client);
  let flushing: Promise<unknown> | undefined;
  let lease: Awaited<ReturnType<FilesystemService["pauseFilesystemWrites"]>> | undefined;
  try {
    await page.asyncCall("writeFile", ["/shared", false, false], bytes("before"));
    const root: number = await guest.asyncCall("preopen", ["/"]);
    const path: { node: number } = await guest.asyncCall("resolve", [root, "shared"]);
    guest.retain(path.node);
    lease = await service.pauseFilesystemWrites();
    flushing = lease.flush();
    await backend.entered.promise;
    expect(guest.tryWrite(path.node, [bytes("during")], 0)).toBe(-6);
    expect(backend.shared.snapshot(path.node)?.data).toEqual(bytes("before"));
  } finally {
    backend.released.resolve();
    await flushing;
    await lease?.release();
    guest.dispose();
    page.dispose();
    service.dispose();
    pair.server.port.close();
    guestPair.server.port.close();
  }
});

import {
  createFilesystemConnection,
  connectFilesystemIdentity,
  createFilesystemIdentity,
  createProcessFilesystemIdentity,
  reapFilesystem,
  revokeFilesystem,
  PAGE,
} from "../fs/protocol";
import {
  WriteAdmission,
  WRITE_INPUT_LIMIT,
  writeArgumentSize,
  WRITE_BARRIER_OFFSET,
} from "../fs/write-barrier";
import { SharedFilesystemState } from "../fs/shared";
import { PersistentBackend } from "../fs/persistent";
import {
  snapshotBatch,
  type StorageBackend,
  type PersistedIndex,
  type PersistenceBatch,
} from "../fs/storage";
import { type PublicationConfiguration } from "../fs/publication-internal";
import { ResidentGrantCell, type ResidentDescriptor } from "../fs/publication-grant";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function pending(work: Promise<unknown>) {
  let settled = false;
  void work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await turn();
  expect(settled).toBe(false);
}
async function fixture(
  run: (f: {
    backend: MemoryBackend;
    service: FilesystemService;
    client: FilesystemClient;
    handle: number;
  }) => Promise<void>,
  backend = new MemoryBackend(),
  publication?: PublicationConfiguration,
) {
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection(undefined, publication);
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  try {
    const handle = await retainedFile(client);
    await run({ backend, service, client, handle });
  } finally {
    client.dispose();
    service.dispose();
    pair.server.port.close();
    if (backend instanceof PersistentBackend) {
      await backend.close().catch(() => {});
      backend.dispose();
    }
  }
}

const publication: PublicationConfiguration = {
  observe: true,
  limits: {
    sessions: 8,
    operations: 16,
    inputBytes: 64,
    argumentBytes: 1024,
    effectBytes: 4096,
    effects: 16,
    resultBytes: 256,
    logRecords: 4,
    logBytes: 16384,
    pins: 2,
    pinBytes: 256,
  },
};

for (const published of [false, true]) {
  test(`denied mutation forms leave no bytes, namespace, epoch or publication effects, publication=${published}`, async () => {
    await fixture(
      async ({ backend, service, client, handle }) => {
        const before = backend.shared.snapshot(handle);
        const epoch = Atomics.load(new Int32Array(client.connection.epoch), 0);
        const cut = backend.shared.publication?.cut();
        const lease = await service.pauseFilesystemWrites();
        try {
          const source = bytes("later!");
          expect(client.tryWrite(handle, [source], 0)).toBe(-6);
          expect(client.tryWrite(handle, [new Uint8Array()], 0)).toBe(-6);
          expect(client.tryAppend(handle, [source])).toBe(-6);
          expect(client.resize(handle, 0, true)).toBe(6);
          expect(client.setMtime(handle, 42)).toBe(6);
          expect(() => backend.shared.resize(handle, 0, true)).toThrow();
          expect(() => backend.shared.setMtime(handle, 42)).toThrow();
          expect(() => backend.shared.setMode(handle, 0o400)).toThrow();
          const calls: [string, unknown[]][] = [
            ["write", [handle, 0]],
            ["append", [handle]],
            ["resize", [handle, 2, true]],
            ["resize", [handle, PAGE, false]],
            ["setMode", [handle, 0o400]],
            ["setMtime", [handle, 42]],
            ["preopen", ["/new/parent"]],
            ["writeFile", ["/shared", false, true]],
            ["writeFile", ["/shared", true]],
            ["mkdirp", ["/new/parent"]],
            ["remove", ["/shared"]],
            ["move", ["/shared", "/moved"]],
            ["create", [{ parent: 0, name: "new" }, "file", false]],
            [
              "link",
              [
                { node: handle, name: "shared" },
                { parent: 0, name: "alias" },
              ],
            ],
            [
              "rename",
              [
                { node: handle, name: "shared" },
                { parent: 0, name: "renamed" },
              ],
            ],
            ["removePath", [{ node: handle, name: "shared" }, false]],
          ];
          for (const [operation, args] of calls) {
            const outcome = await client.asyncCall(operation, args, source).then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
            expect(outcome).toMatchObject({ error: { errno: 6 } });
            expect(() => backend.execute(operation, args, source)).toThrow();
          }
          source.fill(90);
          expect(backend.shared.snapshot(handle)).toEqual(before);
          expect(Atomics.load(new Int32Array(client.connection.epoch), 0)).toBe(epoch);
          expect(backend.shared.publication?.cut()).toEqual(cut);
          expect(backend.shared.writeAdmission.active).toBe(0);
          expect(backend.shared.writeAdmission.inputBytes).toBe(0);
        } finally {
          await lease.release();
        }
        expect(client.tryWrite(handle, [bytes("retry!")], 0)).toBe(6);
        expect(backend.shared.snapshot(handle)?.data).toEqual(bytes("retry!"));
      },
      new MemoryBackend(),
      published ? publication : undefined,
    );
  });
}

test("ordinary flush remains nonexclusive", async () => {
  const backend = new HeldBackend();
  await fixture(async ({ client, handle }) => {
    const flushing = client.asyncCall("flush");
    try {
      await backend.entered.promise;
      expect(client.tryWrite(handle, [bytes("during")], 0)).toBe(6);
    } finally {
      backend.released.resolve();
      await flushing;
    }
  }, backend);
});

test("prepared transport, cancellation observer and cold requeue remain in the earlier drain", async () => {
  const entered = Promise.withResolvers<void>(),
    resumed = Promise.withResolvers<void>();
  class Cold extends MemoryBackend {
    prepare(operation: string, args: unknown[]) {
      if (operation === "writeFile" && args[0] === "/cold") {
        entered.resolve();
        return resumed.promise;
      }
    }
  }
  await fixture(async ({ backend, service, client, handle }) => {
    const completion = client.prepare("writeFile", ["/cold"], bytes("owned"));
    const acquired = service.pauseFilesystemWrites();
    await pending(acquired);
    expect(client.tryWrite(handle, [bytes("later!")], 0)).toBe(-6);
    client.dispatch(completion);
    await entered.promise;
    const observer = completion.value().catch((error: unknown) => error);
    completion.cancel();
    expect(await observer).toMatchObject({ errno: 11 });
    await pending(acquired);
    expect(backend.shared.writeAdmission.active).toBe(1);
    resumed.resolve();
    const lease = await acquired;
    completion.release();
    expect(backend.fs.readFile("/cold")).toBeUndefined();
    expect(backend.shared.writeAdmission.active).toBe(0);
    await lease.release();
  }, new Cold());
});

test("earlier actual direct worker drains before the lease and later writers cannot overtake", async () => {
  await fixture(async ({ backend, service, client, handle }) => {
    const pair = createFilesystemConnection(client.connection);
    service.connect(pair.server);
    const worker = new Worker(new URL("./fixtures/write-barrier-worker.ts", import.meta.url).href);
    const control = new SharedArrayBuffer(4);
    const admitted = Promise.withResolvers<void>(),
      finished = Promise.withResolvers<number>();
    worker.onmessage = ({ data }) => {
      if (data.admitted) admitted.resolve();
      else finished.resolve(data.result);
    };
    worker.onerror = (error) => {
      admitted.reject(error);
      finished.reject(error);
    };
    let acquisition: ReturnType<FilesystemService["pauseFilesystemWrites"]> | undefined;
    try {
      worker.postMessage({ connection: pair.client, control, beforeCut: true }, [pair.client.port]);
      await admitted.promise;
      acquisition = service.pauseFilesystemWrites();
      await pending(acquisition);
      expect(client.tryWrite(handle, [bytes("later!!")], 0)).toBe(-6);
      Atomics.store(new Int32Array(control), 0, 1);
      Atomics.notify(new Int32Array(control), 0);
      expect(await finished.promise).toBe(7);
      const lease = await acquisition;
      expect(backend.shared.snapshot(handle)?.data).toEqual(bytes("earlier"));
      await lease.flush();
      expect(client.tryWrite(handle, [bytes("later!!")], 0)).toBe(-6);
      await lease.release();
      expect(client.tryWrite(handle, [bytes("later!!")], 0)).toBe(7);
    } finally {
      Atomics.store(new Int32Array(control), 0, 1);
      Atomics.notify(new Int32Array(control), 0);
      await worker.terminate();
      reapFilesystem(pair.client);
      await acquisition?.then(
        (lease) => lease.release(),
        () => {},
      );
      pair.server.port.close();
    }
  });
});

test("pending, future and independent identities inherit the same root gate", async () => {
  await fixture(async ({ backend, service, client }) => {
    const parent = createFilesystemIdentity(client.connection);
    const identities = [
      createFilesystemIdentity(client.connection),
      createProcessFilesystemIdentity(parent),
    ];
    revokeFilesystem(parent);
    reapFilesystem(parent);
    const lease = await service.pauseFilesystemWrites();
    identities.push(createFilesystemIdentity(client.connection));
    const guests: FilesystemClient[] = [];
    try {
      for (const identity of identities) {
        const pair = connectFilesystemIdentity(identity);
        service.connect(pair.server);
        const guest = new FilesystemClient(pair.client);
        guests.push(guest);
        expect(guest.shared.writeAdmission.closed).toBe(true);
        await expect(guest.asyncCall("writeFile", ["/late"], bytes("late"))).rejects.toMatchObject({
          errno: 6,
        });
      }
      expect(new SharedFilesystemState(backend.shared.buffer).writeAdmission.closed).toBe(true);
      await lease.release();
      for (const guest of guests) await guest.asyncCall("writeFile", ["/late"], bytes("live"));
      expect(backend.execute("readFile", ["/late"], new Uint8Array())).toEqual(bytes("live"));
    } finally {
      await lease.release();
      for (const guest of guests) guest.dispose();
    }
  });
});

test("flush failure is retryable; release joins settlement and cannot reopen a newer lease", async () => {
  class Retry extends MemoryBackend {
    entered = Promise.withResolvers<void>();
    released = Promise.withResolvers<void>();
    calls = 0;
    failure = true;
    async flush() {
      this.calls++;
      this.entered.resolve();
      await this.released.promise;
      if (this.failure) throw new Error("storage fault");
    }
  }
  const backend = new Retry();
  await fixture(async ({ service, client, handle }) => {
    const lease = await service.pauseFilesystemWrites();
    await expect(service.pauseFilesystemWrites()).rejects.toMatchObject({ errno: 10 });
    const first = lease.flush();
    expect(lease.flush()).toBe(first);
    await backend.entered.promise;
    backend.released.resolve();
    await expect(first).rejects.toThrow("storage fault");
    expect(backend.shared.writeAdmission.closed).toBe(true);
    expect(client.tryWrite(handle, [bytes("later!")], 0)).toBe(-6);
    backend.failure = false;
    backend.released = Promise.withResolvers<void>();
    const retry = lease.flush();
    const released = lease.release();
    expect(lease.release()).toBe(released);
    await pending(released);
    expect(client.tryWrite(handle, [bytes("later!")], 0)).toBe(-6);
    backend.released.resolve();
    await retry;
    await released;
    const next = await service.pauseFilesystemWrites();
    await lease.release();
    await expect(lease.flush()).rejects.toMatchObject({ errno: 11 });
    expect(backend.shared.writeAdmission.closed).toBe(true);
    await next.release();
    expect(backend.calls).toBe(2);
    expect(client.tryWrite(handle, [bytes("live!!")], 0)).toBe(6);
  }, backend);
});

test("acquisition abort preserves earlier work and post-delivery abort does not reopen", async () => {
  await fixture(async ({ backend, service, client }) => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(service.pauseFilesystemWrites({ signal: aborted.signal })).rejects.toMatchObject({
      errno: 11,
    });
    const completion = client.prepare("writeFile", ["/queued"], bytes("owned"));
    const signal = new AbortController();
    const acquisition = service.pauseFilesystemWrites({ signal: signal.signal });
    await pending(acquisition);
    signal.abort();
    await expect(acquisition).rejects.toMatchObject({ errno: 11 });
    expect(backend.shared.writeAdmission.closed).toBe(false);
    expect(backend.shared.writeAdmission.active).toBe(1);
    client.dispatch(completion);
    await completion.value();
    completion.release();
    const delivered = new AbortController();
    const lease = await service.pauseFilesystemWrites({ signal: delivered.signal });
    delivered.abort();
    expect(backend.shared.writeAdmission.closed).toBe(true);
    await lease.release();
    expect(backend.execute("readFile", ["/queued"], new Uint8Array())).toEqual(bytes("owned"));
  });
});

test("fixed producer capacity rejects without copies and owner controls remain available", async () => {
  await fixture(async ({ backend, service, client }) => {
    const prepared = Array.from({ length: 64 }, (_, i) =>
      client.prepare("writeFile", [`/queued${i}`], bytes("x")),
    );
    try {
      expect(backend.shared.writeAdmission.active).toBe(64);
      expect(() => client.prepare("writeFile", ["/overflow"], bytes("x"))).toThrow();
      const acquisition = service.pauseFilesystemWrites();
      await pending(acquisition);
      for (const completion of prepared) completion.release();
      const lease = await acquisition;
      expect(backend.shared.writeAdmission.active).toBe(0);
      expect(backend.shared.writeAdmission.inputBytes).toBe(0);
      expect(await client.asyncCall("stat", [0])).toBeDefined();
      await lease.release();
    } finally {
      for (const completion of prepared) completion.release();
    }
    expect(() => client.prepare("writeFile", ["/" + "x".repeat(8192)])).toThrow();
    expect(() => writeArgumentSize(["x".repeat(8192)])).toThrow();
    expect(() =>
      client.prepare("writeFile", ["/bad-capacity"], new Uint8Array(), Infinity),
    ).toThrow();
    expect(() =>
      client.prepare("writeFile", ["/bad-capacity"], new Uint8Array(), PAGE + 1),
    ).toThrow();
    const gate = new WriteAdmission(backend.shared.buffer);
    const large = gate.admit(client.connection.owner, WRITE_INPUT_LIMIT);
    try {
      expect(() => gate.admit(client.connection.owner, 1)).toThrow();
      expect(() => gate.reserveInput(large, Infinity)).toThrow();
    } finally {
      gate.finish(large);
    }
    expect(gate.inputBytes).toBe(0);
  });
});

test("outstanding resident writer remains owned until exact settlement", async () => {
  await fixture(
    async ({ backend, service, client, handle }) => {
      const descriptor: ResidentDescriptor = await client.asyncCall("publicationResident", [
        client.connection.publication!.observer,
        handle,
        "barrier-grant",
      ]);
      const authority = service.residentPublication!;
      authority.activate();
      const session = authority.open(descriptor);
      const cell = new ResidentGrantCell(
        authority.prepare(session, { kind: "append", maxBytes: 1 }),
      );
      const acquisition = service.pauseFilesystemWrites();
      await pending(acquisition);
      expect(cell.tryAppend(handle, [bytes("!")])).toEqual({ written: 1, offset: 7 });
      const result = authority.settle(session, cell.snapshot());
      expect(authority.settle(session, cell.snapshot())).toEqual(result);
      const lease = await acquisition;
      expect(() => authority.prepare(session, { kind: "write", maxBytes: 1, offset: 0 })).toThrow();
      expect(backend.shared.snapshot(handle)?.data).toEqual(bytes("before!"));
      await lease.release();
    },
    new MemoryBackend(),
    publication,
  );
});

class TestStorage implements StorageBackend {
  private identityReservation?: StoredReservation;
  async reserveIdentity(workspace?: string) {
    const value = nextReservation(this.identityReservation, workspace);
    this.identityReservation = storeReservation(value);
    return value;
  }
  index?: PersistedIndex;
  readonly payloads = new Map<string, Uint8Array>();
  flushGate?: {
    entered: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
  };
  persistGate?: {
    entered: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
  };
  rejectFlush = false;
  rejectPersist = false;
  async load() {
    return this.index && structuredClone(this.index);
  }
  async read(key: string) {
    return this.payloads.get(key)!.slice();
  }
  async persist(batch: PersistenceBatch) {
    const snapshot = snapshotBatch(batch);
    this.persistGate?.entered.resolve();
    await this.persistGate?.release.promise;
    if (this.rejectPersist) throw new Error("storage persist rejected");
    const nodes = new Map(this.index?.nodes.map((node) => [node.ino, node]));
    for (const node of snapshot.upserts) nodes.set(node.ino, node);
    for (const ino of snapshot.removes) nodes.delete(ino);
    for (const [key, data] of snapshot.data) this.payloads.set(key, data);
    this.index = {
      version: 1,
      generation: snapshot.generation,
      root: snapshot.root,
      nodes: Array.from(nodes.values()),
    };
  }
  async flush() {
    this.flushGate?.entered.resolve();
    await this.flushGate?.release.promise;
    if (this.rejectFlush) throw new Error("storage flush rejected");
  }
  async close() {}
}
const hold = () => ({
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
});

for (const rejected of [false, true]) {
  test(`real persistent flush excludes actual direct worker and remains reversible, rejected=${rejected}`, async () => {
    const storage = new TestStorage();
    const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
    await fixture(async ({ service, client, handle }) => {
      const pair = createFilesystemConnection(client.connection);
      service.connect(pair.server);
      const worker = new Worker(
        new URL("./fixtures/write-barrier-worker.ts", import.meta.url).href,
      );
      const control = new Int32Array(new SharedArrayBuffer(8));
      const admitted = Promise.withResolvers<void>(),
        result = Promise.withResolvers<number>(),
        retry = Promise.withResolvers<number>();
      worker.onmessage = ({ data }) => {
        if (data.admitted) admitted.resolve();
        else if ("result" in data) result.resolve(data.result);
        else retry.resolve(data.retry);
      };
      worker.onerror = (error) => {
        admitted.reject(error);
        result.reject(error);
        retry.reject(error);
      };
      let lease: Awaited<ReturnType<FilesystemService["pauseFilesystemWrites"]>> | undefined;
      let flushing: Promise<void> | undefined;
      storage.flushGate = hold();
      storage.rejectFlush = rejected;
      try {
        worker.postMessage(
          { connection: pair.client, control: control.buffer, beforeCut: false, retry: true },
          [pair.client.port],
        );
        await admitted.promise;
        lease = await service.pauseFilesystemWrites();
        flushing = lease.flush();
        void flushing.catch(() => {});
        await storage.flushGate.entered.promise;
        expect(Atomics.load(backend.shared.cells, 1)).toBe(0);
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0);
        expect(await result.promise).toBe(-6);
        await expect(
          client.asyncCall("writeFile", ["/editor"], bytes("later")),
        ).rejects.toMatchObject({ errno: 6 });
        expect(backend.shared.snapshot(handle)?.data).toEqual(bytes("before"));
        storage.flushGate.release.resolve();
        if (rejected) await expect(flushing).rejects.toThrow("storage flush rejected");
        else await flushing;
        expect(backend.shared.writeAdmission.closed).toBe(true);
        storage.rejectFlush = false;
        await lease.flush();
        await lease.release();
        Atomics.store(control, 1, 1);
        Atomics.notify(control, 1);
        expect(await retry.promise).toBe(7);
        await client.asyncCall("flush");
        const reopened = await PersistentBackend.open(storage, { intervalMs: 0 });
        try {
          await reopened.prepare("readFile", ["/shared"]);
          expect(reopened.execute("readFile", ["/shared"], new Uint8Array())).toEqual(
            bytes("resumed"),
          );
        } finally {
          await reopened.close();
          reopened.dispose();
        }
        expect(backend.shared.writeAdmission.active).toBe(0);
        expect(backend.shared.writeAdmission.inputBytes).toBe(0);
      } finally {
        storage.flushGate.release.resolve();
        await flushing?.catch(() => {});
        await lease?.release();
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0);
        Atomics.store(control, 1, 1);
        Atomics.notify(control, 1);
        await worker.terminate();
        reapFilesystem(pair.client);
        pair.server.port.close();
      }
    }, backend);
  });
}

async function pressureBackend() {
  const storage = new TestStorage();
  const backend = await PersistentBackend.open(storage, {
    intervalMs: 0,
    checkpointLimits: { maxBytes: 64, maxMetadataBytes: 65536 },
    dirtyLimits: { maxBytes: PAGE + 62, maxWaiters: 4 },
  });
  return { storage, backend };
}
async function pressureCheckpoint(
  backend: PersistentBackend,
  storage: TestStorage,
  client: FilesystemClient,
  handle: number,
) {
  await backend.checkpoint(true);
  expect(client.tryWrite(handle, [new Uint8Array(6).fill(66)], 0)).toBe(6);
  const gate = hold();
  storage.persistGate = gate;
  return { gate, checkpoint: backend.checkpoint(true, handle) };
}

test("pre-cut pressure wait and cancelled observation retain execution ownership outside locks", async () => {
  const { storage, backend } = await pressureBackend();
  await fixture(async ({ service, client, handle }) => {
    const { gate, checkpoint } = await pressureCheckpoint(backend, storage, client, handle);
    let acquisition: ReturnType<FilesystemService["pauseFilesystemWrites"]> | undefined;
    const first = client.prepare("append", [handle], new Uint8Array(1));
    try {
      await gate.entered.promise;
      expect(client.tryWrite(handle, [new Uint8Array(12).fill(67)], 0)).toBe(12);
      client.dispatch(first);
      const observed = first.value().catch((error: unknown) => error);
      for (let attempt = 0; attempt < 100 && !backend.dirtyPressure().waiters; attempt++)
        await turn();
      expect(backend.dirtyPressure().waiters).toBe(1);
      acquisition = service.pauseFilesystemWrites();
      await pending(acquisition);
      expect(Atomics.load(backend.shared.cells, 1)).toBe(0);
      expect(client.tryWrite(handle, [bytes("later!")], 0)).toBe(-6);
      first.cancel();
      expect(await observed).toMatchObject({ errno: 11 });
      gate.release.resolve();
      await checkpoint;
      const lease = await acquisition;
      await lease.flush();
      expect(backend.shared.snapshot(handle)?.data).toEqual(new Uint8Array(12).fill(67));
      expect(backend.dirtyPressure().waiters).toBe(0);
      expect(backend.shared.writeAdmission.active).toBe(0);
      await lease.release();
    } finally {
      gate.release.resolve();
      await checkpoint.catch(() => {});
      first.release();
      await acquisition?.then(
        (lease) => lease.release(),
        () => {},
      );
    }
  }, backend);
});

test("successful cold requeue keeps its pre-cut ticket through final publication", async () => {
  const cold = hold();
  class ColdBackend extends MemoryBackend {
    private prepared = false;
    prepare(operation: string, args: unknown[]) {
      if (operation !== "writeFile" || args[0] !== "/cold" || this.prepared) return;
      this.prepared = true;
      cold.entered.resolve();
      return cold.release.promise;
    }
  }
  await fixture(async ({ backend, service, client, handle }) => {
    const completion = client.prepare("writeFile", ["/cold"], bytes("earlier"));
    const abort = new AbortController();
    const acquisition = service.pauseFilesystemWrites({ signal: abort.signal });
    try {
      client.dispatch(completion);
      await cold.entered.promise;
      await pending(acquisition);
      expect(client.tryAppend(handle, [bytes("!")])).toBe(-6);
      cold.release.resolve();
      await completion.value();
      const lease = await acquisition;
      expect(backend.execute("readFile", ["/cold"], new Uint8Array())).toEqual(bytes("earlier"));
      await lease.flush();
      await lease.release();
    } finally {
      cold.release.resolve();
      completion.release();
      abort.abort();
      await acquisition.then(
        (lease) => lease.release(),
        () => {},
      );
    }
  }, new ColdBackend());
});

test("earlier blocking guest and service pressure retries finish before the owner cut", async () => {
  const storage = new TestStorage();
  const backend = await PersistentBackend.open(storage, {
    intervalMs: 0,
    checkpointLimits: { maxBytes: 64, maxMetadataBytes: 65536 },
    dirtyLimits: { maxBytes: PAGE + 62, maxWaiters: 4 },
  });
  await fixture(async ({ service, client, handle }) => {
    await backend.checkpoint(true);
    const pair = createFilesystemConnection(client.connection);
    service.connect(pair.server);
    const worker = new Worker(new URL("./fixtures/write-barrier-worker.ts", import.meta.url).href);
    const control = new Int32Array(new SharedArrayBuffer(4));
    const admitted = Promise.withResolvers<void>(),
      finished = Promise.withResolvers<unknown>();
    worker.onmessage = ({ data }) =>
      data.admitted ? admitted.resolve() : finished.resolve(data.result);
    worker.onerror = (error) => {
      admitted.reject(error);
      finished.reject(error);
    };
    const abort = new AbortController();
    let acquisition: ReturnType<FilesystemService["pauseFilesystemWrites"]> | undefined;
    let checkpoint: Promise<void> | undefined;
    let earlier: ReturnType<FilesystemClient["prepare"]> | undefined;
    const pressured = Promise.withResolvers<void>();
    const waitForDirtyCapacity = backend.waitForDirtyCapacity.bind(backend);
    backend.waitForDirtyCapacity = (changed, cancelled) => {
      const waiting = waitForDirtyCapacity(changed, cancelled);
      if (backend.dirtyPressure().waiters === 2) pressured.resolve();
      return waiting;
    };
    storage.persistGate = hold();
    try {
      worker.postMessage(
        { connection: pair.client, control: control.buffer, beforeCut: true, append: true },
        [pair.client.port],
      );
      await admitted.promise;
      expect(client.tryWrite(handle, [new Uint8Array(6).fill(66)], 0)).toBe(6);
      checkpoint = backend.checkpoint(true, handle);
      await storage.persistGate.entered.promise;
      earlier = client.prepare("append", [handle], new Uint8Array([68]));
      expect(client.tryWrite(handle, [new Uint8Array(12).fill(67)], 0)).toBe(12);
      client.dispatch(earlier);
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
      await pressured.promise;
      expect(backend.dirtyPressure().waiters).toBe(2);
      acquisition = service.pauseFilesystemWrites({ signal: abort.signal });
      await pending(acquisition);
      expect(Atomics.load(backend.shared.cells, 1)).toBe(0);
      expect(client.tryAppend(handle, [bytes("later")])).toBe(-6);
      storage.persistGate.release.resolve();
      await checkpoint;
      expect(await earlier.value()).toMatchObject({ written: 1 });
      expect(await finished.promise).toMatchObject({ written: 1 });
      const lease = await acquisition;
      expect(backend.shared.stat(handle)?.size).toBe(14);
      expect(Array.from(backend.shared.snapshot(handle)!.data.slice(12)).sort()).toEqual([67, 68]);
      await lease.flush();
      expect(backend.dirtyPressure().waiters).toBe(0);
      expect(backend.shared.writeAdmission.active).toBe(0);
      await lease.release();
    } finally {
      storage.persistGate.release.resolve();
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
      await worker.terminate();
      reapFilesystem(pair.client);
      earlier?.release();
      abort.abort();
      await checkpoint?.catch(() => {});
      await acquisition?.then(
        (lease) => lease.release(),
        () => {},
      );
      pair.server.port.close();
    }
  }, backend);
}, 15000);

for (const phase of ["acquiring", "held", "flushing"]) {
  test(`terminal owner stop wins over ${phase} and a later release`, async () => {
    const backend = new HeldBackend();
    await fixture(async ({ service, client }) => {
      const completion =
        phase === "acquiring" ? client.prepare("writeFile", ["/queued"], bytes("x")) : undefined;
      const acquisition = service.pauseFilesystemWrites();
      let flushing: Promise<void> | undefined;
      try {
        if (phase === "acquiring") {
          await pending(acquisition);
          service.dispose();
          await expect(acquisition).rejects.toMatchObject({ errno: 11 });
          expect(backend.shared.writeAdmission.closed).toBe(true);
          await expect(service.pauseFilesystemWrites()).rejects.toMatchObject({ errno: 11 });
          return;
        }
        const lease = await acquisition;
        if (phase === "flushing") {
          flushing = lease.flush();
          await backend.entered.promise;
        }
        service.dispose();
        backend.released.resolve();
        await flushing;
        await lease.release();
        await expect(lease.flush()).rejects.toMatchObject({ errno: 11 });
        expect(backend.shared.writeAdmission.closed).toBe(true);
        await expect(service.pauseFilesystemWrites()).rejects.toMatchObject({ errno: 11 });
      } finally {
        backend.released.resolve();
        completion?.release();
        await flushing?.catch(() => {});
        await acquisition.then(
          (lease) => lease.release(),
          () => {},
        );
      }
    }, backend);
  });
}

import { ResidentAuthorityServer } from "../browser/publication-authority";
import { ResidentChannel, residentDescriptor, residentSession } from "../fs/publication-attachment";

test("private workspace bridge admits against the actual authority root gate", async () => {
  await fixture(
    async ({ backend, service, client }) => {
      const root: number = await client.asyncCall("preopen", ["/"]);
      const workspace = `barrier-${crypto.randomUUID()}`;
      const descriptor = residentDescriptor(
        await client.asyncCall("publicationWorkspace", [
          client.connection.publication!.observer,
          root,
          workspace,
        ]),
      );
      const authority = service.residentPublication!;
      authority.activate();
      const guard = { release: () => Promise.resolve() };
      const server = new ResidentAuthorityServer(authority, guard, guard);
      const channel = new ResidentChannel(workspace);
      let session: ReturnType<typeof residentSession> | undefined;
      let lease: Awaited<ReturnType<FilesystemService["pauseFilesystemWrites"]>> | undefined;
      try {
        session = residentSession(await channel.call("open", descriptor));
        lease = await service.pauseFilesystemWrites();
        const request = { operation: "writeFile", args: ["/bridge"], input: bytes("after") };
        await expect(
          channel.call("workspace", { token: session.token, request }),
        ).rejects.toMatchObject({ errno: 6 });
        expect(backend.fs.readFile("/bridge")).toBeUndefined();
        expect(backend.shared.writeAdmission.active).toBe(0);
        await lease.release();
        await channel.call("workspace", { token: session.token, request });
        const node = backend.fs.lookup("/bridge")!;
        expect(backend.shared.snapshot(backend.fs.handleForNode(node))?.data).toEqual(
          bytes("after"),
        );
      } finally {
        await lease?.release();
        if (session) await channel.call("close", { token: session.token });
        channel.close();
        await server.stop();
      }
    },
    new MemoryBackend(),
    publication,
  );
});

import { SharedFilesystem, ownerWriteBarrier } from "../browser/shared-fs";
import { atomicsWaitAsync } from "../proc/intrinsics";

async function closed(filesystem: SharedFilesystem): Promise<void> {
  const gate = filesystem.client.shared.writeAdmission;
  const words = new Int32Array(filesystem.client.connection.shared, WRITE_BARRIER_OFFSET, 8);
  while (!gate.closed) {
    const observed = gate.change;
    const waiting = !gate.closed && atomicsWaitAsync(words, 4, observed);
    if (waiting && waiting.async) await waiting.value;
  }
}

test("page-tail acceptance precedes dispatch and drains before an actual worker lease", async () => {
  const filesystem = new SharedFilesystem({
    mode: "memory",
    workerURL: new URL("./fixtures/filesystem-default-service.ts", import.meta.url).href,
  });
  const dispatch = filesystem.client.dispatch.bind(filesystem.client);
  const entered = Promise.withResolvers<Parameters<typeof dispatch>[0]>();
  const abort = new AbortController();
  let acquisition: ReturnType<SharedFilesystem[typeof ownerWriteBarrier]> | undefined;
  try {
    await filesystem.writeFile("/shared", "before");
    filesystem.client.dispatch = (completion) => {
      entered.resolve(completion);
    };
    const writing = filesystem.writeFile("/shared", "earlier");
    const completion = await entered.promise;
    acquisition = filesystem[ownerWriteBarrier]({ signal: abort.signal });
    await closed(filesystem);
    await pending(acquisition);
    expect(filesystem.client.shared.writeAdmission.closed).toBe(true);
    await expect(filesystem.writeFile("/later", "later")).rejects.toMatchObject({ errno: 6 });
    dispatch(completion);
    filesystem.client.dispatch = dispatch;
    await writing;
    const lease = await acquisition;
    await lease.flush();
    expect(new TextDecoder().decode(await filesystem.readFile("/shared"))).toBe("earlier");
    await lease.release();
    filesystem.client.dispatch = dispatch;
    await filesystem.writeFile("/shared", "resumed");
  } finally {
    filesystem.client.dispatch = dispatch;
    abort.abort();
    for (const completion of filesystem.client.completions.values()) completion.release();
    await acquisition?.then(
      (lease) => lease.release(),
      () => {},
    );
    await filesystem.dispose();
  }
});

test("the default input budget preserves one 128 MiB page string mutation", async () => {
  const filesystem = new SharedFilesystem({
    mode: "memory",
    workerURL: new URL("./fixtures/filesystem-default-service.ts", import.meta.url).href,
  });
  const size = 128 * 1024 * 1024;
  let lease: Awaited<ReturnType<SharedFilesystem[typeof ownerWriteBarrier]>> | undefined;
  try {
    const root: number = await filesystem.client.asyncCall("preopen", ["/"]);
    const writing = filesystem.writeFile("/large", "a".repeat(size));
    lease = await filesystem[ownerWriteBarrier]();
    await writing;
    const path: { node: number } = await filesystem.client.asyncCall("resolve", [root, "large"]);
    expect(await filesystem.client.asyncCall("stat", [path.node])).toMatchObject({ size });
    expect(filesystem.client.shared.writeAdmission.inputBytes).toBe(0);
    expect(filesystem.client.shared.writeAdmission.active).toBe(0);
    await lease.release();
    await filesystem.writeFile("/unicode", "a\u0000\u00e9\ud83d\ude00\ud800");
    expect(await filesystem.readFile("/unicode")).toEqual(bytes("a\u0000\u00e9\ud83d\ude00\ud800"));
  } finally {
    await lease?.release();
    await filesystem.dispose();
  }
}, 30000);

test("request ownership cannot be duplicated and reaping a dead local preserves actual service work", async () => {
  const gate = new WriteAdmission(SharedFilesystemState.createBuffer());
  const ticket = gate.admit(1, 8);
  gate.reserveMetadata(ticket, 1024);
  gate.send(ticket, 1);
  gate.receive(ticket, 1, 1, false);
  expect(() => gate.receive(ticket, 1, 1, false)).toThrow();
  expect(() => gate.receive(ticket, 2, 1, true)).toThrow();
  const lease = gate.close();
  const draining = gate.drain(lease);
  gate.reapLocal(1);
  await pending(draining);
  expect(gate.inputBytes).toBe(8);
  expect(gate.metadataBytes).toBe(1024);
  gate.receive(ticket, 1, 1, true);
  gate.finish(ticket, -1);
  gate.finish(ticket, -1);
  await draining;
  expect(gate.active).toBe(0);
  expect(gate.metadataBytes).toBe(0);
  gate.open(lease);
  const next = gate.admit(2);
  gate.finish(ticket);
  expect(gate.active).toBe(1);
  gate.finish(next);
});

test("a proven dead admission owner cannot leave the tiny admission lock held", () => {
  const buffer = SharedFilesystemState.createBuffer();
  const gate = new WriteAdmission(buffer);
  const ticket = gate.admit(1, 8);
  Atomics.store(new Int32Array(buffer, WRITE_BARRIER_OFFSET), 0, 1);
  gate.reapLocal(1);
  const next = gate.admit(2);
  gate.finish(ticket);
  expect(gate.active).toBe(1);
  expect(gate.inputBytes).toBe(0);
  gate.finish(next);
  expect(() => writeArgumentSize(["\u0000".repeat(1400)])).toThrow();
});

test("rejected pressure checkpoint retains dirty debt and the held lease can retry flush", async () => {
  const { storage, backend } = await pressureBackend();
  await fixture(async ({ service, client, handle }) => {
    const { gate, checkpoint } = await pressureCheckpoint(backend, storage, client, handle);
    void checkpoint.catch(() => {});
    let acquisition: ReturnType<FilesystemService["pauseFilesystemWrites"]> | undefined;
    const completion = client.prepare("append", [handle], new Uint8Array([68]));
    try {
      await gate.entered.promise;
      expect(client.tryWrite(handle, [new Uint8Array(12).fill(67)], 0)).toBe(12);
      client.dispatch(completion);
      const result = completion.value();
      void result.catch(() => {});
      for (let attempt = 0; attempt < 100 && !backend.dirtyPressure().waiters; attempt++)
        await turn();
      expect(backend.dirtyPressure().waiters).toBe(1);
      acquisition = service.pauseFilesystemWrites();
      void acquisition.catch(() => {});
      await pending(acquisition);
      storage.rejectPersist = true;
      gate.release.resolve();
      await expect(checkpoint).rejects.toThrow("storage persist rejected");
      await expect(result).resolves.toMatchObject({ written: 1 });
      const lease = await acquisition;
      expect(backend.shared.writeAdmission.closed).toBe(true);
      expect(backend.shared.writeAdmission.active).toBe(0);
      expect(backend.dirtyPressure().waiters).toBe(0);
      expect(backend.dirtyPressure().dirtyCaptureBytes).toBeGreaterThan(0);
      expect(backend.shared.stat(handle)?.size).toBe(13);
      await expect(lease.flush()).rejects.toThrow("storage persist rejected");
      expect(client.tryWrite(handle, [bytes("later!")], 0)).toBe(-6);
      storage.rejectPersist = false;
      await lease.flush();
      await lease.release();
      expect(client.tryWrite(handle, [bytes("retry!")], 0)).toBe(6);
    } finally {
      storage.rejectPersist = false;
      gate.release.resolve();
      completion.release();
      await checkpoint.catch(() => {});
      await acquisition?.then(
        (lease) => lease.release(),
        () => {},
      );
    }
  }, backend);
});

test("an actual pre-cut mutation failure rejects acquisition and reopens without revocation", async () => {
  const cold = hold();
  class Failure extends MemoryBackend {
    prepare(operation: string, args: unknown[]) {
      if (operation !== "writeFile" || args[0] !== "/failure") return;
      cold.entered.resolve();
      return cold.release.promise.then(() => {
        throw new Error("cold input failed");
      });
    }
  }
  await fixture(async ({ backend, service, client, handle }) => {
    const writing = client.asyncCall("writeFile", ["/failure"], bytes("never"));
    void writing.catch(() => {});
    await cold.entered.promise;
    const acquisition = service.pauseFilesystemWrites();
    void acquisition.catch(() => {});
    try {
      await pending(acquisition);
      cold.release.resolve();
      await expect(writing).rejects.toMatchObject({ errno: 29 });
      await expect(acquisition).rejects.toMatchObject({ errno: 6 });
      expect(backend.shared.writeAdmission.active).toBe(0);
      expect(backend.shared.writeAdmission.closed).toBe(false);
      expect(backend.fs.readFile("/failure")).toBeUndefined();
      expect(client.tryWrite(handle, [bytes("retry!")], 0)).toBe(6);
    } finally {
      cold.release.resolve();
      await writing.catch(() => {});
      await acquisition.then(
        (lease) => lease.release(),
        () => {},
      );
    }
  }, new Failure());
});

test("first root attachment cannot replace a held preconnection gate", async () => {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  const client = new FilesystemClient(pair.client);
  const lease = await service.pauseFilesystemWrites();
  try {
    expect(() => service.connect(pair.server)).toThrow("filesystem root has admitted writes");
    await lease.release();
    service.connect(pair.server);
    await client.asyncCall("writeFile", ["/attached"], bytes("usable"));
    expect(await client.asyncCall("readFile", ["/attached"])).toEqual(bytes("usable"));
  } finally {
    await lease.release();
    client.dispose();
    service.dispose();
    pair.server.port.close();
  }
});

for (const { append, cancelled } of [
  { append: false, cancelled: false },
  { append: true, cancelled: false },
  { append: false, cancelled: true },
]) {
  test(`blocking guest admission lock waits outside mutation sections, append=${append}, cancelled=${cancelled}`, async () => {
    await fixture(async ({ backend, client, handle }) => {
      const pair = client.fork();
      const worker = new Worker(
        new URL("./fixtures/write-barrier-worker.ts", import.meta.url).href,
      );
      const control = new Int32Array(new SharedArrayBuffer(4));
      const lock = new Int32Array(backend.shared.buffer, WRITE_BARRIER_OFFSET, 1);
      const ready = Promise.withResolvers<void>();
      const first = Promise.withResolvers<unknown>();
      const result = Promise.withResolvers<unknown>();
      worker.onmessage = ({ data }) => {
        if (data.admitted) ready.resolve();
        else if (data.waitingAdmission) first.resolve(data);
        else {
          first.resolve(data);
          result.resolve(data.result);
        }
      };
      worker.onerror = (error) => {
        ready.reject(error);
        first.reject(error);
        result.reject(error);
      };
      try {
        worker.postMessage(
          {
            connection: pair,
            control: control.buffer,
            beforeCut: false,
            append,
            admissionWait: true,
          },
          [pair.port],
        );
        await ready.promise;
        Atomics.store(lock, 0, client.connection.owner);
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0);
        expect(await first.promise).toEqual({ waitingAdmission: true });
        expect(Atomics.load(backend.shared.cells, 1)).toBe(0);
        expect(Atomics.load(new Int32Array(pair.sections), 0)).toBe(0);
        expect(client.tryWrite(handle, [bytes("later!")], 0)).toBe(-6);
        expect(backend.shared.snapshot(handle)?.data).toEqual(bytes("before"));
        if (cancelled) revokeFilesystem(pair);
        else {
          Atomics.store(lock, 0, 0);
          Atomics.notify(lock, 0);
        }
        expect(await result.promise).toEqual(
          cancelled ? -11 : append ? { written: 1, offset: 7 } : 7,
        );
        expect(backend.shared.snapshot(handle)?.data).toEqual(
          bytes(cancelled ? "before" : append ? "beforeC" : "earlier"),
        );
        expect(backend.shared.writeAdmission.active).toBe(0);
      } finally {
        Atomics.store(lock, 0, 0);
        Atomics.notify(lock, 0);
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0);
        await worker.terminate();
        reapFilesystem(pair);
      }
    });
  });
}
