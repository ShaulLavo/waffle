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

async function fixture(backend = new MemoryBackend()) {
  const pair = createFilesystemConnection();
  const service = new FilesystemService(backend);
  service.connect(pair.server);
  const page = new FilesystemClient(pair.client);
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
