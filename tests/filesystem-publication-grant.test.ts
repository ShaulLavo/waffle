import { expect, test } from "bun:test";
import { ResidentAuthorityServer } from "../browser/publication-authority";
import { ResidentChannel, residentGrant, residentSession, encodeResidentOutcome } from "../fs/publication-attachment";
import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
} from "../fs";
import { publicationObserver, type PublicationLimits } from "../fs/publication-internal";

const limits: PublicationLimits = {
  sessions: 8,
  operations: 8,
  inputBytes: 64,
  argumentBytes: 512,
  effectBytes: 4096,
  effects: 16,
  resultBytes: 256,
  logRecords: 4,
  logBytes: 16384,
  pins: 2,
  pinBytes: 256,
};

async function rootFixture(configuration = limits) {
  const backend = new MemoryBackend();
  backend.fs.writeFile("/file", new Uint8Array([1, 2, 3]));
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, {
    limits: configuration,
    observe: true,
  });
  service.connect(connection.server);
  const root = new FilesystemClient(connection.client);
  const directory: number = await root.asyncCall("preopen", ["/"]);
  const path: { node: number } = await root.asyncCall("resolve", [directory, "file"]);
  root.retain(path.node);
  return {
    backend,
    service,
    root,
    connection,
    handle: path.node,
    stop() {
      root.dispose();
      service.dispose();
    },
  };
}

test("the production service issues a private retained resident descriptor", async () => {
  const f = await rootFixture();
  try {
    const before = await publicationObserver(f.root).cut();
    const descriptor: unknown = await f.root.asyncCall("publicationResident", [
      f.connection.client.publication!.observer,
      f.handle,
      "resident-red-control",
    ]);
    expect(descriptor).toMatchObject({ workspace: "resident-red-control", handle: f.handle });
    await rejectsErrno(publicationObserver(f.root).cut(), 6);
    f.service.residentPublication!.activate();
    expect(await publicationObserver(f.root).cut()).toEqual(before);
  } finally {
    f.stop();
  }
});

import { ResidentGrantCell, type ResidentDescriptor } from "../fs/publication-grant";

async function residentFixture(configuration = limits) {
  const f = await rootFixture(configuration);
  const descriptor: ResidentDescriptor = await f.root.asyncCall("publicationResident", [
    f.connection.client.publication!.observer,
    f.handle,
    "resident-fixture",
  ]);
  const authority = f.service.residentPublication!;
  authority.activate();
  const session = authority.open(descriptor);
  return { ...f, authority, session, observer: publicationObserver(f.root) };
}

async function rejectsErrno(action: Promise<unknown>, errno: number): Promise<void> {
  let failure: unknown;
  try {
    await action;
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ errno });
}

test("remote ACK excludes local direct and service operations until exact one-time import", async () => {
  const f = await residentFixture();
  try {
    const before = await f.observer.cut();
    const cell = new ResidentGrantCell(
      f.authority.prepare(f.session, { kind: "append", maxBytes: 2 }),
    );
    expect(Atomics.load(f.backend.shared.cells, 1)).toBe(0);
    const untouched = new Uint8Array([91, 92, 93]);
    expect(f.root.tryRead(f.handle, [untouched], 0)).toBe(-6);
    expect(Array.from(untouched)).toEqual([91, 92, 93]);
    expect(f.root.tryWrite(f.handle, [new Uint8Array([99])], 0)).toBe(-6);
    await rejectsErrno(f.root.asyncCall("writeFile", ["/file"], new Uint8Array([98])), 6);
    expect(cell.tryAppend(f.handle, [new Uint8Array([4, 5])])).toEqual({ written: 2, offset: 5 });
    expect(f.backend.shared.publication!.cut()).toEqual(before);
    expect(f.root.tryRead(f.handle, [untouched], 0)).toBe(-6);
    const publication = cell.snapshot();
    expect(publication.kind).toBe("committed");
    const imported = f.authority.settle(f.session, publication);
    expect(imported).toMatchObject({
      kind: "committed",
      receipt: { cut: { generation: before.generation + 1 } },
    });
    expect(f.authority.settle(f.session, cell.snapshot())).toEqual(imported);
    const output = new Uint8Array(5);
    expect(f.backend.shared.read(f.handle, [output], 0)).toBe(5);
    expect(Array.from(output)).toEqual([1, 2, 3, 4, 5]);
    const changes = await f.observer.changes(before, limits.logBytes);
    expect(changes.kind).toBe("changes");
    if (changes.kind !== "changes") throw new Error("missing group");
    expect(changes.publications).toHaveLength(1);
    // The existing service protocol represents typed bytes as numeric JSON keys.
    expect(JSON.stringify(changes.publications[0])).toBe(
      JSON.stringify(publication.kind === "committed" ? publication.publication : undefined),
    );
    if (publication.kind !== "committed") throw new Error("missing immutable publication");
    const original = publication.publication;
    const changed = {
      ...publication,
      publication: {
        ...original,
        receipt: {
          ...original.receipt,
          cut: { ...original.receipt.cut, generation: original.receipt.cut.generation + 1 },
        },
      },
    };
    expect(() => f.authority.settle(f.session, changed)).toThrow();
    expect(f.authority.settle(f.session, publication)).toEqual(imported);
  } finally {
    f.stop();
  }
});

test("cancelled readiness retains no failed bytes and a changed actual retry commits once", async () => {
  const f = await residentFixture();
  try {
    const before = await f.observer.cut();
    const first = new ResidentGrantCell(
      f.authority.prepare(f.session, { kind: "write", offset: 0, maxBytes: 1 }),
    );
    expect(first.cancel()).toBe(true);
    const failed = new Uint8Array([8]);
    expect(first.tryWrite(f.handle, [failed], 0)).toBe(-6);
    expect(f.authority.settle(f.session, first.snapshot())).toEqual({ kind: "retired" });
    expect(await f.observer.cut()).toEqual(before);
    failed[0] = 9;
    const retry = new ResidentGrantCell(
      f.authority.prepare(f.session, { kind: "write", offset: 0, maxBytes: 1 }),
    );
    expect(retry.tryWrite(f.handle, [failed], 0)).toBe(1);
    failed[0] = 10;
    f.authority.settle(f.session, retry.snapshot());
    const output = new Uint8Array(3);
    expect(f.backend.shared.read(f.handle, [output], 0)).toBe(3);
    expect(Array.from(output)).toEqual([9, 2, 3]);
    expect((await f.observer.cut()).generation).toBe(before.generation + 1);
  } finally {
    f.stop();
  }
});

test("grant claim rechecks cancellation after caller-controlled iovec enumeration", async () => {
  const f = await residentFixture();
  try {
    const cell = new ResidentGrantCell(
      f.authority.prepare(f.session, { kind: "write", offset: 0, maxBytes: 1 }),
    );
    const chunks: Uint8Array[] = [];
    Object.defineProperty(chunks, 0, {
      get() {
        cell.stop();
        return new Uint8Array([7]);
      },
    });
    expect(cell.tryWrite(f.handle, chunks, 0)).toBe(-6);
    expect(cell.snapshot().kind).toBe("cancelled");
    f.authority.settle(f.session, cell.snapshot());
    const output = new Uint8Array(3);
    expect(f.backend.shared.read(f.handle, [output], 0)).toBe(3);
    expect(Array.from(output)).toEqual([1, 2, 3]);
  } finally {
    f.stop();
  }
});

test("read grants use the same exclusion and a lost committed payload stops history", async () => {
  const f = await residentFixture();
  try {
    const read = new ResidentGrantCell(
      f.authority.prepare(f.session, { kind: "read", offset: 1, maxBytes: 2 }),
    );
    const output = new Uint8Array(3).fill(80);
    expect(read.tryRead(f.handle, [output], 1)).toBe(2);
    expect(Array.from(output)).toEqual([2, 3, 80]);
    expect(f.authority.settle(f.session, read.snapshot()).kind).toBe("read");
    const write = new ResidentGrantCell(
      f.authority.prepare(f.session, { kind: "write", offset: 0, maxBytes: 1 }),
    );
    expect(write.tryWrite(f.handle, [new Uint8Array([4])], 0)).toBe(1);
    expect(() =>
      f.authority.settle(f.session, { kind: "stopped", grant: write.grant.key }),
    ).toThrow();
    expect(f.backend.shared.publication!.stopped).toBe(true);
    expect(f.root.tryRead(f.handle, [output], 0)).toBe(-11);
  } finally {
    f.stop();
  }
});

test("retained grant identity survives rename and unlink, while mode denial remains authoritative", async () => {
  const f = await residentFixture();
  try {
    await f.root.asyncCall("move", ["/file", "/renamed"]);
    await f.root.asyncCall("remove", ["/renamed"]);
    await f.root.asyncCall("setMode", [f.handle, 0o400]);
    expect(() => f.authority.prepare(f.session, { kind: "append", maxBytes: 1 })).toThrow();
    await f.root.asyncCall("setMode", [f.handle, 0o600]);
    const ino = f.backend.shared.stat(f.handle)!.ino;
    const cell = new ResidentGrantCell(
      f.authority.prepare(f.session, { kind: "append", maxBytes: 1 }),
    );
    expect(cell.grant.file.ino).toBe(ino);
    expect(cell.tryAppend(f.handle, [new Uint8Array([6])])).toEqual({ written: 1, offset: 4 });
    f.authority.settle(f.session, cell.snapshot());
    const output = new Uint8Array(4);
    expect(f.backend.shared.read(f.handle, [output], 0)).toBe(4);
    expect(Array.from(output)).toEqual([1, 2, 3, 6]);
  } finally {
    f.stop();
  }
});

test("READY reserves effect capacity and exact session identity before any remote success", async () => {
  const f = await residentFixture({ ...limits, effects: 1 });
  try {
    const before = await f.observer.cut();
    expect(() => f.authority.prepare(f.session, { kind: "append", maxBytes: 1 })).toThrow();
    expect(f.backend.shared.publication!.diagnostics().pending).toBe(0);
    expect(await f.observer.cut()).toEqual(before);
    const output = new Uint8Array(3);
    expect(f.backend.shared.read(f.handle, [output], 0)).toBe(3);
    expect(Array.from(output)).toEqual([1, 2, 3]);
  } finally {
    f.stop();
  }
  const live = await residentFixture();
  try {
    const changed = { ...live.session, descriptor: { ...live.session.descriptor, epoch: 2 } };
    expect(() =>
      live.authority.prepare(changed, { kind: "write", offset: 0, maxBytes: 1 }),
    ).toThrow();
    const cell = new ResidentGrantCell(
      live.authority.prepare(live.session, { kind: "write", offset: 0, maxBytes: 1 }),
    );
    expect(cell.tryWrite(live.handle, [new Uint8Array([9])], 0)).toBe(1);
    cell.payload.fill(0);
    expect(cell.snapshot().kind).toBe("stopped");
    expect(() => live.authority.settle(live.session, cell.snapshot())).toThrow();
    expect(live.backend.shared.publication!.stopped).toBe(true);
  } finally {
    live.stop();
  }
});

test("private claim views never reach late guest atomics hooks", async () => {
  const f = await residentFixture();
  const load = Atomics.load,
    store = Atomics.store,
    compareExchange = Atomics.compareExchange;
  let intercepted = 0;
  try {
    const cell = new ResidentGrantCell(
      f.authority.prepare(f.session, { kind: "write", offset: 0, maxBytes: 1 }),
    );
    const observe = (array: ArrayBufferView) => {
      if (array.buffer === cell.state.buffer || array.buffer === cell.payload.buffer) intercepted++;
    };
    Atomics.load = ((array: Int32Array, index: number) => {
      observe(array);
      return load(array, index);
    }) as typeof Atomics.load;
    Atomics.store = ((array: Int32Array, index: number, value: number) => {
      observe(array);
      return store(array, index, value);
    }) as typeof Atomics.store;
    Atomics.compareExchange = ((
      array: Int32Array,
      index: number,
      expected: number,
      replacement: number,
    ) => {
      observe(array);
      return compareExchange(array, index, expected, replacement);
    }) as typeof Atomics.compareExchange;
    const written = cell.tryWrite(f.handle, [new Uint8Array([9])], 0);
    const snapshot = cell.snapshot();
    Atomics.load = load;
    Atomics.store = store;
    Atomics.compareExchange = compareExchange;
    expect(written).toBe(1);
    expect(snapshot.kind).toBe("committed");
    expect(intercepted).toBe(0);
  } finally {
    Atomics.load = load;
    Atomics.store = store;
    Atomics.compareExchange = compareExchange;
    f.stop();
  }
});

test("pending resident activation denies ordinary service and direct cached work", async () => {
  const f = await rootFixture();
  try {
    expect(f.root.tryRead(f.handle, [new Uint8Array(1)], 0)).toBe(1);
    await f.root.asyncCall("publicationResident", [
      f.connection.client.publication!.observer,
      f.handle,
      "pending-control",
    ]);
    expect(f.root.tryRead(f.handle, [new Uint8Array(1)], 0)).toBe(-6);
    expect(f.root.tryWrite(f.handle, [new Uint8Array([7])], 0)).toBe(-6);
    await rejectsErrno(f.root.asyncCall("writeFile", ["/file"], new Uint8Array([9])), 6);
    expect(() => f.backend.shared.read(f.handle, [new Uint8Array(1)], 0)).toThrow();
  } finally {
    f.stop();
  }
});

test("reference cleanup cannot lend its access to a reentrant readiness probe", async () => {
  const f = await rootFixture();
  const shared = f.root.shared;
  shared.retain(f.handle);
  await f.root.asyncCall("publicationResident", [
    f.connection.client.publication!.observer,
    f.handle,
    "cleanup-probe",
  ]);
  f.service.residentPublication!.activate();
  const slot = shared.fileSlot(f.handle);
  const load = Atomics.load;
  const compareExchange = Atomics.compareExchange;
  let readiness: boolean | undefined;
  let inheritedFailure: unknown;
  try {
    Atomics.load = new Proxy(load, {
      apply(target, receiver, args) {
        Atomics.load = load;
        readiness = shared.directReadiness(
          slot,
          f.handle,
          false,
          () => false,
          f.root.connection.owner,
        );
        return Reflect.apply(target, receiver, args);
      },
    });
    Atomics.compareExchange = ((
      array: Int32Array,
      index: number,
      before: number,
      after: number,
    ) => {
      if (array !== shared.slots) return compareExchange(array, index, before, after);
      Atomics.compareExchange = compareExchange;
      try {
        shared.isResident(f.handle);
      } catch (error) {
        inheritedFailure = error;
      }
      return compareExchange(array, index, before, after);
    }) as typeof Atomics.compareExchange;
    shared.release(f.handle);
    expect(readiness).toBe(false);
    expect(inheritedFailure).toMatchObject({ errno: 6 });
  } finally {
    Atomics.load = load;
    Atomics.compareExchange = compareExchange;
    f.stop();
  }
});

function observeNextSlotLoad(shared: MemoryBackend["shared"], observe: () => void): () => void {
  const load = Atomics.load;
  Atomics.load = new Proxy(load, {
    apply(target, receiver, args) {
      if (args[0] !== shared.slots) return Reflect.apply(target, receiver, args);
      Atomics.load = load;
      observe();
      return Reflect.apply(target, receiver, args);
    },
  });
  return () => {
    Atomics.load = load;
  };
}

function readFailure(shared: MemoryBackend["shared"], handle: number, output: Uint8Array): unknown {
  try {
    shared.read(handle, [output], 0);
    return undefined;
  } catch (error) {
    return error;
  }
}

test("stopped authority reference cleanup denies reentrant reads of another resident file", async () => {
  const f = await rootFixture();
  f.backend.fs.writeFile("/other", new Uint8Array([4, 5, 6]));
  const directory: number = await f.root.asyncCall("preopen", ["/"]);
  const other: { node: number } = await f.root.asyncCall("resolve", [directory, "other"]);
  f.root.retain(other.node);
  await f.root.asyncCall("publicationResident", [
    f.connection.client.publication!.observer,
    f.handle,
    "stopped-cleanup-read",
  ]);
  const authority = f.service.residentPublication!;
  authority.activate();
  const output = new Uint8Array(3).fill(77);
  const release = f.backend.release.bind(f.backend);
  let failure: unknown;
  let completed = 0;
  f.backend.release = (handle) => {
    const restore = observeNextSlotLoad(f.backend.shared, () => {
      failure = readFailure(f.backend.shared, other.node, output);
    });
    try {
      release(handle);
      completed++;
    } finally {
      restore();
    }
  };
  try {
    expect(() => authority.dispose()).not.toThrow();
    expect(failure).toMatchObject({ errno: 11 });
    expect(Array.from(output)).toEqual([77, 77, 77]);
    expect(completed).toBe(1);
    authority.dispose();
    expect(completed).toBe(1);
  } finally {
    f.backend.release = release;
    f.stop();
  }
});

test("idle authority disposal permanently denies queued ordinary service work", async () => {
  const f = await residentFixture();
  try {
    const queued = f.root.asyncCall("writeFile", ["/file"], new Uint8Array([9]));
    f.authority.dispose();
    expect(f.backend.shared.publication!.stopped).toBe(true);
    await rejectsErrno(queued, 11);
    expect(f.root.tryRead(f.handle, [new Uint8Array(1)], 0)).toBe(-11);
  } finally {
    f.stop();
  }
});

test("failed disposal stays stopped and retries unfinished retained-description cleanup", async () => {
  const f = await residentFixture();
  const release = f.backend.release.bind(f.backend);
  let attempts = 0;
  f.backend.release = (handle) => {
    if (++attempts === 1) throw new Error("retained release failure");
    release(handle);
  };
  try {
    expect(() => f.authority.dispose()).toThrow("retained release failure");
    expect(f.backend.shared.publication!.stopped).toBe(true);
    expect(() => f.authority.activate()).toThrow();
    expect(() => f.authority.dispose()).not.toThrow();
    expect(attempts).toBe(2);
    f.authority.dispose();
    expect(attempts).toBe(2);
  } finally {
    f.backend.release = release;
    f.stop();
  }
});

function installConstructorHook(name: string, observe: () => void): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)!;
  const value = Reflect.get(globalThis, name);
  Object.defineProperty(globalThis, name, {
    ...descriptor,
    value: new Proxy(value, {
      construct(target, args) {
        observe();
        return Reflect.construct(target, args);
      },
    }),
  });
  return () => Object.defineProperty(globalThis, name, descriptor);
}

function installMethodHook(prototype: object, name: string, observe: () => void): () => void {
  const own = Object.getOwnPropertyDescriptor(prototype, name);
  const method = Reflect.get(prototype, name);
  const value = function (this: unknown, ...args: unknown[]) {
    observe();
    return Reflect.apply(method, this, args);
  };
  Object.defineProperty(
    prototype,
    name,
    own ? { ...own, value } : { configurable: true, writable: true, value },
  );
  return () => {
    if (own) Object.defineProperty(prototype, name, own);
    else Reflect.deleteProperty(prototype, name);
  };
}

function installClaimHooks(restorations: (() => void)[], observe: () => void): void {
  for (const name of ["Uint8Array", "Int32Array", "SharedArrayBuffer", "DataView"])
    restorations.push(installConstructorHook(name, observe));
  const methods: readonly [object, string][] = [
    [Uint8Array.prototype, "slice"],
    [Uint8Array.prototype, "subarray"],
    [Uint8Array.prototype, "set"],
    [DataView.prototype, "getUint32"],
    [DataView.prototype, "setUint32"],
    [TextEncoder.prototype, "encode"],
    [TextDecoder.prototype, "decode"],
  ];
  for (const [prototype, name] of methods)
    restorations.push(installMethodHook(prototype, name, observe));
}

function restoreClaimHooks(restorations: (() => void)[]): void {
  for (const restore of restorations.toReversed()) restore();
  restorations.length = 0;
}

test("claim constructors, copies and paired codec bypass late prototype hooks", async () => {
  const f = await residentFixture();
  const restorations: (() => void)[] = [];
  let intercepted = 0;
  try {
    const grant = f.authority.prepare(f.session, { kind: "write", offset: 0, maxBytes: 1 });
    const input = new Uint8Array([9]);
    installClaimHooks(restorations, () => intercepted++);
    const cell = new ResidentGrantCell(grant);
    const count = cell.tryWrite(f.handle, [input], 0);
    const outcome = cell.snapshot();
    restoreClaimHooks(restorations);
    expect(count).toBe(1);
    expect(outcome.kind).toBe("committed");
    expect(intercepted).toBe(0);
  } finally {
    restoreClaimHooks(restorations);
    f.stop();
  }
});


async function attemptOtherFileGrant(channel: ResidentChannel, token: string, handle: number) {
  let issued = false;
  let failure: unknown;
  try {
    const grant = residentGrant(await channel.call("prepare", {
      token, handle, request: { kind: "read", offset: 0, maxBytes: 1 },
    }));
    issued = true;
    const cell = new ResidentGrantCell(grant);
    cell.cancel();
    await channel.call("settle", { token, outcome: encodeResidentOutcome(cell.snapshot()) });
  } catch (error) {
    failure = error;
  }
  return { issued, failure };
}

test("file-only authority rejects another retained file handle without issuing a grant", async () => {
  const f = await rootFixture();
  await f.root.asyncCall("writeFile", ["/other"], new Uint8Array([9]));
  const directory: number = await f.root.asyncCall("preopen", ["/"]);
  const other: { node: number } = await f.root.asyncCall("resolve", [directory, "other"]);
  const descriptor = await f.root.asyncCall("publicationResident", [
    f.connection.client.publication!.observer, f.handle, `file-bound-${crypto.randomUUID()}`,
  ]);
  const authority = f.service.residentPublication!;
  authority.activate();
  const guard = { release: () => Promise.resolve() };
  const server = new ResidentAuthorityServer(authority, guard, guard);
  const channel = new ResidentChannel(authority.workspace);
  const session = residentSession(await channel.call("open", descriptor));
  const before = f.backend.shared.publication!.cut();
  try {
    const result = await attemptOtherFileGrant(channel, session.token, other.node);
    expect(result.failure).toMatchObject({ errno: 8 });
    expect(result.issued).toBe(false);
    expect(f.backend.shared.publication!.cut()).toEqual(before);
  } finally {
    await channel.call("close", { token: session.token });
    channel.close();
    await server.stop();
    f.stop();
  }
});
