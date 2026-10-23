import { expect, test } from "bun:test";
import { FilesystemClient, MemoryBackend, PersistentBackend } from "../fs";
import { Wasi } from "../core/wasi";
import { shareFileResource } from "../core/open-file";
import { guestModule, guestFunction } from "./fixtures/publication-wasm";
import { MemFS } from "../fs/memory";
import { PAGE } from "../fs/protocol";
import { ResidentGrantCell, type ResidentDescriptor } from "../fs/publication-grant";
import { RangeFixture, pattern } from "./fixtures/opfs-range-storage";
import { publicReadFixture, residentReadFixture } from "./fixtures/workspace-read";

async function coldFixture(size: number) {
  const physical = new RangeFixture();
  let value: ReturnType<typeof publicReadFixture> | undefined;
  const close = async () => {
    for (const gate of physical.gates) gate.resolve();
    await value?.close();
    await physical.cleanup();
  };
  try {
    await physical.seed([size]);
    const storage = await physical.open();
    const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
    value = publicReadFixture(backend);
    return { ...value, backend, closeProjection: value.close, storage, physical, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test("result reservations refuse a second large read independently of operation slots", async () => {
  const value = await coldFixture(1024 * 1024);
  const entered = Promise.withResolvers<void>(),
    gate = value.physical.gate();
  let first: Promise<unknown> | undefined;
  try {
    value.physical.file().snapshotRead = async () => {
      entered.resolve();
      await gate.promise;
    };
    first = value.workspace.read("/file");
    await entered.promise;
    expect(await value.workspace.read("/file")).toEqual({
      kind: "pressure",
      resource: "result-bytes",
    });
    expect(value.service.resources().readerOperations).toBe(1);
    expect(value.service.resources().readerResultBytes).toBe(8 * 1024 * 1024 + 12 * PAGE + 8192);
    gate.resolve();
    expect(await first).toMatchObject({ kind: "ok" });
    expect(value.service.resources().readerResultBytes).toBe(0);
    expect(value.service.resources().readerResultPeak).toBeLessThanOrEqual(16 * 1024 * 1024);
  } finally {
    gate.resolve();
    await first;
    await value.close();
  }
});

test("cold full-lease metadata refuses before lease slots and charges one physical key", async () => {
  const value = await coldFixture(512 * 1024 * 1024);
  const leases = [];
  try {
    for (let index = 0; index < 3; index++) {
      const opened = await value.workspace.pin("/file");
      expect(opened.kind).toBe("ok");
      if (opened.kind === "ok") leases.push(opened.value);
    }
    expect(await value.workspace.pin("/file")).toEqual({ kind: "pressure", resource: "metadata" });
    expect(value.service.resources().readerLeases).toBe(3);
    expect(value.storage.resources().readerStorageBytes).toBe(512 * 1024 * 1024);
    expect(value.physical.file().reads).toHaveLength(0);
    const peak = value.service.resources().readerMetadataPeak;
    await Promise.all(leases.map((lease) => lease.close()));
    expect(value.service.resources().readerLeases).toBe(0);
    expect(value.service.resources().readerMetadataBytes).toBe(65536 + 1280);
    expect(value.storage.resources().readerStorageBytes).toBe(0);
    expect(peak).toBeLessThanOrEqual(2 * 1024 * 1024);
  } finally {
    await value.close();
  }
});

test("retained storage refuses a complete key larger than its budget without native I/O", async () => {
  const value = await coldFixture(512 * 1024 * 1024 + 1);
  try {
    expect(await value.workspace.pin("/file")).toEqual({
      kind: "pressure",
      resource: "retained-storage",
    });
    expect(value.storage.resources().readerStorageBytes).toBe(0);
    expect(value.service.resources().readerLeases).toBe(0);
    expect(value.physical.file().reads).toHaveLength(0);
  } finally {
    await value.close();
  }
});

test("unique seed buffers share alias charges and independently exhaust pin capacity", async () => {
  const fs = new MemFS();
  for (const path of ["/one", "/two", "/three"])
    fs.writeFile(path, new Uint8Array(96 * 1024 * 1024));
  const value = publicReadFixture(new MemoryBackend(fs));
  try {
    const one = await value.workspace.pin("/one"),
      alias = await value.workspace.pin("/one"),
      two = await value.workspace.pin("/two");
    if (one.kind !== "ok" || alias.kind !== "ok" || two.kind !== "ok")
      throw new Error("seed pins failed");
    expect(value.service.resources().readerPinBytes).toBe(192 * 1024 * 1024);
    expect(await value.workspace.pin("/three")).toEqual({
      kind: "pressure",
      resource: "pin-bytes",
    });
    await one.value.close();
    expect(value.service.resources().readerPinBytes).toBe(192 * 1024 * 1024);
    await alias.value.close();
    const third = await value.workspace.pin("/three");
    expect(third.kind).toBe("ok");
    if (third.kind === "ok") await third.value.close();
    await two.value.close();
    expect(value.service.resources().readerPinBytes).toBe(0);
    expect(value.backend.shared.registeredHandles()).toHaveLength(0);
  } finally {
    await value.close();
  }
});

test("publication refusal rolls back growth and COW reservations before any effect", async () => {
  const value = await residentReadFixture(PAGE * 2, undefined, PAGE * 4);
  const domain = value.backend.shared.publication!;
  const original = domain.prepare;
  const refused = new Error("held publication capacity");
  try {
    const lease = await value.workspace.pin("/file");
    if (lease.kind !== "ok") throw new Error(lease.kind);
    const before = value.backend.shared.resources().usedBytes;
    const stat = value.backend.shared.stat(value.handle),
      identity = value.backend.identity(value.handle),
      cut = domain.cut();
    domain.prepare = () => {
      throw refused;
    };
    const failure = await value.client
      .asyncCall("writeFile", ["/file"], new Uint8Array(PAGE * 3 + 1).fill(90))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toMatchObject({ errno: 29 });
    expect(value.backend.shared.resources().usedBytes).toBe(before);
    expect(value.backend.shared.stat(value.handle)).toEqual(stat);
    expect(value.backend.identity(value.handle)).toEqual(identity);
    expect(domain.cut()).toEqual(cut);
    domain.prepare = original;
    await value.client.asyncCall("writeFile", ["/file"], new Uint8Array(PAGE * 3 + 1).fill(90));
    const old = await lease.value.read({ offset: PAGE, length: 1 });
    expect(old.kind).toBe("ok");
    if (old.kind === "ok") expect(old.value.bytes[0]).toBe(65);
    await lease.value.close();
  } finally {
    domain.prepare = original;
    await value.close();
  }
});

test("public selection excludes real pending resident grants and old leases survive committed import", async () => {
  const value = await residentReadFixture(PAGE * 3, undefined, PAGE * 4);
  try {
    const descriptor: ResidentDescriptor = await value.client.asyncCall("publicationResident", [
      value.client.connection.publication!.observer,
      value.handle,
      `public-read-${crypto.randomUUID()}`,
    ]);
    const authority = value.service.residentPublication!;
    authority.activate();
    const session = authority.open(descriptor);
    const opened = await value.workspace.pin("/file");
    if (opened.kind !== "ok") throw new Error(opened.kind);
    const cell = new ResidentGrantCell(
      authority.prepare(session, { kind: "write", offset: PAGE * 2, maxBytes: 1 }),
    );
    expect(cell.snapshot().kind).toBe("ready");
    expect(await value.workspace.read("/file", { offset: PAGE * 2, length: 1 })).toEqual({
      kind: "unavailable",
    });
    expect(cell.tryWrite(value.handle, [new Uint8Array([90])], PAGE * 2)).toBe(1);
    expect(cell.snapshot().kind).toBe("committed");
    expect(await value.workspace.stat("/file")).toEqual({ kind: "unavailable" });
    expect(authority.settle(session, cell.snapshot()).kind).toBe("committed");
    const current = await value.workspace.read("/file", { offset: PAGE * 2, length: 1 }),
      old = await opened.value.read({ offset: PAGE * 2, length: 1 });
    expect(current.kind).toBe("ok");
    expect(old.kind).toBe("ok");
    if (current.kind === "ok" && old.kind === "ok") {
      expect(current.value.bytes[0]).toBe(90);
      expect(old.value.bytes[0]).toBe(65);
      expect(current.value.stat.id).toBe(old.value.stat.id);
      expect(current.value.stat.version).not.toBe(old.value.stat.version);
    }
    await opened.value.close();
    authority.close(session);
  } finally {
    value.service.residentPublication?.dispose();
    await value.close();
  }
});

type Writer =
  | "fd_write"
  | "fd_pwrite"
  | "direct-write"
  | "direct-append"
  | "write"
  | "append"
  | "writeFile"
  | "shrink"
  | "extend"
  | "move"
  | "unlink-final"
  | "hardlink"
  | "replacement";
type WriterRoot = Pick<ReturnType<typeof publicReadFixture>, "client" | "backend">;
async function actualWriter(kind: Writer, value: WriterRoot, handle: number): Promise<void> {
  if (kind === "write") {
    await value.client.asyncCall("write", [handle, PAGE], new Uint8Array([90]));
    return;
  }
  if (kind === "append") {
    await value.client.asyncCall("append", [handle], new Uint8Array([90]));
    return;
  }
  if (kind === "writeFile") {
    await value.client.asyncCall("writeFile", ["/file"], new Uint8Array([90]));
    return;
  }
  if (kind === "shrink" || kind === "extend") {
    await value.client.asyncCall("resize", [handle, kind === "shrink" ? 1 : PAGE * 4, true]);
    return;
  }
  if (kind === "move") {
    await value.client.asyncCall("move", ["/file", "/renamed"]);
    return;
  }
  if (kind === "hardlink") {
    const root = await value.client.asyncCall("preopen", ["/"]);
    const source: unknown = await value.client.asyncCall("resolve", [root, "file"]);
    const target: unknown = await value.client.asyncCall("resolve", [root, "alias"]);
    await value.client.asyncCall("link", [source, target]);
    return;
  }
  if (kind === "replacement") {
    await value.client.asyncCall("writeFile", ["/replacement"], new Uint8Array([90]));
    await value.client.asyncCall("move", ["/replacement", "/file"]);
    return;
  }
  if (kind === "unlink-final") {
    await value.client.asyncCall("remove", ["/file"]);
    value.client.release(handle);
    await value.client.asyncCall("writeFile", ["/replacement"], new Uint8Array([90]));
    return;
  }
  await value.client.asyncCall("read", [handle, 1, 0]);
  const peer = new FilesystemClient(value.client.fork());
  try {
    const directory = await peer.asyncCall("preopen", ["/"]);
    const node = (await peer.asyncCall("resolve", [directory, "file"])).node;
    peer.retain(node);
    if (kind === "direct-write") {
      expect(peer.tryWrite(node, [new Uint8Array([90])], PAGE)).toBe(1);
      return;
    }
    if (kind === "direct-append") {
      expect(peer.tryAppend(node, [new Uint8Array([90])])).toMatchObject({ written: 1 });
      return;
    }
    await actualWasiWrite(kind, peer, node);
  } finally {
    peer.dispose();
  }
}
async function actualWasiWrite(
  kind: "fd_write" | "fd_pwrite",
  client: FilesystemClient,
  handle: number,
): Promise<void> {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const wasi = new Wasi({
    fs: client,
    args: [],
    env: {},
    preopens: {},
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {
      throw new Error("writer must not wait");
    },
  });
  try {
    const resource = { kind: "file", handle, offset: PAGE, append: false } as const;
    shareFileResource(resource, client.connection);
    const parameters =
      kind === "fd_write"
        ? (["i32", "i32", "i32", "i32"] as const)
        : (["i32", "i32", "i32", "i64", "i32"] as const);
    const module = guestModule("wasi_snapshot_preview1", [{ name: kind, parameters }]);
    const instance = new WebAssembly.Instance(module, { ...wasi.imports(module), env: { memory } });
    wasi.start(instance);
    const fd = wasi.descriptors.open(resource, (1n << 6n) | (1n << 2n), 0n);
    const view = new DataView(memory.buffer);
    view.setUint32(0, 32, true);
    view.setUint32(4, 1, true);
    new Uint8Array(memory.buffer)[32] = 90;
    const call = guestFunction(instance, kind);
    expect(kind === "fd_write" ? call(fd, 0, 1, 16) : call(fd, 0, 1, BigInt(PAGE), 16)).toBe(0);
  } finally {
    wasi.descriptors.dispose();
  }
}

for (const writer of [
  "fd_write",
  "fd_pwrite",
  "direct-write",
  "direct-append",
  "extend",
  "hardlink",
  "replacement",
  "unlink-final",
] satisfies Writer[]) {
  test(`held cold public I/O does not block ${writer} or relabel selected bytes`, async () => {
    const value = await coldFixture(PAGE * 3 - 1);
    const entered = Promise.withResolvers<void>(),
      gate = value.physical.gate();
    let reading: ReturnType<typeof value.workspace.read> | undefined;
    try {
      const stat = await value.workspace.stat("/file");
      if (stat.kind !== "ok") throw new Error(stat.kind);
      value.physical.file().snapshotRead = async () => {
        entered.resolve();
        await gate.promise;
      };
      reading = value.workspace.read("/file", { offset: PAGE - 3, length: 4096 });
      await entered.promise;
      const root = await value.client.asyncCall("preopen", ["/"]);
      const handle = (await value.client.asyncCall("resolve", [root, "file"])).node;
      value.client.retain(handle);
      await actualWriter(writer, value, handle);
      expect(value.storage.resources().opfsReaderWork).toBe(1);
      gate.resolve();
      const old = await reading;
      expect(old.kind).toBe("ok");
      if (old.kind === "ok") {
        expect(old.value.stat).toEqual(stat.value);
        expect(old.value.bytes).toEqual(
          Uint8Array.from({ length: 4096 }, (_, index) => pattern(PAGE - 3 + index)),
        );
      }
    } finally {
      gate.resolve();
      await reading;
      await value.close();
    }
  });
}
for (const writer of [
  "write",
  "append",
  "writeFile",
  "shrink",
  "extend",
  "fd_write",
  "fd_pwrite",
  "direct-write",
  "direct-append",
  "move",
  "unlink-final",
  "hardlink",
  "replacement",
] satisfies Writer[]) {
  test(`held resident public chunk delivery preserves all pages across ${writer}`, async () => {
    const value = await residentReadFixture(PAGE * 3 - 1);
    const entered = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>();
    const submit = value.client.submit;
    let held = false;
    let reading: ReturnType<typeof value.workspace.read> | undefined;
    try {
      const before = await value.workspace.stat("/file");
      if (before.kind !== "ok") throw new Error(before.kind);
      value.client.submit = function (...args) {
        const completion = submit.apply(this, args);
        if (args[0] !== "publicationReadChunk" || held) return completion;
        held = true;
        const result = completion.value.bind(completion);
        completion.value = async () => {
          const bytes: unknown = await result();
          entered.resolve();
          await gate.promise;
          return bytes;
        };
        return completion;
      };
      reading = value.workspace.read("/file", { offset: 0, length: PAGE * 3 });
      await entered.promise;
      await actualWriter(writer, value, value.handle);
      expect(value.service.resources().readerTickets).toBe(1);
      expect(value.service.resources().readerPinBytes).toBe(PAGE * 3);
      gate.resolve();
      const old = await reading;
      expect(old.kind).toBe("ok");
      if (old.kind === "ok") {
        expect(old.value.stat).toEqual(before.value);
        expect(old.value.bytes).toEqual(new Uint8Array(PAGE * 3 - 1).fill(65));
      }
      expect(value.service.resources().readerPinBytes).toBe(0);
      expect(value.service.resources().readerTickets).toBe(0);
    } finally {
      gate.resolve();
      value.client.submit = submit;
      await reading;
      await value.close();
    }
  });
}

test("public selection refuses an actually CLAIMED resident writer before authority import", async () => {
  const value = await residentReadFixture(PAGE, undefined, PAGE * 2);
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const claimed = Promise.withResolvers<void>(),
    done = Promise.withResolvers<void>();
  let worker: Worker | undefined;
  try {
    const descriptor: ResidentDescriptor = await value.client.asyncCall("publicationResident", [
      value.client.connection.publication!.observer,
      value.handle,
      `public-claim-${crypto.randomUUID()}`,
    ]);
    const authority = value.service.residentPublication!;
    authority.activate();
    const session = authority.open(descriptor);
    const opened = await value.workspace.pin("/file");
    if (opened.kind !== "ok") throw new Error(opened.kind);
    const grant = authority.prepare(session, { kind: "write", offset: 0, maxBytes: 1 });
    const cell = new ResidentGrantCell(grant);
    worker = new Worker(new URL("./fixtures/workspace-read-claim.ts", import.meta.url).href);
    worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (!data || typeof data !== "object" || !("kind" in data)) return;
      if (data.kind === "claimed") claimed.resolve();
      else if (data.kind === "done") done.resolve();
      else {
        const error = new Error(JSON.stringify(data));
        claimed.reject(error);
        done.reject(error);
      }
    };
    worker.onerror = (event) => {
      claimed.reject(event.error);
      done.reject(event.error);
    };
    worker.postMessage({
      grant,
      storage: { state: cell.state.buffer, payload: cell.payload.buffer },
      gate: gate.buffer,
    });
    await claimed.promise;
    expect(cell.snapshot().kind).toBe("claimed");
    expect(await value.workspace.read("/file", { offset: 0, length: 1 })).toEqual({
      kind: "unavailable",
    });
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    await done.promise;
    expect(cell.snapshot().kind).toBe("committed");
    expect(authority.settle(session, cell.snapshot()).kind).toBe("committed");
    const old = await opened.value.read({ offset: 0, length: 1 });
    expect(old.kind).toBe("ok");
    if (old.kind === "ok") expect(old.value.bytes[0]).toBe(65);
    await opened.value.close();
    authority.close(session);
  } finally {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    worker?.terminate();
    value.service.residentPublication?.dispose();
    await value.close();
  }
});

test("a missing current pathname stays not-found even with an explicitly leased old version", async () => {
  const value = await residentReadFixture(PAGE);
  try {
    const opened = await value.workspace.pin("/file");
    if (opened.kind !== "ok") throw new Error(opened.kind);
    await value.client.asyncCall("move", ["/file", "/renamed"]);
    expect(
      await value.workspace.read("/file", { offset: 0, length: 1 }, opened.value.stat.version),
    ).toEqual({ kind: "not-found" });
    expect(
      (
        await value.workspace.read(
          opened.value.stat.id,
          { offset: 0, length: 1 },
          opened.value.stat.version,
        )
      ).kind,
    ).toBe("ok");
    await opened.value.close();
  } finally {
    await value.close();
  }
});

test("generation stat distinguishes retained IDs, old paths, foreign cuts, future cuts and reopen history", async () => {
  const value = await coldFixture(PAGE * 3);
  let reopened: ReturnType<typeof publicReadFixture> | undefined;
  try {
    const held = await value.workspace.pin("/file");
    if (held.kind !== "ok") throw new Error(held.kind);
    const stat = held.value.stat;
    const foreign = await residentReadFixture(1);
    try {
      const other = await foreign.workspace.stat("/file");
      if (other.kind !== "ok") throw new Error(other.kind);
      expect((await value.workspace.stat(stat.id, other.value.cut)).kind).toBe("generation-gone");
    } finally {
      await foreign.close();
    }
    const future = {
      ...stat.cut,
      generation: stat.cut.generation + 1n,
      watermark: { ...stat.cut.watermark, seq: stat.cut.watermark.seq + 1n },
    };
    const grant = value.client.connection.publication!.observer;
    expect(
      (
        await value.client.asyncCall("publicationReadStat", [
          grant,
          100,
          stat.id,
          undefined,
          undefined,
          future,
        ])
      ).kind,
    ).toBe("generation-gone");
    await value.client.asyncCall("move", ["/file", "/renamed"]);
    expect(await value.workspace.stat(stat.id, stat.cut)).toEqual({ kind: "ok", value: stat });
    expect((await value.workspace.stat("/file", stat.cut)).kind).toBe("generation-gone");
    await held.value.close();
    expect((await value.workspace.stat(stat.id, stat.cut)).kind).toBe("generation-gone");
    await value.backend.flush();
    const before = await value.workspace.stat(stat.id);
    if (before.kind !== "ok") throw new Error(before.kind);
    await value.closeProjection();
    const storage = await value.physical.open();
    reopened = publicReadFixture(await PersistentBackend.open(storage, { intervalMs: 0 }));
    const after = await reopened.workspace.stat("/renamed");
    expect(after.kind).toBe("ok");
    if (after.kind === "ok") {
      expect(after.value.id).toBe(before.value.id);
      expect(after.value.version).toBe(before.value.version);
      expect(after.value.cut.watermark.history).not.toBe(before.value.cut.watermark.history);
    }
    expect((await reopened.workspace.stat(before.value.id, before.value.cut)).kind).toBe(
      "generation-gone",
    );
    expect(await held.value.read({ offset: 0, length: 1 })).toEqual({ kind: "stopped" });
  } finally {
    await reopened?.close();
    await value.close();
  }
});

test("closing a cold lease joins an active native borrow and preserves debt until it settles", async () => {
  const value = await coldFixture(PAGE * 3);
  const entered = Promise.withResolvers<void>(),
    gate = value.physical.gate();
  let reading: ReturnType<typeof value.workspace.read> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const opened = await value.workspace.pin("/file");
    if (opened.kind !== "ok") throw new Error(opened.kind);
    value.physical.file().snapshotRead = async () => {
      entered.resolve();
      await gate.promise;
    };
    reading = opened.value.read({ offset: 0, length: PAGE });
    await entered.promise;
    let settled = false;
    closing = opened.value.close().then(() => {
      settled = true;
    });
    expect(opened.value.close()).not.toBeUndefined();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(value.storage.resources().opfsReaderWork).toBe(1);
    expect(value.storage.resources().readerStorageBytes).toBe(PAGE * 3);
    expect(await opened.value.read()).toEqual({ kind: "lease-closed" });
    gate.resolve();
    expect(await reading).toEqual({ kind: "cancelled" });
    await closing;
    expect(value.storage.resources().opfsReaderWork).toBe(0);
    expect(value.storage.resources().readerStorageBytes).toBe(0);
    expect(value.service.resources().readerLeases).toBe(0);
  } finally {
    gate.resolve();
    await reading;
    await closing;
    await value.close();
  }
});

for (const after of ["open", "chunk"] as const) {
  test(`abort after real ${after} completion before delivery cannot resurrect a reader`, async () => {
    const value = await residentReadFixture(PAGE * 3);
    const submit = value.client.submit;
    const entered = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>();
    const controller = new AbortController();
    let held = false;
    let reading: ReturnType<typeof value.workspace.read> | undefined;
    try {
      value.client.submit = function (...args) {
        const completion = submit.apply(this, args);
        if (held || args[0] !== (after === "open" ? "publicationReadOpen" : "publicationReadChunk"))
          return completion;
        held = true;
        const original = completion.value.bind(completion);
        completion.value = async () => {
          const result: unknown = await original();
          entered.resolve();
          await gate.promise;
          return result;
        };
        return completion;
      };
      reading = value.workspace.read(
        "/file",
        { offset: 0, length: PAGE * 3 },
        undefined,
        controller.signal,
      );
      await entered.promise;
      expect(value.service.resources().readerTickets).toBe(1);
      controller.abort();
      gate.resolve();
      expect(await reading).toEqual({ kind: "cancelled" });
      expect(value.service.resources().readerTickets).toBe(0);
      expect(value.service.resources().readerPinBytes).toBe(0);
      expect(value.service.resources().readerResultBytes).toBe(0);
      expect(value.service.resources().readerOperations).toBe(0);
    } finally {
      gate.resolve();
      value.client.submit = submit;
      await reading;
      await value.close();
    }
  });
}

test("reopened normal recovery roots do not become reader-only debt on token release", async () => {
  const physical = new RangeFixture();
  try {
    await physical.seed([PAGE]);
    const storage = await physical.open();
    await storage.load();
    const token = storage.retainPayload("revision:0", PAGE);
    expect(storage.resources().readerStorageBytes).toBe(PAGE);
    token.release();
    expect(storage.resources().readerStorageDebt).toBe(0);
    expect(storage.resources().readerStorageBytes).toBe(0);
  } finally {
    await physical.cleanup();
  }
});
