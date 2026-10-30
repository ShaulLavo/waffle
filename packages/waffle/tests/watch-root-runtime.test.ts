import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend.js";
import { MemFS } from "../fs/memory.js";
import { WatchService } from "../fs/watch-service.js";
import { ORDINARY_WATCH_LIMITS } from "../fs/watch-account.js";
import { FilesystemService } from "../fs/service.js";
import { FilesystemClient } from "../fs/client.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import { hostFilesystemClient } from "./fixtures/filesystem-host.js";

const empty = new Uint8Array();
function local(overrides: Partial<typeof ORDINARY_WATCH_LIMITS> = {}) {
  const fs = new MemFS();
  const backend = new MemoryBackend(fs, undefined, undefined, {
    ...ORDINARY_WATCH_LIMITS,
    ...overrides,
  });
  const watches = new WatchService(backend);
  const open = (path: string, recursive = false) =>
    watches.open(1, fs.handleForNode(fs.lookup(path)!), recursive, () => false);
  const write = (path: string, byte = 1) =>
    backend.execute("writeFile", [path, false], new Uint8Array([byte]));
  const close = () => {
    watches.closeOwner(1);
    backend.watchAccount.close();
  };
  return { fs, backend, watches, open, write, close };
}
async function remote() {
  const pair = createFilesystemConnection();
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  service.connect(pair.server);
  const page = hostFilesystemClient(service, pair);
  const guest = new FilesystemClient(page.fork());
  const root = await guest.asyncCall("preopen", ["/"]);
  const close = async () => {
    guest.dispose();
    page.dispose();
    await service.shutdown();
  };
  return { backend, service, page, guest, root, close };
}

test("a direct content commit before rename keeps its old name and later writes use the moved name", () => {
  const f = local();
  try {
    f.write("/a");
    const handle = f.fs.handleForNode(f.fs.lookup("/a")!);
    f.backend.retain(handle);
    const id = f.open("/", true);
    expect(f.backend.shared.write(handle, [new Uint8Array([2])], 0)).toBe(1);
    f.backend.execute("move", ["/a", "/b"], empty);
    const before = f.watches.read(1, id);
    expect(before.events).toContainEqual(expect.objectContaining({ type: "change", name: "a" }));
    expect(before.events).not.toContainEqual(
      expect.objectContaining({ type: "change", name: "b" }),
    );
    expect(before.events).toContainEqual(expect.objectContaining({ type: "rename", name: "b" }));
    expect(f.backend.shared.write(handle, [new Uint8Array([3])], 0)).toBe(1);
    expect(f.watches.read(1, id).events).toContainEqual(
      expect.objectContaining({ type: "change", name: "b" }),
    );
    f.backend.release(handle);
  } finally {
    f.close();
  }
});

test("service commit routing collects dead identity and name history beyond the former node bound", () => {
  const f = local();
  try {
    const id = f.open("/", true);
    let highWater = 0;
    for (let turn = 0; turn < 5000; turn++) {
      f.write("/reused");
      expect(f.watches.read(1, id).kind).toBe("events");
      f.backend.execute("remove", ["/reused"], empty);
      expect(f.watches.read(1, id).kind).toBe("events");
      highWater = turn === 100 ? f.backend.watchAccount.resources().backingBytes : highWater;
    }
    expect(f.watches.resources()).toMatchObject({
      nodes: 1,
      edges: 0,
      nameBytes: 0,
      incomplete: false,
    });
    expect(f.backend.watchAccount.resources().backingBytes).toBe(highWater);
  } finally {
    f.close();
  }
});

test("moving a populated subtree into and out of scope updates edges without recapturing it", () => {
  const f = local();
  try {
    f.backend.execute("mkdirp", ["/inside"], empty);
    f.backend.execute("mkdirp", ["/outside/sub"], empty);
    for (let at = 0; at < 500; at++) f.write(`/outside/sub/${at}`);
    const id = f.open("/inside", true);
    const identity = f.backend.ensureIdentity.bind(f.backend);
    let visits = 0;
    f.backend.ensureIdentity = (node) => {
      visits++;
      return identity(node);
    };
    f.backend.execute("move", ["/outside/sub", "/inside/moved"], empty);
    expect(visits).toBeLessThan(50);
    f.watches.read(1, id);
    f.write("/inside/moved/0", 2);
    expect(f.watches.read(1, id).events).toContainEqual(
      expect.objectContaining({ type: "change", name: "moved/0" }),
    );
    f.backend.execute("move", ["/inside/moved", "/outside/again"], empty);
    f.watches.read(1, id);
    f.write("/outside/again/0", 3);
    expect(f.watches.read(1, id).events).toEqual([]);
    f.backend.ensureIdentity = identity;
  } finally {
    f.close();
  }
});

test("routing scratch exhaustion overflows watches without failing the committed write", () => {
  const f = local({ workBytes: 64 });
  const name = "/" + "x".repeat(80);
  try {
    f.write(name);
    const directory = f.open("/");
    const target = f.open(name);
    expect(() => f.write(name, 9)).not.toThrow();
    expect(f.backend.execute("readFile", [name], empty)).toEqual(new Uint8Array([9]));
    expect(f.watches.read(1, directory)).toEqual({ kind: "overflow", events: [] });
    expect(f.watches.read(1, target)).toEqual({ kind: "overflow", events: [] });
    f.watches.closeOwner(1);
    const fresh = f.open(name);
    f.write(name, 10);
    expect(f.watches.read(1, fresh).events).toContainEqual(
      expect.objectContaining({ type: "change", name: null }),
    );
  } finally {
    f.close();
  }
});

test("index growth failure is terminal notification overflow, never a namespace mutation failure", () => {
  const f = local({ backingBytes: 4096, slabBytes: 64, eventBytes: 2048, workBytes: 512 });
  try {
    const id = f.open("/", true);
    let ended = false;
    for (let at = 0; at < 200 && !ended; at++) {
      f.write(`/created${at}`);
      ended = f.watches.read(1, id).kind === "overflow";
    }
    expect(ended).toBe(true);
    expect(f.watches.resources().incomplete).toBe(true);
    expect(() => f.write("/after-overflow", 7)).not.toThrow();
    expect(f.backend.execute("readFile", ["/after-overflow"], empty)).toEqual(new Uint8Array([7]));
    expect(f.watches.read(1, id)).toEqual({ kind: "overflow", events: [] });
    expect(f.backend.watchAccount.resources().backingBytes).toBeLessThanOrEqual(4096);
  } finally {
    f.close();
  }
});

function interceptReply(
  service: FilesystemService,
  completion: ReturnType<FilesystemClient["submit"]>,
) {
  const original: unknown = Reflect.get(service, "writeResponse");
  if (typeof original !== "function") throw new Error("missing reply publication method");
  let intercepted = false;
  Reflect.set(service, "writeResponse", (...args: unknown[]) => {
    if (args[1] === completion.id) {
      intercepted = true;
      completion.cancel();
    }
    return Reflect.apply(original, service, args);
  });
  return {
    intercepted: () => intercepted,
    restore: () => {
      Reflect.set(service, "writeResponse", original);
    },
  };
}
test.each(["watchRead", "watchOpen"] as const)(
  "request cancellation rolls back %s after execution before reply publication",
  async (operation) => {
    const f = await remote();
    let interception: ReturnType<typeof interceptReply> | undefined;
    try {
      const id =
        operation === "watchRead"
          ? await f.guest.asyncCall("watchOpen", [f.root, false])
          : undefined;
      await f.page.asyncCall("writeFile", ["/a", false], new Uint8Array([1]));
      const completion = f.guest.submit(
        operation,
        operation === "watchRead" ? [id] : [f.root, false],
      );
      interception = interceptReply(f.service, completion);
      try {
        await expect(completion.value()).rejects.toMatchObject({ errno: 11 });
      } finally {
        completion.release();
        interception?.restore();
      }
      expect(interception.intercepted()).toBe(true);
      await f.guest.asyncCall("stat", [f.root]);
      if (operation === "watchRead") {
        const batch = await f.guest.asyncCall("watchRead", [id]);
        expect(batch.events).toContainEqual(expect.objectContaining({ type: "rename", name: "a" }));
      } else expect(f.backend.shared.watch.active).toBe(false);
    } finally {
      interception?.restore();
      await f.close();
    }
    expect(f.backend.watchAccount.resources()).toMatchObject({
      liveBytes: 0,
      reservedBytes: 0,
      backingBytes: 0,
      controlUnits: 0,
    });
  },
);

test("service disposal releases the root watch account after session response cleanup", async () => {
  const f = await remote();
  try {
    await f.guest.asyncCall("watchOpen", [f.root, true]);
    await f.page.asyncCall("writeFile", ["/before-dispose", false], new Uint8Array([1]));
    expect(f.backend.watchAccount.resources().backingBytes).toBeGreaterThan(0);
    f.service.dispose();
    f.service.sweep();
    expect(f.backend.shared.watch.active).toBe(false);
    expect(f.backend.watchAccount.resources()).toMatchObject({
      stopped: true,
      backingBytes: 0,
      liveBytes: 0,
      controlUnits: 0,
    });
  } finally {
    await f.close();
  }
});
