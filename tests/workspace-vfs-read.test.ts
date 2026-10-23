import { expect, test } from "bun:test";
import { FilesystemClient } from "../fs";
import { PAGE, createFilesystemIdentity } from "../fs/protocol";
import { workspacePublication } from "../fs/workspace-protocol";
import { Wasi } from "../core/wasi";
import { shareFileResource } from "../core/open-file";
import { guestModule, guestFunction } from "./fixtures/publication-wasm";
import { MemoryBackend, PersistentBackend } from "../fs";
import { MemFS } from "../fs/memory";
import { RangeFixture, pattern, payloadSize } from "./fixtures/opfs-range-storage";
import { publicReadFixture } from "./fixtures/workspace-read";
import { residentReadFixture } from "./fixtures/workspace-read";

for (const kind of [
  "service-write",
  "service-append",
  "writeFile",
  "resize",
  "direct-write",
  "direct-append",
] as const) {
  test(`retained complete backing survives actual ${kind}`, async () => {
    const value = await residentReadFixture(PAGE * 3 + 3);
    try {
      const before = value.backend.shared.resources().usedBytes;
      const pin = value.pin();
      expect(value.backend.shared.resources().usedBytes).toBe(before);
      await mutate(kind, value);
      expect(pin.read(PAGE * 2 + 1, 2)).toEqual(new Uint8Array(2).fill(65));
      expect(pin.read(0, 3)).toEqual(new Uint8Array(3).fill(65));
    } finally {
      await value.close();
    }
  });
}

type Fixture = Awaited<ReturnType<typeof residentReadFixture>>;
async function mutate(kind: string, value: Fixture) {
  const bytes = new Uint8Array(3).fill(90);
  if (kind === "service-write") return value.client.asyncCall("write", [value.handle, 0], bytes);
  if (kind === "service-append") return value.client.asyncCall("append", [value.handle], bytes);
  if (kind === "writeFile") return value.client.asyncCall("writeFile", ["/file"], bytes);
  if (kind === "resize") return value.client.asyncCall("resize", [value.handle, 1, true]);
  const sibling = new FilesystemClient(value.client.fork());
  try {
    const root = await sibling.asyncCall("preopen", ["/"]);
    const handle = (await sibling.asyncCall("resolve", [root, "file"])).node;
    sibling.retain(handle);
    if (kind === "direct-write") return sibling.tryWrite(handle, [bytes], 0);
    return sibling.tryAppend(handle, [bytes]);
  } finally {
    sibling.dispose();
  }
}

for (const operation of ["fd_write", "fd_pwrite"] as const) {
  test(`retained complete backing survives real WASI ${operation}`, async () => {
    const value = await residentReadFixture(PAGE * 3 + 3);
    const guest = new FilesystemClient(value.client.fork());
    const memory = new WebAssembly.Memory({ initial: 4 });
    const wasi = new Wasi({
      fs: guest,
      args: [],
      env: {},
      preopens: {},
      namespaces: { env: { memory } },
      stdout() {},
      stderr() {},
      sleep() {
        throw new Error("guest must not wait");
      },
    });
    try {
      const root = await guest.asyncCall("preopen", ["/"]);
      const handle = (await guest.asyncCall("resolve", [root, "file"])).node;
      guest.retain(handle);
      const resource = { kind: "file", handle, offset: 0, append: false } as const;
      shareFileResource(resource, guest.connection);
      const parameters =
        operation === "fd_write"
          ? (["i32", "i32", "i32", "i32"] as const)
          : (["i32", "i32", "i32", "i64", "i32"] as const);
      const module = guestModule("wasi_snapshot_preview1", [{ name: operation, parameters }]);
      const instance = new WebAssembly.Instance(module, {
        ...wasi.imports(module),
        env: { memory },
      });
      wasi.start(instance);
      const fd = wasi.descriptors.open(resource, (1n << 6n) | (1n << 2n), 0n);
      const pin = value.pin();
      const view = new DataView(memory.buffer);
      view.setUint32(0, 32, true);
      view.setUint32(4, 1, true);
      new Uint8Array(memory.buffer)[32] = 90;
      const call = guestFunction(instance, operation);
      expect(operation === "fd_write" ? call(fd, 0, 1, 16) : call(fd, 0, 1, 0n, 16)).toBe(0);
      expect(pin.read(0, 1)).toEqual(new Uint8Array([65]));
    } finally {
      wasi.descriptors.dispose();
      guest.dispose();
      await value.close();
    }
  });
}

test("retained pages survive unlink, final descriptor release and new slot allocation", async () => {
  const value = await residentReadFixture(PAGE * 3 + 3);
  try {
    const pin = value.pin();
    await value.client.asyncCall("remove", ["/file"]);
    value.client.release(value.handle);
    await value.client.asyncCall("writeFile", ["/replacement"], new Uint8Array(PAGE).fill(90));
    expect(pin.read(PAGE * 2 + 1, 2)).toEqual(new Uint8Array(2).fill(65));
  } finally {
    await value.close();
  }
});

test("only public roots allocate page-reader counters, fork shares without observer grant", () => {
  const privateRoot = createFilesystemIdentity(undefined, undefined, {
    limits: workspacePublication.limits,
  });
  const publicRoot = createFilesystemIdentity(undefined, undefined, { workspace: true });
  const fork = createFilesystemIdentity(publicRoot);
  expect(privateRoot.publication!.buffers.pageReaders).toBeUndefined();
  expect(publicRoot.publication!.buffers.pageReaders!.byteLength).toBe(65536);
  expect(fork.publication!.buffers.pageReaders).toBe(publicRoot.publication!.buffers.pageReaders);
  expect(fork.publication!.observer).toBeUndefined();
});

for (const operation of ["direct-iovec", "writeFile", "resize"] as const) {
  test(`COW pressure refuses all effects of actual ${operation}`, async () => {
    const value = await residentReadFixture(16 * 1024 * 1024, 16 * 1024 * 1024);
    try {
      const pin = value.pin();
      const before = value.backend.shared.stat(value.handle);
      const identity = value.backend.identity(value.handle);
      const cut = value.backend.shared.publication!.cut();
      const used = value.backend.shared.resources().usedBytes;
      const writing = () =>
        operation === "direct-iovec"
          ? Promise.resolve().then(() =>
              value.client.tryWrite(
                value.handle,
                [new Uint8Array([90]), new Uint8Array([91])],
                PAGE - 1,
              ),
            )
          : operation === "writeFile"
            ? value.client.asyncCall("writeFile", ["/file"], new Uint8Array([90, 91]))
            : value.client.asyncCall("resize", [value.handle, 1, true]);
      if (operation === "direct-iovec") expect(await writing()).toBe(-6);
      else {
        const error = await writing().then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(error).toMatchObject({ errno: 6 });
      }
      expect(value.backend.shared.stat(value.handle)).toEqual(before);
      expect(value.backend.identity(value.handle)).toEqual(identity);
      expect(value.backend.shared.publication!.cut()).toEqual(cut);
      expect(value.backend.shared.publication!.stopped).toBe(false);
      expect(value.backend.shared.resources().usedBytes).toBe(used);
      expect(pin.read(PAGE - 1, 2)).toEqual(new Uint8Array([65, 65]));
      pin.release();
      await writing();
    } finally {
      await value.close();
    }
  });
}

test("retired pages stay physically charged until final reader release", async () => {
  const value = await residentReadFixture(PAGE * 2);
  try {
    const before = value.backend.shared.resources().usedBytes;
    const first = value.pin(),
      second = value.pin();
    const empty = value.pin(1, 0);
    empty.release();
    await value.client.asyncCall("write", [value.handle, 0], new Uint8Array([90]));
    expect(value.backend.shared.resources().usedBytes).toBe(before + PAGE);
    first.release();
    expect(value.backend.shared.resources().usedBytes).toBe(before + PAGE);
    second.release();
    expect(value.backend.shared.resources().usedBytes).toBe(before);
  } finally {
    await value.close();
  }
});

test("public current path and ID reads work before any snapshot", async () => {
  const value = await residentReadFixture(PAGE * 3 + 3);
  try {
    const first = await value.workspace.read("/file", { offset: PAGE - 1, length: 4096 });
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") throw new Error(JSON.stringify(first));
    expect(first.value.bytes).toEqual(new Uint8Array(4096).fill(65));
    expect(first.value.stat.id).toBe(value.backend.identity(value.handle).id);
    expect((await value.workspace.read(first.value.stat.id, { offset: 0, length: 3 })).kind).toBe(
      "ok",
    );
    const pinned = await value.workspace.pin("/file");
    if (pinned.kind !== "ok") throw new Error(JSON.stringify(pinned));
    await value.client.asyncCall("writeFile", ["/file"], new Uint8Array([90]));
    const old = await pinned.value.read({ offset: PAGE * 2 + 1, length: 2 });
    expect(old.kind).toBe("ok");
    if (old.kind === "ok") expect(old.value.bytes).toEqual(new Uint8Array([65, 65]));
    expect(await value.workspace.stat(pinned.value.stat.id, pinned.value.stat.cut)).toEqual({
      kind: "ok",
      value: pinned.value.stat,
    });
    await pinned.value.close();
    expect((await pinned.value.read()).kind).toBe("lease-closed");
    expect(
      (
        await value.workspace.read(
          first.value.stat.id,
          { offset: 0, length: 1 },
          first.value.stat.version,
        )
      ).kind,
    ).toBe("version-gone");
  } finally {
    await value.close();
  }
});

test("an old version resolves a current path only to the same inode", async () => {
  const value = await residentReadFixture(PAGE * 3);
  try {
    const held = await value.workspace.pin("/file");
    if (held.kind !== "ok") throw new Error(held.kind);
    await value.client.asyncCall("write", [value.handle, 0], new Uint8Array([90]));
    const read = await value.workspace.read(
      "/file",
      { offset: 0, length: 1 },
      held.value.stat.version,
    );
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") expect(read.value.bytes[0]).toBe(65);
    await value.client.asyncCall("remove", ["/file"]);
    await value.client.asyncCall("writeFile", ["/file"], new Uint8Array([91]));
    expect(
      (await value.workspace.read("/file", { offset: 0, length: 1 }, held.value.stat.version)).kind,
    ).toBe("version-gone");
    await held.value.close();
  } finally {
    await value.close();
  }
});

test("closing one duplicate lease leaves the other lease readable", async () => {
  const value = await residentReadFixture(PAGE * 3);
  try {
    const first = await value.workspace.pin("/file");
    if (first.kind !== "ok") throw new Error(first.kind);
    await value.client.asyncCall("write", [value.handle, 0], new Uint8Array([90]));
    const second = await value.workspace.pin(first.value.stat.id, first.value.stat.version);
    if (second.kind !== "ok") throw new Error(second.kind);
    await first.value.close();
    const read = await second.value.read({ offset: PAGE * 2, length: 1 });
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") expect(read.value.bytes[0]).toBe(65);
    await second.value.close();
  } finally {
    await value.close();
  }
});

for (const kind of [
  "service-write",
  "service-append",
  "writeFile",
  "resize",
  "direct-write",
  "direct-append",
]) {
  test(`public full lease preserves untouched distant bytes across ${kind}`, async () => {
    const value = await residentReadFixture(PAGE * 3 + 3);
    try {
      const opened = await value.workspace.pin("/file");
      if (opened.kind !== "ok") throw new Error(opened.kind);
      await mutate(kind, value);
      const distant = await opened.value.read({ offset: PAGE * 2 + 1, length: 2 });
      expect(distant.kind).toBe("ok");
      if (distant.kind === "ok") {
        expect(distant.value.bytes).toEqual(new Uint8Array([65, 65]));
        expect(distant.value.stat).toEqual(opened.value.stat);
      }
      await opened.value.close();
      expect(value.service.resources().readerPinBytes).toBe(0);
      expect(value.service.resources().readerLeases).toBe(0);
      expect(value.service.resources().readerResultBytes).toBe(0);
    } finally {
      await value.close();
    }
  });
}

for (const size of [0, 1, PAGE - 1, PAGE, PAGE + 1]) {
  test(`public EOF is exact for ${size} bytes`, async () => {
    const value = await residentReadFixture(size);
    try {
      for (const range of [
        { offset: 0, length: 0 },
        { offset: size, length: 7 },
        { offset: size + 1, length: 7 },
        { offset: Math.max(0, size - 1), length: 7 },
        { offset: Number.MAX_SAFE_INTEGER, length: 0 },
      ]) {
        const read = await value.workspace.read("/file", range);
        expect(read.kind).toBe("ok");
        if (read.kind !== "ok") continue;
        const count = Math.min(range.length, Math.max(0, size - range.offset));
        expect(read.value.bytes.length).toBe(count);
        expect(read.value.range).toEqual({ offset: range.offset, length: count });
      }
      for (const member of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
        for (const range of [
          { offset: member, length: 1 },
          { offset: 0, length: member },
        ])
          expect(
            await Reflect.apply(value.workspace.read, value.workspace, ["/file", range]),
          ).toEqual({ kind: "invalid", field: "range" });
      }
      expect(
        await value.workspace.read("/file", { offset: Number.MAX_SAFE_INTEGER, length: 1 }),
      ).toEqual({ kind: "invalid", field: "range" });
      expect(value.service.resources().readerTickets).toBe(0);
    } finally {
      await value.close();
    }
  });
}

test("public cold unaligned 4KiB ranges do bounded physical I/O of 128MiB without hydration", async () => {
  const physical = new RangeFixture();
  let value: ReturnType<typeof publicReadFixture> | undefined;
  try {
    await physical.seed();
    const storage = await physical.open();
    const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
    value = publicReadFixture(backend);
    const before = backend.shared.resources().usedBytes;
    const accesses = physical.file().accesses.length;
    for (const offset of [65539, PAGE - 3, payloadSize - 4096]) {
      const read = await value.workspace.read("/file", { offset, length: 4096 });
      expect(read.kind).toBe("ok");
      if (read.kind !== "ok") throw new Error(JSON.stringify(read));
      expect(read.value.bytes).toEqual(
        Uint8Array.from({ length: 4096 }, (_, index) => pattern(offset + index)),
      );
      expect(backend.shared.resources().usedBytes).toBe(before);
      expect(backend.shared.registeredHandles()).toHaveLength(0);
    }
    expect(physical.file().reads.map((read) => read.length)).toEqual([4096, 4096, 4096]);
    expect(physical.file().reads.map((read) => read.buffer.byteLength)).toEqual([4096, 4096, 4096]);
    expect(physical.file().accesses).toHaveLength(accesses);
    const lease = await value.workspace.pin("/file");
    if (lease.kind !== "ok") throw new Error(JSON.stringify(lease));
    expect(lease.value.stat.size).toBe(payloadSize);
    expect((await lease.value.read({ offset: payloadSize - 1, length: 1 })).kind).toBe("ok");
    await lease.value.close();
    expect(storage.resources().readerStorageBytes).toBe(0);
  } finally {
    await value?.close();
    await physical.cleanup();
  }
});

test("tiny unregistered seed range never registers or retains the complete 128MiB buffer", async () => {
  const fs = new MemFS();
  fs.writeFile("/file", new Uint8Array(payloadSize).fill(65));
  const value = publicReadFixture(new MemoryBackend(fs));
  try {
    const before = value.backend.shared.resources().usedBytes;
    const read = await value.workspace.read("/file", { offset: PAGE - 1, length: 4096 });
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") expect(read.value.bytes).toEqual(new Uint8Array(4096).fill(65));
    expect(value.backend.shared.resources().usedBytes).toBe(before);
    expect(value.backend.shared.registeredHandles()).toHaveLength(0);
    expect(value.service.resources().readerSeedBytes).toBe(0);
    expect(value.service.resources().readerMetadataPeak).toBeLessThan(
      65536 + 256 + 128 * 64 + 2 * 64 + 256 + 256 + 4096,
    );
    expect(await value.workspace.read("/file")).toEqual({
      kind: "pressure",
      resource: "result-bytes",
    });
  } finally {
    await value.close();
  }
});

test("root close joins all sixteen public leases without exhausting control completions", async () => {
  const value = await residentReadFixture(PAGE);
  try {
    const leases = [];
    for (let index = 0; index < 16; index++) {
      const held = await value.workspace.pin("/file");
      if (held.kind !== "ok") throw new Error(held.kind);
      leases.push(held.value);
    }
    expect(await value.workspace.pin("/file")).toEqual({ kind: "pressure", resource: "leases" });
    await value.workspace.close();
    expect(value.service.resources().readerLeases).toBe(0);
    expect(value.service.resources().readerPinBytes).toBe(0);
    expect(value.client.completions.size).toBe(0);
    for (const lease of leases) expect(await lease.read()).toEqual({ kind: "stopped" });
  } finally {
    await value.close();
  }
});

test("public path traversal consults actual shared parent permission before dot cancellation", async () => {
  const fs = new MemFS();
  fs.writeFile("/locked/file", new Uint8Array([65]));
  const value = publicReadFixture(new MemoryBackend(fs));
  try {
    const root = await value.client.asyncCall("preopen", ["/"]);
    const directory = (await value.client.asyncCall("resolve", [root, "locked"])).node;
    value.client.retain(directory);
    value.backend.shared.mutate(undefined, undefined, () =>
      value.backend.shared.setMode(directory, 0o600),
    );
    expect(await value.workspace.read("/locked/file")).toEqual({ kind: "denied" });
    expect(await value.workspace.read("/locked/../locked/file")).toEqual({ kind: "denied" });
    expect(await value.workspace.read("/missing/../locked/file")).toEqual({ kind: "not-found" });
  } finally {
    await value.close();
  }
});

test("close before delayed open cannot create a ticket, and repeated closes remain bounded", async () => {
  const value = await residentReadFixture(PAGE);
  const grant = value.client.connection.publication!.observer;
  try {
    await value.client.asyncCall("publicationReadClose", [grant, 100]);
    expect(
      await value.client.asyncCall("publicationReadOpen", [
        grant,
        100,
        "/file",
        { offset: 0, length: 1 },
      ]),
    ).toEqual({ kind: "cancelled" });
    for (let id = 101; id < 201; id++)
      await value.client.asyncCall("publicationReadClose", [grant, id]);
    expect(value.service.resources().readerTickets).toBe(0);
    expect(value.service.resources().readerMetadataBytes).toBe(65536);
  } finally {
    await value.close();
  }
});

for (const writer of ["write", "append", "writeFile", "resize", "remove", "move"]) {
  test(`held native public range does not block actual ${writer}`, async () => {
    const physical = new RangeFixture();
    let value: ReturnType<typeof publicReadFixture> | undefined;
    const gate = physical.gate(),
      entered = Promise.withResolvers<void>();
    let reading: Promise<unknown> | undefined;
    try {
      await physical.seed([PAGE * 3]);
      const storage = await physical.open();
      value = publicReadFixture(await PersistentBackend.open(storage, { intervalMs: 0 }));
      physical.file().snapshotRead = async () => {
        entered.resolve();
        await gate.promise;
      };
      reading = value.workspace.read("/file", { offset: PAGE - 3, length: 4096 });
      await entered.promise;
      const root = await value.client.asyncCall("preopen", ["/"]);
      const handle = (await value.client.asyncCall("resolve", [root, "file"])).node;
      value.client.retain(handle);
      const writing =
        writer === "writeFile"
          ? value.client.asyncCall("writeFile", ["/file"], new Uint8Array([90]))
          : writer === "remove"
            ? value.client.asyncCall("remove", ["/file"])
            : writer === "move"
              ? value.client.asyncCall("move", ["/file", "/renamed"])
              : writer === "resize"
                ? value.client.asyncCall("resize", [handle, 1, true])
                : value.client.asyncCall(
                    writer,
                    writer === "write" ? [handle, 0] : [handle],
                    new Uint8Array([90]),
                  );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        writing.then(() => "written"),
        new Promise<string>((resolve) => {
          timeout = setTimeout(() => resolve("blocked"), 2000);
        }),
      ]);
      clearTimeout(timeout);
      expect(outcome).toBe("written");
      expect(storage.resources().opfsReaderWork).toBe(1);
      gate.resolve();
      const read = await reading;
      expect(read).toMatchObject({
        kind: "ok",
        value: { range: { offset: PAGE - 3, length: 4096 } },
      });
      await writing;
    } finally {
      gate.resolve();
      await reading;
      await value?.close();
      await physical.cleanup();
    }
  });
}

test("aborted native public range keeps actual debt until the original I/O settles", async () => {
  const physical = new RangeFixture();
  let value: ReturnType<typeof publicReadFixture> | undefined;
  const gate = physical.gate(),
    entered = Promise.withResolvers<void>();
  let reading: Promise<unknown> | undefined;
  try {
    await physical.seed([PAGE * 3]);
    const storage = await physical.open();
    value = publicReadFixture(await PersistentBackend.open(storage, { intervalMs: 0 }));
    physical.file().snapshotRead = async () => {
      entered.resolve();
      await gate.promise;
    };
    const abort = new AbortController();
    reading = value.workspace.read("/file", { offset: 0, length: 4096 }, undefined, abort.signal);
    await entered.promise;
    abort.abort();
    let closed = false;
    const closing = value.workspace.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    expect(storage.resources().opfsReaderWork).toBe(1);
    expect(storage.resources().readerStorageBytes).toBe(PAGE * 3);
    gate.resolve();
    expect(await reading).toEqual({ kind: "stopped" });
    await closing;
    expect(storage.resources().opfsReaderWork).toBe(0);
    expect(storage.resources().readerStorageBytes).toBe(0);
    expect(value.service.resources().readerOperations).toBe(0);
  } finally {
    gate.resolve();
    await reading;
    await value?.close();
    await physical.cleanup();
  }
});

test("all public projections of one actual root share the lease budget", async () => {
  const value = await residentReadFixture(PAGE);
  const { connectFilesystemIdentity } = await import("../fs/protocol");
  const { createWorkspaceVfs } = await import("../fs/workspace");
  const identity = createFilesystemIdentity(value.client.connection);
  if (!identity.publication) throw new Error("missing public root buffers");
  identity.publication.observer = value.client.connection.publication!.observer;
  const pair = connectFilesystemIdentity(identity);
  let peer: FilesystemClient | undefined;
  let workspace: ReturnType<typeof createWorkspaceVfs> | undefined;
  try {
    value.service.connect(pair.server);
    peer = new FilesystemClient(pair.client);
    workspace = createWorkspaceVfs(peer);
    for (let index = 0; index < 16; index++) {
      const held = await value.workspace.pin("/file");
      expect(held.kind).toBe("ok");
    }
    expect(await workspace.pin("/file")).toEqual({ kind: "pressure", resource: "leases" });
    expect(value.service.resources().readerPinBytes).toBe(PAGE);
  } finally {
    await workspace?.close();
    peer?.dispose();
    pair.client.port.close();
    pair.server.port.close();
    await value.close();
  }
});

test("a held native range admits four operations and refuses a flood before client submission", async () => {
  const physical = new RangeFixture();
  const gate = physical.gate();
  const entered = Promise.withResolvers<void>();
  let count = 0;
  let value: ReturnType<typeof publicReadFixture> | undefined;
  const reads: Promise<unknown>[] = [];
  try {
    await physical.seed([PAGE * 3]);
    const storage = await physical.open();
    value = publicReadFixture(await PersistentBackend.open(storage, { intervalMs: 0 }));
    physical.file().snapshotRead = async () => {
      if (++count === 4) entered.resolve();
      await gate.promise;
    };
    for (let index = 0; index < 4; index++)
      reads.push(value.workspace.read("/file", { offset: index, length: 1 }));
    await entered.promise;
    const refused = await Promise.all(
      Array.from({ length: 40 }, () => value!.workspace.read("/file", { offset: 0, length: 1 })),
    );
    expect(
      refused.every((result) => result.kind === "pressure" && result.resource === "operations"),
    ).toBe(true);
    expect(storage.resources().opfsReaderWork).toBe(4);
    expect(value.client.completions.size).toBe(4);
    gate.resolve();
    expect(
      (await Promise.all(reads)).every(
        (result) =>
          !!result && typeof result === "object" && "kind" in result && result.kind === "ok",
      ),
    ).toBe(true);
    expect(value.service.resources().readerResultBytes).toBe(0);
    expect(value.service.resources().readerOperations).toBe(0);
    expect(value.client.completions.size).toBe(0);
  } finally {
    gate.resolve();
    await Promise.allSettled(reads);
    await value?.close();
    await physical.cleanup();
  }
});

test("a complete 128MiB resident lease preserves never-read distant bytes through final slot reuse", async () => {
  const value = await residentReadFixture(payloadSize);
  try {
    const opened = await value.workspace.pin("/file");
    if (opened.kind !== "ok") throw new Error(opened.kind);
    const lease = opened.value;
    expect(value.service.resources().readerPinBytes).toBe(payloadSize);
    expect(
      value.client.tryWrite(value.handle, [new Uint8Array([90])], payloadSize - PAGE + 3),
    ).toBe(1);
    await value.client.asyncCall("resize", [value.handle, 1, true]);
    await value.client.asyncCall("move", ["/file", "/moved"]);
    await value.client.asyncCall("writeFile", ["/replacement"], new Uint8Array([91]));
    await value.client.asyncCall("move", ["/replacement", "/moved"]);
    value.client.release(value.handle);
    await value.client.asyncCall("remove", ["/moved"]);
    await value.client.asyncCall("writeFile", ["/reused"], new Uint8Array(PAGE).fill(92));
    for (const offset of [PAGE + 7, payloadSize - PAGE + 3]) {
      const read = await lease.read({ offset, length: 11 });
      expect(read.kind).toBe("ok");
      if (read.kind === "ok") expect(read.value.bytes).toEqual(new Uint8Array(11).fill(65));
    }
    expect(await value.workspace.stat(lease.stat.id, lease.stat.cut)).toEqual({
      kind: "ok",
      value: lease.stat,
    });
    await lease.close();
    expect(
      await value.workspace.read(lease.stat.id, { offset: 0, length: 1 }, lease.stat.version),
    ).toEqual({ kind: "version-gone", requested: lease.stat.version });
    expect(value.service.resources().readerPinBytes).toBe(0);
  } finally {
    await value.close();
  }
});

test("reversed open arrival is not cancelled by unrelated newer closes", async () => {
  const value = await residentReadFixture(PAGE);
  const grant = value.client.connection.publication!.observer;
  try {
    for (let id = 2; id <= 100; id++)
      await value.client.asyncCall("publicationReadClose", [grant, id]);
    const opened = await value.client.asyncCall("publicationReadOpen", [
      grant,
      1,
      "/file",
      { offset: 0, length: 1 },
    ]);
    expect(opened).toMatchObject({ kind: "ok", value: { serial: 1 } });
    expect(await value.client.asyncCall("publicationReadChunk", [grant, 1, 0])).toEqual(
      new Uint8Array([65]),
    );
    await value.client.asyncCall("publicationReadClose", [grant, 1]);
    expect(
      await value.client.asyncCall("publicationReadOpen", [
        grant,
        1,
        "/file",
        { offset: 0, length: 1 },
      ]),
    ).toEqual({ kind: "cancelled" });
  } finally {
    await value.close();
  }
});
