import { expect, test } from "bun:test";
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

test("the production service issues a private retained resident descriptor", async () => {
  const backend = new MemoryBackend();
  backend.fs.writeFile("/file", new Uint8Array([1, 2, 3]));
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, { limits, observe: true });
  service.connect(connection.server);
  const root = new FilesystemClient(connection.client);
  try {
    const directory: number = await root.asyncCall("preopen", ["/"]);
    const path: { node: number } = await root.asyncCall("resolve", [directory, "file"]);
    root.retain(path.node);
    const before = await publicationObserver(root).cut();
    const descriptor: unknown = await root.asyncCall("publicationResident", [
      connection.client.publication!.observer,
      path.node,
      "resident-red-control",
    ]);
    expect(descriptor).toMatchObject({ workspace: "resident-red-control", handle: path.node });
    expect(await publicationObserver(root).cut()).toEqual(before);
  } finally {
    root.dispose();
    service.dispose();
  }
});

import { ResidentGrantCell, type ResidentDescriptor } from "../fs/publication-grant";

async function residentFixture(configuration = limits) {
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
  const descriptor: ResidentDescriptor = await root.asyncCall("publicationResident", [
    connection.client.publication!.observer,
    path.node,
    "resident-fixture",
  ]);
  const authority = service.residentPublication!;
  const session = authority.open(descriptor);
  return {
    backend,
    service,
    root,
    authority,
    session,
    handle: path.node,
    observer: publicationObserver(root),
    stop() {
      root.dispose();
      service.dispose();
    },
  };
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
    expect(f.root.tryRead(f.handle, [output], 0)).toBe(5);
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
    expect(f.root.tryRead(f.handle, [output], 0)).toBe(3);
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
    expect(f.root.tryRead(f.handle, [output], 0)).toBe(3);
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
    expect(f.root.tryRead(f.handle, [output], 0)).toBe(4);
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
    expect(f.root.tryRead(f.handle, [output], 0)).toBe(3);
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
  const load = Atomics.load, store = Atomics.store, compareExchange = Atomics.compareExchange;
  let intercepted = 0;
  try {
    const cell = new ResidentGrantCell(f.authority.prepare(f.session, { kind: "write", offset: 0, maxBytes: 1 }));
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
    Atomics.compareExchange = ((array: Int32Array, index: number, expected: number, replacement: number) => {
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
