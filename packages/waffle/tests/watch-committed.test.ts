import { hostFilesystemClient } from "./fixtures/filesystem-host.js";
import { expect, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent.js";
import { nextReservation } from "../fs/file-identity.js";
import { coldPublicationRoot, fixturePayloadHooks } from "./fixtures/publication-storage.js";
import { MemFS } from "../fs/memory.js";
import { WATCH_BYTES } from "../fs/watch-ring.js";
import { SharedFilesystemState } from "../fs/shared.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemClient } from "../fs/client.js";
import { FilesystemService } from "../fs/service.js";
import { createFilesystemConnection, revokeFilesystem, reapFilesystem } from "../fs/protocol.js";
import { WatchService } from "../fs/watch-service.js";
import { Wasi } from "../core/wasi.js";
import { FilesystemError, type FileSystem, type WatchFileSystem } from "../core/filesystem.js";
import type { Resource } from "../core/descriptors.js";
import { RIGHTS_ALL } from "../core/rights.js";
import { watchGuest, watchGuestModule } from "./fixtures/watch-guest.js";
import {
  FILESYSTEM_REQUEST_LIMITS,
  FilesystemRequestAllocator,
  FilesystemRequestPool,
  REQUEST_CLIENT,
  REQUEST_SERVICE,
  createRequestBudget,
  releaseRequestBuffer,
  type FilesystemRequestBuffer,
} from "../fs/request-memory.js";

async function fixture(backend = new MemoryBackend()) {
  const pair = createFilesystemConnection();
  const service = new FilesystemService(backend);
  service.connect(pair.server);
  const page = hostFilesystemClient(service, pair);
  const guest = new FilesystemClient(page.fork());
  const root = await page.asyncCall("preopen", ["/"]);
  const guestRoot = await guest.asyncCall("preopen", ["/"]);
  const close = async () => {
    page.dispose();
    guest.dispose();
    await service.shutdown();
  };
  return { backend, service, page, guest, root, guestRoot, close };
}

async function file(client: FilesystemClient, root: number, name: string) {
  const path = await client.asyncCall("resolve", [root, name]);
  const handle = await client.asyncCall("create", [path, "file", false]);
  client.retain(handle);
  return handle;
}

test("committed page, guest and direct writes wake an idle watcher without publication", async () => {
  const f = await fixture();
  try {
    const handle = await file(f.guest, f.guestRoot, "one");
    await f.guest.asyncCall("resize", [handle, 65536, false]);
    const watch = await f.page.watch(f.root, { recursive: true });
    expect(f.page.shared.publication).toBeUndefined();
    const pending = watch.next();
    expect(f.guest.write(handle, [new Uint8Array([71])], 0)).toBe(1);
    const batch = await pending;
    expect(batch.kind).toBe("events");
    expect(batch.events).toContainEqual(expect.objectContaining({ type: "change", name: "one" }));
    const bytes = new Uint8Array(1);
    expect(f.guest.read(handle, [bytes], 0)).toBe(1);
    expect(bytes[0]).toBe(71);
    await f.page.asyncCall("writeFile", ["/one", true], new Uint8Array([72]));
    expect((await watch.next()).events.length).toBeGreaterThan(0);
    await watch.close();
  } finally {
    await f.close();
  }
}, 10000);

test("recursive identity graph follows hard links and renamed subtrees, never replacement identity", async () => {
  const f = await fixture();
  try {
    await f.page.asyncCall("mkdirp", ["/tree/sub"]);
    const old = await file(f.guest, f.guestRoot, "tree/sub/a");
    await f.guest.asyncCall("resize", [old, 16, false]);
    const directory = await f.page.asyncCall("resolve", [f.root, "tree"]);
    const watch = await f.page.watch(directory.node, { recursive: true });
    const pageOld = await f.page.asyncCall("resolve", [f.root, "tree/sub/a"]);
    const target = await f.page.watch(pageOld.node);
    const from = await f.guest.asyncCall("resolve", [f.guestRoot, "tree/sub/a"]);
    const to = await f.guest.asyncCall("resolve", [f.guestRoot, "tree/sub/b"]);
    await f.guest.asyncCall("link", [from, to]);
    await watch.read();
    f.guest.write(old, [new Uint8Array([1])], 0);
    const aliases = await watch.read();
    expect(aliases.events.map((event) => event.name).sort()).toEqual(["sub/a", "sub/b"]);
    await f.guest.asyncCall("move", ["/tree/sub", "/tree/moved"]);
    await watch.read();
    f.guest.write(old, [new Uint8Array([2])], 0);
    expect((await watch.read()).events.map((event) => event.name).sort()).toEqual([
      "moved/a",
      "moved/b",
    ]);
    await f.guest.asyncCall("remove", ["/tree/moved/a"]);
    await f.guest.asyncCall("remove", ["/tree/moved/b"]);
    const replacement = await file(f.guest, f.guestRoot, "tree/moved/a");
    await f.guest.asyncCall("resize", [replacement, 16, false]);
    await target.read();
    f.guest.write(replacement, [new Uint8Array([3])], 0);
    expect((await target.read()).events).toEqual([]);
    await watch.read();
    f.guest.write(old, [new Uint8Array([4])], 0);
    expect((await target.read()).events).toContainEqual(
      expect.objectContaining({ type: "change", name: null }),
    );
    expect((await watch.read()).events).toEqual([]);
    await watch.close();
    await target.close();
  } finally {
    await f.close();
  }
}, 10000);

test("overflow is explicit and close or process revocation wakes pending next", async () => {
  const f = await fixture();
  try {
    const handle = await file(f.guest, f.guestRoot, "one");
    await f.guest.asyncCall("resize", [handle, 16, false]);
    const watch = await f.page.watch(f.root);
    for (let i = 0; i < 200; i++) f.guest.write(handle, [new Uint8Array([i])], 0);
    expect((await watch.read()).kind).toBe("overflow");
    await watch.close();
    const waiting = await f.page.watch(f.root);
    const pending = waiting.next();
    await waiting.close();
    expect((await pending).kind).toBe("closed");
    const killed = await f.guest.watch(f.guestRoot);
    const killedNext = killed.next();
    revokeFilesystem(f.guest.connection);
    f.service.sweep();
    await expect(killedNext).rejects.toMatchObject({ errno: 11 });
  } finally {
    await f.close();
  }
}, 10000);

test("registration capture excludes a real DIRECT worker until cursor and subscriber activation commit", async () => {
  const f = await fixture();
  const worker = new Worker(new URL("./watch-direct-worker.ts", import.meta.url).href);
  try {
    const handle = await file(f.page, f.root, "one");
    await f.page.asyncCall("resize", [handle, 16, false]);
    const controlBuffer = new SharedArrayBuffer(8);
    const control = new Int32Array(controlBuffer);
    const messages: unknown[] = [];
    let ready!: () => void;
    let finish!: (value: unknown) => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const done = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    worker.onmessage = ({ data }) => {
      messages.push(data);
      if (data === "ready") ready();
      else finish(data);
    };
    const connection = f.page.fork();
    worker.postMessage({ connection, control: controlBuffer }, [connection.port]);
    await started;
    const ensureIdentity = f.backend.ensureIdentity.bind(f.backend);
    let captured = false;
    f.backend.ensureIdentity = (node) => {
      if (node !== f.backend.fs.root || captured) return ensureIdentity(node);
      captured = true;
      expect(Atomics.load(f.backend.shared.cells, 1)).not.toBe(0);
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
      Atomics.wait(control, 1, 0, 2000);
      expect(Atomics.load(control, 1)).toBe(1);
      expect(f.backend.shared.watch.active).toBe(false);
      expect(f.backend.shared.watch.sequence).toBe(0);
      return ensureIdentity(node);
    };
    const watch = await f.page.watch(f.root);
    expect(captured).toBe(true);
    expect(await done).toEqual({ written: 1, sequence: 1 });
    const batch = await watch.next();
    expect(batch.events).toContainEqual(expect.objectContaining({ name: "one", type: "change" }));
    expect((await f.page.asyncCall("readFile", ["/one"]))[0]).toBe(91);
    expect(messages.length).toBe(2);
    await watch.close();
  } finally {
    worker.terminate();
    await f.close();
  }
}, 10000);

test("unrepresentable UTF8 names overflow without changing or failing the filesystem mutation", async () => {
  const f = await fixture();
  try {
    const watch = await f.page.watch(f.root);
    const name = "bad\ud800";
    const handle = await file(f.guest, f.guestRoot, name);
    expect(typeof handle).toBe("number");
    expect((await f.guest.asyncCall("resolve", [f.guestRoot, name])).node).toBe(handle);
    expect((await watch.read()).kind).toBe("overflow");
    await watch.close();
  } finally {
    await f.close();
  }
}, 10000);

test("client disposal detaches abort listeners and releases every service subscription", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  let removed = 0;
  controller.signal.removeEventListener = (
    ...args: Parameters<AbortSignal["removeEventListener"]>
  ) => {
    removed++;
    remove(...args);
  };
  try {
    await f.guest.watch(f.guestRoot, { signal: controller.signal });
    expect(f.backend.shared.watch.active).toBe(true);
    f.guest.dispose();
    f.service.sweep();
    expect(removed).toBe(1);
    expect(f.backend.shared.watch.active).toBe(false);
  } finally {
    await f.close();
  }
}, 10000);

test("guest subscriptions receive page and peer append, truncate, metadata and reentrant writes", async () => {
  const f = await fixture();
  try {
    const handle = await file(f.guest, f.guestRoot, "one");
    await f.guest.asyncCall("resize", [handle, 65536, false]);
    const watch = await f.guest.watch(f.guestRoot);
    await f.page.asyncCall("writeFile", ["/one", true], new Uint8Array([1]));
    expect((await watch.next()).events.some((event) => event.name === "one")).toBe(true);
    const pending = watch.next();
    expect(f.guest.append(handle, [new Uint8Array([2])])).toEqual({ written: 1, offset: 65538 });
    expect((await pending).events.some((event) => event.name === "one")).toBe(true);
    const pagePath = await f.page.asyncCall("resolve", [f.root, "one"]);
    await f.page.asyncCall("resize", [pagePath.node, 1, true]);
    expect((await watch.next()).events.some((event) => event.name === "one")).toBe(true);
    await f.page.asyncCall("setMode", [pagePath.node, 0o400]);
    expect((await watch.read()).events.some((event) => event.name === "one")).toBe(true);
    await f.page.asyncCall("setMode", [pagePath.node, 0o600]);
    await watch.read();
    expect(f.guest.write(handle, [new Uint8Array([3])], 0)).toBe(1);
    expect((await watch.next()).events.some((event) => event.name === "one")).toBe(true);
    await watch.close();
  } finally {
    await f.close();
  }
}, 10000);

test("directory scope excludes outside aliases and symlink traversal, follows replacement and deletion", async () => {
  const f = await fixture();
  try {
    await f.page.asyncCall("mkdirp", ["/inside/sub"]);
    const handle = await file(f.guest, f.guestRoot, "inside/sub/a");
    await f.guest.asyncCall("resize", [handle, 16, false]);
    const from = await f.guest.asyncCall("resolve", [f.guestRoot, "inside/sub/a"]);
    const outside = await f.guest.asyncCall("resolve", [f.guestRoot, "outside"]);
    await f.guest.asyncCall("link", [from, outside]);
    const link = await f.guest.asyncCall("resolve", [f.guestRoot, "inside/link"]);
    await f.guest.asyncCall("symlink", [link, "/outside"]);
    const directory = await f.page.asyncCall("resolve", [f.root, "inside"]);
    const watch = await f.page.watch(directory.node, { recursive: true });
    f.guest.write(handle, [new Uint8Array([1])], 0);
    expect((await watch.read()).events.map((event) => event.name)).toEqual(["sub/a"]);
    await f.guest.asyncCall("setMode", [from.parent, 0o200]);
    await watch.read();
    f.guest.write(handle, [new Uint8Array([2])], 0);
    expect((await watch.read()).events).toEqual([]);
    await f.guest.asyncCall("setMode", [from.parent, 0o700]);
    await watch.read();
    await f.page.asyncCall("move", ["/inside/sub", "/moved"]);
    await watch.read();
    f.guest.write(handle, [new Uint8Array([3])], 0);
    expect((await watch.read()).events).toEqual([]);
    await f.page.asyncCall("mkdirp", ["/inside/sub"]);
    const replacement = await file(f.guest, f.guestRoot, "inside/sub/a");
    await f.guest.asyncCall("resize", [replacement, 16, false]);
    await watch.read();
    f.guest.write(replacement, [new Uint8Array([4])], 0);
    expect((await watch.read()).events.map((event) => event.name)).toEqual(["sub/a"]);
    await f.page.asyncCall("remove", ["/inside/sub"]);
    expect((await watch.read()).events.some((event) => event.type === "rename")).toBe(true);
    await watch.close();
  } finally {
    await f.close();
  }
}, 10000);

test("UTF8 byte limit, stale ring recovery, and safe-integer exhaustion are explicit", async () => {
  const f = await fixture();
  try {
    const watch = await f.page.watch(f.root);
    const fitting = "é".repeat(512);
    await file(f.guest, f.guestRoot, fitting);
    expect((await watch.read()).events.some((event) => event.name === fitting)).toBe(true);
    const oversized = "é".repeat(513);
    await file(f.guest, f.guestRoot, oversized);
    expect((await watch.read()).kind).toBe("overflow");
    await watch.close();
    try {
      await f.page.watch(f.root);
      throw new Error("accepted");
    } catch (error) {
      expect(error).toMatchObject({ errno: 6 });
    }
    await f.page.asyncCall("remove", ["/" + oversized]);
    const recovered = await f.page.watch(f.root);
    await f.page.asyncCall("remove", ["/" + fitting]);
    expect((await recovered.read()).kind).toBe("events");
    f.backend.shared.mutate(undefined, undefined, () => {
      const cells = f.backend.shared.watch.cells;
      cells[1] = -2;
      cells[2] = 0x1fffff;
    });
    const handle = await file(f.guest, f.guestRoot, "final");
    expect(typeof handle).toBe("number");
    expect((await recovered.read()).kind).toBe("overflow");
    await recovered.close();
    try {
      await f.page.watch(f.root);
      throw new Error("accepted");
    } catch (error) {
      expect(error).toMatchObject({ errno: 6 });
    }
  } finally {
    await f.close();
  }
}, 10000);

test("first graph capture is bounded; overlapping watches reuse it and idle next performs no scans or RPCs", async () => {
  const f = await fixture();
  try {
    const handle = await file(f.guest, f.guestRoot, "one");
    await f.guest.asyncCall("resize", [handle, 16, false]);
    const identity = f.backend.ensureIdentity.bind(f.backend);
    let visited = 0;
    f.backend.ensureIdentity = (node) => {
      visited++;
      return identity(node);
    };
    const first = await f.page.watch(f.root);
    const captured = visited;
    const watches = [first];
    for (let i = 1; i < 128; i++) watches.push(await f.page.watch(f.root));
    expect(visited - captured).toBe(127);
    try {
      await f.page.watch(f.root);
      throw new Error("accepted");
    } catch (error) {
      expect(error).toMatchObject({ errno: 6 });
    }
    const call = f.page.asyncCall.bind(f.page);
    let calls = 0;
    f.page.asyncCall = (...args) => {
      calls++;
      return call(...args);
    };
    const beforeIdle = visited;
    const pending = first.next();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const armed = calls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(armed).toBe(1);
    expect(calls).toBe(armed);
    expect(visited).toBe(beforeIdle);
    f.guest.write(handle, [new Uint8Array([8])], 0);
    expect((await pending).events.length).toBe(1);
    for (const watch of watches) await watch.close();
    expect(f.backend.shared.watch.active).toBe(false);
    expect(WATCH_BYTES).toBe(147472);
    const ordinary = new SharedFilesystemState();
    expect(ordinary.watch.active).toBe(false);
    expect(ordinary.buffer.byteLength).toBeGreaterThan(147472);
  } finally {
    await f.close();
  }
  const fs = new MemFS();
  for (let index = 0; index < 4096; index++) fs.writeFile("/" + index, new Uint8Array());
  const large = await fixture(new MemoryBackend(fs));
  try {
    await expect(large.page.watch(large.root)).rejects.toMatchObject({ errno: 6 });
    expect(large.backend.shared.watch.active).toBe(false);
  } finally {
    await large.close();
  }
}, 10000);

test("AbortSignal closes an armed next and enforces subscription ownership", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const watch = await f.page.watch(f.root, { signal: controller.signal });
    await expect(f.guest.asyncCall("watchRead", [1])).rejects.toMatchObject({ errno: 8 });
    const pending = watch.next();
    controller.abort();
    expect((await pending).kind).toBe("closed");
    await f.page.asyncCall("watchClose", [1]);
    expect(f.backend.shared.watch.active).toBe(false);
    await expect(f.page.watch(f.root, { signal: controller.signal })).rejects.toMatchObject({
      errno: 11,
    });
  } finally {
    await f.close();
  }
}, 10000);

for (const killed of [false, true])
  test(`real guest watcher receives peer direct commit or is forcibly reaped, killed=${killed}`, async () => {
    const f = await fixture();
    const worker = new Worker(new URL("./watch-direct-worker.ts", import.meta.url).href);
    try {
      const handle = await file(f.guest, f.guestRoot, "one");
      await f.guest.asyncCall("resize", [handle, 16, false]);
      let ready!: () => void;
      let finish!: (batch: { events: { name: string }[] }) => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const done = new Promise<{ events: { name: string }[] }>((resolve) => {
        finish = resolve;
      });
      worker.onmessage = ({ data }) => {
        if (data === "ready") ready();
        else finish(data);
      };
      const connection = f.page.fork();
      worker.postMessage({ connection, mode: "watch", control: new SharedArrayBuffer(8) }, [
        connection.port,
      ]);
      await started;
      expect(f.backend.shared.watch.active).toBe(true);
      if (killed) {
        revokeFilesystem(connection);
        worker.terminate();
        reapFilesystem(connection);
        f.service.sweep();
        expect(f.backend.shared.watch.active).toBe(false);
        return;
      }
      expect(f.guest.write(handle, [new Uint8Array([4])], 0)).toBe(1);
      expect((await done).events.map((event) => event.name)).toEqual(["one"]);
    } finally {
      worker.terminate();
      await f.close();
    }
  }, 10000);

test("watch registration and idle delivery never hydrate cold persistent contents", async () => {
  const payloads = new Map([["fixture-payload", new Uint8Array([65, 66, 67])]]);
  let reads = 0;
  const backend = await PersistentBackend.open(
    {
      ...fixturePayloadHooks(payloads),
      async reserveIdentity() {
        return nextReservation(undefined);
      },
      async load() {
        return coldPublicationRoot();
      },
      async read() {
        reads++;
        throw new Error("watch hydrated file contents");
      },
      async readRange() {
        reads++;
        throw new Error("watch read a cold payload range");
      },
      async persist() {},
      async flush() {},
      async close() {},
    },
    { intervalMs: 0 },
  );
  const f = await fixture(backend);
  try {
    const watch = await f.page.watch(f.root, { recursive: true });
    const path = await f.page.asyncCall("resolve", [f.root, "file"]);
    const target = await f.page.watch(path.node);
    const pending = watch.next();
    await Bun.sleep(30);
    expect(reads).toBe(0);
    expect(f.page.shared.publication).toBeUndefined();
    await watch.close();
    expect((await pending).kind).toBe("closed");
    await target.close();
    expect(reads).toBe(0);
  } finally {
    await f.close();
  }
}, 10000);

test("observed service revocation detaches the watch AbortSignal listener", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  let removed = 0;
  controller.signal.removeEventListener = (
    ...args: Parameters<AbortSignal["removeEventListener"]>
  ) => {
    removed++;
    remove(...args);
  };
  try {
    const watch = await f.guest.watch(f.guestRoot, { signal: controller.signal });
    const pending = watch.next();
    revokeFilesystem(f.guest.connection);
    f.service.sweep();
    await expect(pending).rejects.toMatchObject({ errno: 11 });
    expect(removed).toBe(1);
    expect((await watch.read()).kind).toBe("closed");
  } finally {
    await f.close();
  }
}, 10000);

test("namespace event names preserve a leading UTF8 BOM", async () => {
  const f = await fixture();
  try {
    const watch = await f.page.watch(f.root);
    await file(f.guest, f.guestRoot, "\ufeffentry");
    expect((await watch.read()).events).toContainEqual(
      expect.objectContaining({ type: "rename", name: "\ufeffentry" }),
    );
    await watch.close();
  } finally {
    await f.close();
  }
}, 10000);

const RECURSIVE = 1;
const CHANGE = 1;
const RENAME = 2;
const OVERFLOW = 3;

/** The real WASI adapter and watch service in one thread; calls are counted at the service.
 * Each call takes a request buffer from a real allocator, as FilesystemClient's calls do. */
function guestWatches(hooks: { afterOpen?(): void; duringRead?(): void } = {}) {
  const backend = new MemoryBackend();
  backend.execute("mkdirp", ["/dir/sub"], new Uint8Array());
  const write = (path: string, byte = 1) =>
    backend.execute("writeFile", [path, false], new Uint8Array([byte]));
  write("/dir/a");
  write("/dir/sub/b");
  const service = new WatchService(backend);
  const calls = { open: 0, read: 0, close: 0 };
  const state = { revoked: false };
  const pool = new FilesystemRequestPool(createRequestBudget());
  const allocator = new FilesystemRequestAllocator(pool.take(new SharedArrayBuffer(4)));
  const release = (buffer: FilesystemRequestBuffer) => {
    releaseRequestBuffer(buffer, REQUEST_CLIENT);
    releaseRequestBuffer(buffer, REQUEST_SERVICE);
  };
  const request = <T>(call: () => T): T => {
    const buffer = allocator.allocate(64);
    try {
      return call();
    } finally {
      release(buffer);
    }
  };
  /** Occupy every outstanding request slot until the returned release runs. */
  const saturate = () => {
    const held = Array.from({ length: FILESYSTEM_REQUEST_LIMITS.outstanding }, () =>
      allocator.allocate(64),
    );
    return () => held.forEach(release);
  };
  const source: WatchFileSystem = {
    cells: backend.shared.watch.cells,
    get revoked() {
      return state.revoked;
    },
    open: (handle, recursive) =>
      request(() => {
        calls.open++;
        if (state.revoked) throw new FilesystemError(11);
        const id = service.open(1, handle, recursive, () => false);
        hooks.afterOpen?.();
        return id;
      }),
    read: (id) =>
      request(() => {
        calls.read++;
        const batch = service.read(1, id);
        hooks.duringRead?.();
        return batch;
      }),
    close: (id) =>
      request(() => {
        calls.close++;
        service.close(1, id);
      }),
  };
  const fs: FileSystem = Object.assign(backend.fs, { watches: source });
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const module = watchGuestModule();
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  wasi.start(instance);
  const descriptor = (path: string) => {
    const node = backend.fs.lookup(path)!;
    const handle = backend.fs.handleForNode(node);
    backend.fs.retain(handle);
    const resource: Resource =
      node.kind === "dir"
        ? { kind: "directory", handle }
        : { kind: "file", handle, offset: 0, append: false };
    return wasi.descriptors.open(resource, RIGHTS_ALL, RIGHTS_ALL);
  };
  return { backend, calls, state, wasi, guest: watchGuest(instance), write, descriptor, saturate };
}

test("guest watch imports report direct, recursive and file names as packed records", () => {
  const h = guestWatches();
  const direct = h.guest.open(h.descriptor("/dir"));
  const recursive = h.guest.open(h.descriptor("/dir"), RECURSIVE);
  const file = h.guest.open(h.descriptor("/dir/a"), RECURSIVE);
  expect([direct.errno, recursive.errno, file.errno]).toEqual([0, 0, 0]);
  expect([direct.id, recursive.id, file.id]).toEqual([1, 2, 3]);
  expect(h.guest.read(direct.id).errno).toBe(6);
  h.write("/dir/a", 2);
  h.write("/dir/sub/b", 3);
  expect(h.guest.drain(direct.id).records).toEqual([{ type: CHANGE, name: "a" }]);
  expect(h.guest.drain(recursive.id).records).toEqual([
    { type: CHANGE, name: "a" },
    { type: CHANGE, name: "sub/b" },
  ]);
  expect(h.guest.drain(file.id).records).toEqual([{ type: CHANGE, name: null }]);
  h.write("/dir/né");
  expect(h.guest.drain(recursive.id).records).toContainEqual({ type: RENAME, name: "né" });
  expect(h.guest.close(direct.id)).toBe(0);
  expect(h.guest.close(direct.id)).toBe(8);
  expect(h.guest.read(direct.id).errno).toBe(8);
  expect(h.guest.open(h.descriptor("/dir")).id).toBe(4);
  expect(h.wasi.filesystemWatches?.active).toBe(true);
});

test("guest watch read returns ENOBUFS with the needed size and loses nothing", () => {
  const h = guestWatches();
  const { id } = h.guest.open(h.descriptor("/dir"), RECURSIVE);
  h.write("/dir/a", 2);
  h.write("/dir/sub/b", 3);
  const short = h.guest.read(id, 11);
  expect(short).toMatchObject({ errno: 42, length: 12 });
  const one = h.guest.read(id, 23);
  expect(one).toMatchObject({ errno: 0, length: 12, records: [{ type: CHANGE, name: "a" }] });
  const reads = h.calls.read;
  expect(h.guest.read(id).records).toEqual([{ type: CHANGE, name: "sub/b" }]);
  expect(h.calls.read).toBe(reads);
});

test("guest watch EAGAIN makes no service call while the commit counter is unchanged", () => {
  const h = guestWatches();
  const { id } = h.guest.open(h.descriptor("/dir"), RECURSIVE);
  h.write("/dir/a", 2);
  expect(h.guest.drain(id).records).toEqual([{ type: CHANGE, name: "a" }]);
  const reads = h.calls.read;
  for (let index = 0; index < 100; index++) expect(h.guest.read(id).errno).toBe(6);
  expect(h.calls.read).toBe(reads);
  expect(h.wasi.filesystemWatches?.pending()).toBe(false);
  h.write("/dir/a", 3);
  expect(h.wasi.filesystemWatches?.pending()).toBe(true);
  expect(h.guest.drain(id).records).toEqual([{ type: CHANGE, name: "a" }]);
  expect(h.calls.read).toBe(reads + 1);
});

test("each guest watch keeps its own observed counter across interleaved reads", () => {
  const h = guestWatches();
  const first = h.guest.open(h.descriptor("/dir")).id;
  const second = h.guest.open(h.descriptor("/dir")).id;
  h.write("/dir/a", 2);
  // Reading `first` drains the shared ring into `second`'s service queue without a new commit.
  expect(h.guest.drain(first).records).toEqual([{ type: CHANGE, name: "a" }]);
  expect(h.wasi.filesystemWatches?.pending()).toBe(true);
  expect(h.guest.drain(second).records).toEqual([{ type: CHANGE, name: "a" }]);
  expect(h.wasi.filesystemWatches?.pending()).toBe(false);
});

test("a commit between service activation and watch_open's return reaches the first read", () => {
  let inject = true;
  const h = guestWatches({
    afterOpen() {
      if (!inject) return;
      inject = false;
      h.write("/dir/a", 9);
    },
  });
  const { id } = h.guest.open(h.descriptor("/dir"));
  expect(h.wasi.filesystemWatches?.pending()).toBe(true);
  expect(h.guest.drain(id).records).toEqual([{ type: CHANGE, name: "a" }]);
});

test("guest watch coalescing merges only events still unread in the service", () => {
  const h = guestWatches();
  const { id } = h.guest.open(h.descriptor("/dir"));
  h.write("/dir/a", 2);
  h.write("/dir/a", 3);
  expect(h.guest.drain(id).records).toEqual([{ type: CHANGE, name: "a" }]);
  h.write("/dir/a", 4);
  expect(h.guest.drain(id).records).toEqual([{ type: CHANGE, name: "a" }]);
});

test("a full guest watch queue yields one terminal overflow record, then end of stream", () => {
  const h = guestWatches();
  const { id } = h.guest.open(h.descriptor("/dir"));
  for (let index = 0; index <= 128; index++) h.write(`/dir/f${index}`);
  const read = h.guest.read(id);
  expect(read).toMatchObject({ errno: 0, length: 8, records: [{ type: OVERFLOW, name: null }] });
  expect(h.guest.read(id)).toMatchObject({ errno: 0, length: 0 });
  expect(h.wasi.filesystemWatches?.pending()).toBe(false);
  expect(h.wasi.filesystemWatches?.active).toBe(false);
  expect(h.guest.close(id)).toBe(0);
  expect(h.calls.close).toBe(1);
});

test("guest watch imports validate before changing state and pass service errnos through", () => {
  const h = guestWatches();
  const root = h.descriptor("/dir");
  expect(h.guest.open(99).errno).toBe(8);
  expect(h.guest.open(1).errno).toBe(28);
  expect(h.guest.open(root, 2).errno).toBe(28);
  expect(h.guest.open(root, 0, 65534).errno).toBe(21);
  expect(h.calls.open).toBe(0);
  // Only the first subscription's capture can miss a node; later graphs keep detached history.
  const detached = h.descriptor("/dir/sub/b");
  h.backend.execute("remove", ["/dir/sub/b"], new Uint8Array());
  expect(h.guest.open(detached).errno).toBe(44);
  const { id } = h.guest.open(root);
  h.write("/dir/a", 2);
  expect(h.guest.read(id, 16, 65530).errno).toBe(21);
  expect(h.guest.read(id, 16, 1024, 65534).errno).toBe(21);
  expect(h.calls.read).toBe(0);
  expect(h.guest.read(id).records).toEqual([{ type: CHANGE, name: "a" }]);
  const locked = h.descriptor("/dir/sub");
  const sub = h.backend.fs.handleForNode(h.backend.fs.lookup("/dir/sub")!);
  h.backend.execute("setMode", [sub, 0o300], new Uint8Array());
  expect(h.guest.open(locked).errno).toBe(2);
  for (let index = 1; index < 128; index++) expect(h.guest.open(root).errno).toBe(0);
  expect(h.guest.open(root).errno).toBe(6);
  h.state.revoked = true;
  expect(h.guest.read(id).errno).toBe(11);
  expect(h.wasi.filesystemWatches?.pending()).toBe(false);
  expect(h.guest.close(id)).toBe(0);
  expect(h.guest.close(id)).toBe(8);
});

test("a filesystem without watches reports ENOTSUP and offers no readiness", () => {
  const fs = new MemFS();
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const module = watchGuestModule();
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  wasi.start(instance);
  const guest = watchGuest(instance);
  expect(guest.open(3).errno).toBe(58);
  expect(guest.read(1).errno).toBe(8);
  expect(guest.close(1)).toBe(8);
  expect(wasi.filesystemWatches).toBeUndefined();
});

test("guest watch_read writes records through memory views reacquired after the service call", () => {
  const h = guestWatches({
    duringRead: () => {
      h.guest.memory.grow(1);
    },
  });
  const { id } = h.guest.open(h.descriptor("/dir"));
  h.write("/dir/a", 2);
  const before = h.guest.memory.buffer.byteLength;
  expect(h.guest.read(id).records).toEqual([{ type: CHANGE, name: "a" }]);
  expect(h.guest.memory.buffer.byteLength).toBe(before + 65536);
});

test("proc_exit drops guest watch ids without service calls", () => {
  const h = guestWatches();
  const { id } = h.guest.open(h.descriptor("/dir"));
  h.wasi.dropWatches();
  expect(h.wasi.filesystemWatches?.active).toBe(false);
  expect(h.guest.read(id).errno).toBe(8);
  expect(h.calls.close).toBe(0);
});

test("a guest watch read refused at request admission stays pending and delivers on retry", () => {
  const h = guestWatches();
  const { id } = h.guest.open(h.descriptor("/dir"));
  const release = h.saturate();
  h.write("/dir/a", 2);
  expect(h.guest.read(id).errno).toBe(6);
  expect(h.calls.read).toBe(0);
  expect(h.wasi.filesystemWatches?.pending()).toBe(true);
  release();
  expect(h.guest.drain(id).records).toEqual([{ type: CHANGE, name: "a" }]);
  expect(h.calls.read).toBe(1);
});

test("a guest watch close refused at request admission keeps its id for a retry", () => {
  const h = guestWatches();
  const { id } = h.guest.open(h.descriptor("/dir"));
  const release = h.saturate();
  expect(h.guest.close(id)).toBe(6);
  expect(Atomics.load(h.backend.shared.watch.cells, 0)).toBe(1);
  release();
  expect(h.guest.close(id)).toBe(0);
  expect(Atomics.load(h.backend.shared.watch.cells, 0)).toBe(0);
  expect(h.guest.close(id)).toBe(8);
});
