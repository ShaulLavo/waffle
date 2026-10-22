import { expect, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent";
import { FilesystemClient } from "../fs/client";
import { FilesystemService } from "../fs/service";
import { createFilesystemConnection, PAGE } from "../fs/protocol";
import {
  snapshotBatch,
  type PersistedIndex,
  type PersistenceBatch,
  type StorageBackend,
} from "../fs/storage";

const data = (length: number, value = 65) => new Uint8Array(length).fill(value);
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 2));

class ControlledStorage implements StorageBackend {
  index?: PersistedIndex;
  readonly bytes = new Map<string, Uint8Array>();
  readonly batches: PersistenceBatch[] = [];
  readonly flushes: (readonly string[] | undefined)[] = [];
  gate?: {
    entered: ReturnType<typeof Promise.withResolvers<void>>;
    released: ReturnType<typeof Promise.withResolvers<void>>;
  };
  failure?: Error;
  hold() {
    this.gate = { entered: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() };
    return this.gate;
  }
  async load() {
    return this.index;
  }
  async read(key: string) {
    return this.bytes.get(key)!.slice();
  }
  async persist(input: PersistenceBatch) {
    const batch = snapshotBatch(input);
    this.batches.push(batch);
    this.gate?.entered.resolve();
    if (this.gate) await this.gate.released.promise;
    if (this.failure) throw this.failure;
    const nodes = new Map(this.index?.nodes.map((node) => [node.ino, node]));
    for (const node of batch.upserts) nodes.set(node.ino, node);
    for (const ino of batch.removes) nodes.delete(ino);
    for (const [key, bytes] of batch.data) this.bytes.set(key, bytes);
    this.index = {
      version: 1,
      generation: batch.generation,
      root: batch.root,
      nodes: Array.from(nodes.values()),
    };
  }
  async flush(keys?: readonly string[]) {
    this.flushes.push(keys);
  }
  async close() {}
}

type Options = NonNullable<Parameters<typeof PersistentBackend.open>[1]>;
interface Fixture {
  backend: PersistentBackend;
  client: FilesystemClient;
  handle: number;
  storage: ControlledStorage;
  track: (work: Promise<void>) => Promise<void>;
}
async function fixture(run: (context: Fixture) => Promise<void>, options: Options = {}) {
  const storage = new ControlledStorage();
  const backend = await PersistentBackend.open(storage, {
    intervalMs: 0,
    checkpointLimits: { maxBytes: 32, maxMetadataBytes: 65536 },
    ...options,
  });
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  const work: Promise<void>[] = [];
  const track = (promise: Promise<void>) => {
    void promise.catch(() => {});
    work.push(promise);
    return promise;
  };
  try {
    await client.asyncCall("writeFile", ["/file"], data(4));
    const root = await client.asyncCall("preopen", ["/"]);
    const path = await client.asyncCall("resolve", [root, "file"]);
    client.retain(path.node);
    await backend.checkpoint(true);
    await run({ backend, client, handle: path.node, storage, track });
  } finally {
    storage.gate?.released.resolve();
    client.dispose();
    service.dispose();
    await Promise.allSettled(work);
    await Promise.allSettled([backend.close()]);
    backend.dispose();
  }
}

async function waiters(backend: PersistentBackend, count: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (backend.dirtyPressure().waiters === count) return;
    await turn();
  }
  expect(backend.dirtyPressure().waiters).toBe(count);
}

async function held(context: Fixture) {
  const { backend, storage, client, handle, track } = context;
  expect(client.tryWrite(handle, [data(4, 66)], 0)).toBe(4);
  const gate = storage.hold();
  const checkpoint = track(backend.checkpoint(true, handle));
  await gate.entered.promise;
  return { gate, checkpoint };
}

const tiny = { dirtyLimits: { maxBytes: PAGE + 40, maxWaiters: 1 } };

test("actual direct guest growth cannot create an unsaveable dirty cut", async () => {
  await fixture(async ({ backend, client, handle }) => {
    const before = backend.shared.snapshot(handle);
    expect(client.tryWrite(handle, [data(17, 90)], 0)).toBe(-6);
    expect(backend.shared.snapshot(handle)).toEqual(before);
    await backend.checkpoint(true);
  });
});

test("held storage bounds host and real direct growth with no delayed EAGAIN effects", async () => {
  await fixture(async (context) => {
    const { backend, client, handle } = context;
    const { gate, checkpoint } = await held(context);
    expect(client.tryWrite(handle, [data(8, 67)], 0)).toBe(8);
    const before = backend.shared.snapshot(handle);
    for (let attempt = 0; attempt < 40; attempt++) {
      expect(client.tryAppend(handle, [data(1, 90)])).toBe(-6);
      expect(() => backend.execute("write", [handle, 8], data(1, 90))).toThrow("dirty capacity");
      expect(backend.shared.snapshot(handle)).toEqual(before);
      expect(backend.dirtyPressure().accountedBytes).toBe(PAGE + 24);
      expect(backend.dirtyPressure().waiters).toBe(0);
    }
    gate.released.resolve();
    await checkpoint;
    await turn();
    expect(backend.shared.snapshot(handle)).toEqual(before);
    expect(client.tryAppend(handle, [data(1, 68)])).toEqual({ written: 1, offset: 9 });
    await backend.checkpoint(true, handle);
    expect(backend.dirtyPressure().immutableCopyBytes).toBe(0);
    expect(backend.dirtyPressure().dirtyCaptureBytes).toBe(0);
  }, tiny);
});

test("blocking service producers wait outside locks and cancellation frees bounded admission", async () => {
  await fixture(async (context) => {
    const { backend, client, handle } = context;
    const { gate, checkpoint } = await held(context);
    expect(client.tryWrite(handle, [data(8, 67)], 0)).toBe(8);
    const before = backend.shared.snapshot(handle);
    const first = client.submit("append", [handle], data(1, 90));
    const cancelled = first.value().catch((error: unknown) => error);
    try {
      await waiters(backend, 1);
      await expect(client.asyncCall("append", [handle], data(1, 91))).rejects.toMatchObject({
        errno: 6,
      });
      expect(await client.asyncCall("stat", [handle])).toEqual(before!.stat);
      first.cancel();
      await expect(cancelled).resolves.toMatchObject({ errno: 11 });
      await waiters(backend, 0);
      expect(backend.shared.snapshot(handle)).toEqual(before);
    } finally {
      first.release();
    }
    const next = client.asyncCall("append", [handle], data(1, 68));
    await waiters(backend, 1);
    expect(backend.shared.snapshot(handle)).toEqual(before);
    gate.released.resolve();
    await checkpoint;
    expect(await next).toEqual({ written: 1, offset: 9 });
    await waiters(backend, 0);
    expect(backend.shared.snapshot(handle)!.data).toEqual(
      new Uint8Array(Array.from(data(8, 67)).concat([68])),
    );
  }, tiny);
});

test("resize, mode and time reserve whole-file cuts before changing metadata", async () => {
  await fixture(async ({ backend, client, handle }) => {
    const before = backend.shared.snapshot(handle);
    expect(() => backend.execute("resize", [handle, 17, true], data(0))).toThrow("dirty capacity");
    expect(backend.shared.snapshot(handle)).toEqual(before);
    backend.execute("setMode", [handle, 0o640], data(0));
    backend.execute("setMtime", [handle, 1234], data(0));
    expect(backend.shared.stat(handle)).toMatchObject({ mode: 0o640, mtime: 1234 });
    expect(client.tryAppend(handle, [data(1)])).toEqual({ written: 1, offset: 5 });
    backend.execute("resize", [handle, 2, true], data(0));
    expect(backend.shared.snapshot(handle)!.data).toEqual(data(2));
    await backend.checkpoint(true);
    expect(backend.dirtyPressure().dirtyCaptureBytes).toBe(0);
  });
});

test("namespace pressure rejects complete plans before exposing names or metadata", async () => {
  await fixture(async ({ backend, storage }) => {
    const before = await storage.load();
    const root = backend.fs.root;
    const names = Array.from(root.children.keys());
    const mtime = root.mtime;
    const large = `/${"x".repeat(8000)}/child`;
    expect(() => backend.execute("mkdirp", [large], data(0))).toThrow("dirty capacity");
    expect(Array.from(root.children.keys())).toEqual(names);
    expect(root.mtime).toBe(mtime);
    expect(backend.fs.lookup(large)).toBeUndefined();
    await backend.checkpoint(true);
    expect(storage.index).toEqual(before);
    expect(backend.dirtyPressure().pinUnits).toBeLessThanOrEqual(3 * 2048);
  });
});

test("failed immutable checkpoint retains debt and the prior durable index and bytes", async () => {
  await fixture(async (context) => {
    const { backend, client, handle, storage, track } = context;
    const before = structuredClone(storage.index);
    const bytes = new Map(storage.bytes);
    const { gate, checkpoint } = await held(context);
    expect(client.tryWrite(handle, [data(8, 67)], 0)).toBe(8);
    storage.failure = new Error("injected persist failure");
    gate.released.resolve();
    await expect(checkpoint).rejects.toThrow("injected persist failure");
    expect(storage.index).toEqual(before);
    expect(storage.bytes).toEqual(bytes);
    expect(backend.dirtyPressure().dirtyCaptureBytes).toBe(16);
    expect(backend.dirtyPressure().immutableCopyBytes).toBe(0);
    storage.failure = undefined;
    await track(backend.checkpoint(true, handle));
    const current = storage.index!.nodes.find(
      (node) => node.ino === backend.shared.stat(handle)!.ino,
    )!;
    expect(storage.bytes.get(current.data!)).toEqual(data(8, 67));
    expect(backend.dirtyPressure().dirtyCaptureBytes).toBe(0);
  }, tiny);
});

test("targeted flushes keep immutable cut order without making FAST ACK durable", async () => {
  await fixture(
    async (context) => {
      const { backend, client, handle, storage, track } = context;
      const generation = storage.index!.generation;
      const { gate, checkpoint } = await held(context);
      expect(client.tryWrite(handle, [data(8, 67)], 0)).toBe(8);
      expect(storage.index!.generation).toBe(generation);
      const second = track(backend.checkpoint(true, handle));
      expect(backend.dirtyPressure().pendingOperations).toBe(2);
      expect(backend.dirtyPressure().immutableCopyBytes).toBe(24);
      gate.released.resolve();
      await Promise.all([checkpoint, second]);
      const batches = storage.batches.slice(-2);
      expect(Array.from(batches[0]!.data.values())[0]).toEqual(data(4, 66));
      expect(Array.from(batches[1]!.data.values())[0]).toEqual(data(8, 67));
      expect(storage.flushes.slice(-2)).toEqual(
        batches.map((batch) => Array.from(batch.data.keys())),
      );
      expect(backend.dirtyPressure().pendingOperations).toBe(0);
    },
    { dirtyLimits: { maxBytes: PAGE + 80 } },
  );
});
