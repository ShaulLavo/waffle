import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend.js";
import { MemFS } from "../fs/memory.js";
import { WatchService } from "../fs/watch-service.js";

const empty = new Uint8Array();
const live = () => false;

function fixture(fs = new MemFS()) {
  const backend = new MemoryBackend(fs);
  const service = new WatchService(backend);
  const handle = (path: string) => {
    const node = fs.lookup(path);
    if (!node) throw new Error(`missing fixture node ${path}`);
    return fs.handleForNode(node);
  };
  const open = (path: string, owner = 1, recursive = false) =>
    service.open(owner, handle(path), recursive, live);
  const close = () => {
    service.closeOwner(1);
    service.closeOwner(2);
    expect(Atomics.load(backend.shared.watch.cells, 0)).toBe(0);
  };
  return { backend, service, handle, open, close };
}

function refusal(action: () => unknown, message: string): void {
  expect(action).toThrow(expect.objectContaining({ errno: 6, message }));
}

function write(backend: MemoryBackend, path: string): void {
  backend.execute("writeFile", [path, false], empty);
}

function alias(fs: MemFS, path: string): void {
  const from = fs.resolveAbsolute("/target");
  const to = fs.resolveAbsolute(path);
  if (typeof from === "number" || typeof to === "number") throw new Error("invalid alias");
  expect(fs.link(from, to)).toBe(0);
}

test("4097 identities outside a small file watch no longer refuse repeated first capture", () => {
  const fs = new MemFS();
  fs.writeFile("/target", empty);
  fs.mkdirp("/unrelated");
  for (let index = 0; index < 4094; index++) fs.writeFile(`/unrelated/${index}`, empty);
  const f = fixture(fs);
  const ensureIdentity = f.backend.ensureIdentity.bind(f.backend);
  let visits = 0;
  f.backend.ensureIdentity = (node) => {
    visits++;
    return ensureIdentity(node);
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = visits;
      const id = f.open("/target");
      expect(f.service.read(1, id)).toEqual({ kind: "events", events: [] });
      f.service.close(1, id);
      expect(visits - before).toBeGreaterThanOrEqual(4096);
      expect(f.backend.shared.watch.active).toBe(false);
    }
    expect(fs.remove("/unrelated/0")).toBe(true);
    const id = f.open("/target");
    expect(f.service.read(1, id)).toEqual({ kind: "events", events: [] });
    f.service.close(1, id);
  } finally {
    f.backend.ensureIdentity = ensureIdentity;
    f.close();
  }
});

test("16385 namespace edges with two identities admit a small file watch", () => {
  const fs = new MemFS();
  fs.writeFile("/target", empty);
  for (let index = 1; index < 16385; index++) alias(fs, `/alias${index}`);
  const f = fixture(fs);
  try {
    const first = f.open("/target");
    expect(f.backend.shared.watch.active).toBe(true);
    f.service.close(1, first);
    expect(f.backend.shared.watch.active).toBe(false);
    expect(fs.remove("/alias1")).toBe(true);
    const id = f.open("/target");
    expect(Atomics.load(f.backend.shared.watch.cells, 0)).toBe(1);
    f.service.close(1, id);
  } finally {
    f.close();
  }
});

test("a tiny namespace admits beyond 128 subscriptions across owners and returns credits", () => {
  const fs = new MemFS();
  fs.writeFile("/target", empty);
  const f = fixture(fs);
  try {
    const ids = Array.from({ length: 128 }, (_, index) => f.open("/target", index % 2 ? 2 : 1));
    expect(Atomics.load(f.backend.shared.watch.cells, 0)).toBe(128);
    const over128 = f.open("/target", 2);
    expect(over128).toBeGreaterThan(ids[127]!);
    expect(() => f.service.read(2, ids[0]!)).toThrow(expect.objectContaining({ errno: 8 }));
    f.service.close(1, ids[0]!);
    f.service.close(1, ids[0]!);
    const replacement = f.open("/target");
    expect(replacement).toBeGreaterThan(ids[127]!);
    expect(Atomics.load(f.backend.shared.watch.cells, 0)).toBe(129);
    f.service.closeOwner(1);
    expect(Atomics.load(f.backend.shared.watch.cells, 0)).toBe(65);
    f.service.closeOwner(2);
    expect(f.backend.shared.watch.active).toBe(false);
    f.open("/target");
    expect(Atomics.load(f.backend.shared.watch.cells, 0)).toBe(1);
  } finally {
    f.close();
  }
});

test("queue overflow affects only its slow watch while ring records remain complete", () => {
  const fs = new MemFS();
  for (let index = 0; index < 129; index++) fs.writeFile(`/file${index}`, empty);
  const f = fixture(fs);
  try {
    const slow = f.open("/", 1);
    const fast = f.open("/", 2);
    const boundary = f.open("/", 2);
    for (let index = 0; index < 129; index++) {
      f.backend.execute("writeFile", [`/file${index}`, false], new Uint8Array([1]));
      expect(f.service.read(2, fast).kind).toBe("events");
      if (index === 127) expect(f.service.read(2, boundary).events).toHaveLength(128);
    }
    expect(f.service.read(1, slow)).toEqual({ kind: "overflow", events: [] });
    expect(f.service.read(1, slow)).toEqual({ kind: "overflow", events: [] });
    write(f.backend, "/after-overflow");
    expect(f.service.read(2, fast).events).toContainEqual(
      expect.objectContaining({ type: "rename", name: "after-overflow" }),
    );
  } finally {
    f.close();
  }
});

test("129 unread ring records overflow every watch and last close permits a fresh baseline", () => {
  const fs = new MemFS();
  fs.writeFile("/target", empty);
  const f = fixture(fs);
  try {
    const first = f.open("/target");
    const second = f.open("/target", 2);
    const identity = f.backend.ensureIdentity(fs.lookup("/target")!).id;
    f.backend.shared.mutate(undefined, undefined, () => {
      for (let index = 0; index < 129; index++) f.backend.shared.watch.change(identity);
    });
    expect(f.service.read(1, first)).toEqual({ kind: "overflow", events: [] });
    expect(f.service.read(2, second)).toEqual({ kind: "overflow", events: [] });
    refusal(() => f.open("/target"), "watch metadata incomplete");
    f.service.closeOwner(1);
    f.service.closeOwner(2);
    const fresh = f.open("/target");
    expect(f.service.read(1, fresh)).toEqual({ kind: "events", events: [] });
  } finally {
    f.close();
  }
});

test("registration cancelled after capture releases its subscription before returning", () => {
  const fs = new MemFS();
  fs.writeFile("/target", empty);
  const f = fixture(fs);
  try {
    const initial = f.backend.ensureIdentity.bind(f.backend);
    let cancelled = false;
    f.backend.ensureIdentity = (node) => {
      cancelled = true;
      return initial(node);
    };
    expect(() => f.service.open(1, f.handle("/target"), false, () => cancelled)).toThrow(
      expect.objectContaining({ errno: 11 }),
    );
    expect(f.backend.shared.watch.active).toBe(false);
    f.backend.ensureIdentity = initial;
    f.open("/target");
    expect(Atomics.load(f.backend.shared.watch.cells, 0)).toBe(1);
  } finally {
    f.close();
  }
});

test("retained detached history refuses new registration but an existing identity watch still changes", () => {
  const fs = new MemFS();
  fs.writeFile("/target", empty);
  const f = fixture(fs);
  const handle = f.handle("/target");
  fs.retain(handle);
  try {
    const target = f.open("/target");
    f.backend.execute("remove", ["/target"], empty);
    expect(f.service.read(1, target).events).toContainEqual(
      expect.objectContaining({ type: "rename", name: null }),
    );
    expect(() => f.service.open(2, handle, false, live)).toThrow(
      expect.objectContaining({ errno: 44 }),
    );
    f.backend.execute("resize", [handle, 1, true], empty);
    expect(f.service.read(1, target).events).toContainEqual(
      expect.objectContaining({ type: "change", name: null }),
    );
  } finally {
    f.close();
    fs.release(handle);
  }
});
