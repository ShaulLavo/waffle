import { SLOT_WORDS } from "../fs/shared.js";
import { expect, spyOn, test } from "bun:test";
import { DEFAULT_SHARED_MAX_BYTES } from "../fs/protocol";
import { DATA_PAGE_BYTES as PAGE, DATA_PAGES_PER_SEGMENT } from "../fs/storage-geometry";
import { MemoryBackend, SharedFilesystemState } from "../fs";
import { ms, statTimes } from "../testing/fixtures/file-times";

test("revoking a killed shared-page writer releases its file lock", () => {
  const state = new SharedFilesystemState();
  state.register(
    0,
    { kind: "file", ino: 1, nlink: 1, size: PAGE, ...statTimes(1) },
    new Uint8Array(PAGE),
  );
  const lock = SLOT_WORDS + 8;
  Atomics.store(state.slots, lock, 41);
  state.revokeOwner(41);
  expect(Atomics.load(state.slots, lock)).toBe(0);
  expect(state.write(0, [new Uint8Array([7])], 0, undefined, 42)).toBe(1);
});

test("the service grows into another SAB segment and preserves page data", () => {
  const state = new SharedFilesystemState();
  state.register(
    0,
    { kind: "file", ino: 1, nlink: 1, size: PAGE * DATA_PAGES_PER_SEGMENT, ...statTimes(1) },
    new Uint8Array(PAGE * DATA_PAGES_PER_SEGMENT).fill(65),
  );
  state.register(
    1,
    { kind: "file", ino: 2, nlink: 1, size: PAGE, ...statTimes(1) },
    new Uint8Array(PAGE).fill(66),
  );
  const [segment] = state.takeNewSegments();
  expect(segment?.buffer).toBeInstanceOf(SharedArrayBuffer);
  const guest = new SharedFilesystemState(state.buffer);
  guest.addSegment(segment!.buffer, segment!.index);
  const out = new Uint8Array(1);
  expect(guest.read(1, [out], 0)).toBe(1);
  expect(out[0]).toBe(66);
});

test("storage cap reports ENOSPC while the address-space limit reports EFBIG", () => {
  const cap = new SharedFilesystemState(undefined, 16 * 1024 * 1024);
  cap.register(
    0,
    { kind: "file", ino: 1, nlink: 1, size: PAGE * DATA_PAGES_PER_SEGMENT, ...statTimes(1) },
    new Uint8Array(PAGE * DATA_PAGES_PER_SEGMENT),
  );
  try {
    cap.register(
      1,
      { kind: "file", ino: 2, nlink: 1, size: PAGE, ...statTimes(1) },
      new Uint8Array(PAGE),
    );
    throw new Error("expected ENOSPC");
  } catch (error) {
    expect((error as { errno?: number }).errno).toBe(51);
  }
  expect(() =>
    cap.register(
      2,
      { kind: "file", ino: 3, nlink: 1, size: 1024 * 1024 * 1024 + PAGE, ...statTimes(1) },
      new Uint8Array(),
    ),
  ).toThrow(RangeError);
});

test("a cloned root attachment preserves service-owned extra segments", () => {
  const backend = new MemoryBackend();
  const buffer = SharedFilesystemState.createBuffer();
  backend.attachShared(buffer);
  const state = backend.shared;
  state.register(0, {
    kind: "file",
    ino: 1,
    nlink: 1,
    size: PAGE * DATA_PAGES_PER_SEGMENT,
    ...statTimes(1),
  });
  state.register(
    1,
    { kind: "file", ino: 2, nlink: 1, size: PAGE, ...statTimes(1) },
    new Uint8Array(PAGE).fill(73),
  );
  backend.attachShared(structuredClone(buffer));
  expect(backend.shared).toBe(state);
  const bytes = new Uint8Array(1);
  expect(backend.shared.read(1, [bytes], 0)).toBe(1);
  expect(bytes[0]).toBe(73);
  expect(() => backend.attachShared(SharedFilesystemState.createBuffer())).toThrow();
});

test("revoking a reader must not repair a live writer's odd epoch", () => {
  const state = new SharedFilesystemState();
  const epoch = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(state.cells, 1, 42);
  Atomics.store(epoch, 0, 1);
  Atomics.store(state.slots, SLOT_WORDS + 8, 41);
  state.revokeOwner(41, epoch);
  expect(Atomics.load(epoch, 0)).toBe(1);
  expect(Atomics.load(state.cells, 1)).toBe(42);
  expect(Atomics.load(state.slots, SLOT_WORDS + 8)).toBe(0);
});

test("revoking the global mutation owner repairs its epoch", () => {
  const state = new SharedFilesystemState();
  const epoch = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(state.cells, 1, 41);
  Atomics.store(epoch, 0, 1);
  state.revokeOwner(41, epoch);
  expect(Atomics.load(epoch, 0)).toBe(2);
  expect(Atomics.load(state.cells, 1)).toBe(0);
});

test("failed growth returns partial page reservations to the allocator", () => {
  const state = new SharedFilesystemState(undefined, PAGE * DATA_PAGES_PER_SEGMENT);
  state.register(0, {
    kind: "file",
    ino: 1,
    nlink: 1,
    size: PAGE * (DATA_PAGES_PER_SEGMENT - 1),
    ...statTimes(1),
  });
  expect(() =>
    state.register(1, { kind: "file", ino: 2, nlink: 1, size: PAGE * 2, ...statTimes(1) }),
  ).toThrow();
  state.register(2, { kind: "file", ino: 3, nlink: 1, size: PAGE, ...statTimes(1) });
  expect(state.resources().usedBytes).toBe(PAGE * DATA_PAGES_PER_SEGMENT);
});

test("namespace edits refresh shared parent directory timestamps", () => {
  const backend = new MemoryBackend();
  const root = backend.execute("preopen", ["/"], new Uint8Array()) as number;
  backend.execute("setTimes", [root, null, ms(1)], new Uint8Array());
  const path = backend.execute("resolve", [root, "child"], new Uint8Array());
  backend.execute("create", [path, "file", true], new Uint8Array());
  expect(backend.shared.stat(root)!.mtime).toBeGreaterThan(ms(1));
});

test("a released directory's shared times still follow later edits below it", () => {
  const backend = new MemoryBackend();
  const call = (operation: string, args: unknown[], data = new Uint8Array()) =>
    backend.execute(operation, args, data);
  const root = call("preopen", ["/"]) as number;
  const dir = call("create", [call("resolve", [root, "d"]), "directory", true]) as number;
  call("setTimes", [dir, null, ms(1)]);
  // The last pin goes, so MemFS forgets the handle while the shared slot stays.
  backend.retain(dir);
  backend.release(dir);
  call("writeFile", ["/d/file"], new Uint8Array([1]));
  expect(backend.shared.stat(dir)!.mtime).toBeGreaterThan(ms(1));
});

test("a directory removed while open drops its copied times at last close", () => {
  const backend = new MemoryBackend();
  const times = (backend as unknown as { directoryTimes: Map<number, unknown> }).directoryTimes;
  const call = (operation: string, args: unknown[]) =>
    backend.execute(operation, args, new Uint8Array());
  const root = call("preopen", ["/"]) as number;
  const dir = call("create", [call("resolve", [root, "gone"]), "directory", true]) as number;
  backend.retain(dir);
  call("removePath", [call("resolve", [root, "gone"]), true]);
  expect(times.has(dir)).toBe(true);
  backend.release(dir);
  expect(times.has(dir)).toBe(false);
});

test("a rejected edit leaves no copied directory times behind", () => {
  const backend = new MemoryBackend();
  const times = (backend as unknown as { directoryTimes: Map<number, unknown> }).directoryTimes;
  backend.execute("preopen", ["/"], new Uint8Array());
  const before = times.size;
  spyOn(
    backend as unknown as { preparePublicationBacking(): unknown },
    "preparePublicationBacking",
  ).mockImplementation(() => {
    throw new Error("injected backing failure");
  });
  for (let attempt = 0; attempt < 5; attempt++)
    expect(() => backend.execute("writeFile", ["/rejected/file"], new Uint8Array([1, 2]))).toThrow(
      "injected backing failure",
    );
  expect(backend.fs.lookup("/rejected")).toBeUndefined();
  expect(times.size).toBe(before);
});

test("a namespace edit syncs only the directories it changed", () => {
  const backend = new MemoryBackend();
  const call = (operation: string, args: unknown[]) =>
    backend.execute(operation, args, new Uint8Array());
  const root = call("preopen", ["/"]) as number;
  const directories = Array.from(
    { length: 200 },
    (_, index) =>
      call("create", [call("resolve", [root, `d${index}`]), "directory", true]) as number,
  );
  const target = directories[7]!;
  const other = directories[8]!;
  call("setTimes", [target, null, ms(1)]);
  call("setTimes", [other, null, ms(1)]);
  const sync = spyOn(backend as unknown as { sync(handle: number): void }, "sync");
  call("create", [call("resolve", [target, "file"]), "file", true]);
  // The new file and its parent, not every directory the backend has seen.
  expect(sync.mock.calls.length).toBeLessThanOrEqual(4);
  expect(backend.shared.stat(target)!.mtime).toBeGreaterThan(ms(1));
  expect(backend.shared.stat(other)!.mtime).toBe(ms(1));
});

test("unlink retains open pages then zeroes and reuses them on last close", () => {
  const state = new SharedFilesystemState(undefined, PAGE * DATA_PAGES_PER_SEGMENT);
  state.register(
    0,
    { kind: "file", ino: 1, nlink: 1, size: PAGE, ...statTimes(1) },
    new Uint8Array(PAGE).fill(91),
  );
  state.retain(0);
  state.unlink(0);
  const bytes = new Uint8Array(1);
  expect(state.read(0, [bytes], 0)).toBe(1);
  expect(bytes[0]).toBe(91);
  state.release(0);
  expect(state.resources().usedBytes).toBe(0);
  state.register(1, { kind: "file", ino: 2, nlink: 1, size: PAGE, ...statTimes(1) });
  const fresh = new Uint8Array(PAGE);
  state.read(1, [fresh], 0);
  expect(fresh).toEqual(new Uint8Array(PAGE));
  expect(state.resources().usedBytes).toBe(PAGE);
});

test("the registered file count follows registration, release and eviction", () => {
  const state = new SharedFilesystemState();
  // Dirty admission shares the header and signals page releases; it must not move the count.
  state.mutate(undefined, undefined, () =>
    state.dirtyAdmission.configure(
      {},
      { maxBytes: 64 * PAGE, maxMetadataBytes: 1 << 20, maxOperations: 1024 },
      0,
    ),
  );
  expect(state.dirtyAdmission.enabled).toBe(true);
  const scanned = () => {
    let count = 0;
    for (let at = SLOT_WORDS; at < state.slots.length; at += SLOT_WORDS)
      if (Atomics.load(state.slots, at)) count++;
    return count;
  };
  const expectCount = (files: number) => {
    expect(scanned()).toBe(files);
    expect(state.resources().files).toBe(files);
    // Another thread's view of the same tree reads the same count.
    expect(new SharedFilesystemState(state.buffer).resources().files).toBe(files);
  };
  expectCount(0);
  const file = (ino: number) => ({
    kind: "file" as const,
    ino,
    nlink: 1,
    size: 3,
    ...statTimes(1),
  });
  state.register(0, file(1), new Uint8Array(3));
  state.register(1, file(2), new Uint8Array(3));
  state.register(2, { kind: "directory", ino: 3, nlink: 2, size: 0, ...statTimes(1) });
  state.register(3, file(4), new Uint8Array(3));
  expectCount(4);
  state.register(0, file(1), new Uint8Array(3));
  expectCount(4);
  state.retain(1);
  state.unlink(1);
  expectCount(4);
  state.release(1);
  expectCount(3);
  const change = state.dirtyAdmission.change;
  expect(state.evict(3, state.revision(3)!)).toBe(true);
  expect(state.dirtyAdmission.change).not.toBe(change);
  expectCount(2);
  state.register(5, file(6), new Uint8Array(3));
  expectCount(3);
  for (let round = 0; round < 50; round++) {
    state.register(10, file(10), new Uint8Array(3));
    expect(state.evict(10, state.revision(10)!)).toBe(true);
  }
  expectCount(3);
});

test("resource snapshots include all allocated SAB bytes and the storage cap", () => {
  const state = new SharedFilesystemState();
  state.register(0, {
    kind: "file",
    ino: 1,
    nlink: 1,
    size: PAGE * DATA_PAGES_PER_SEGMENT,
    ...statTimes(1),
  });
  state.register(1, { kind: "file", ino: 2, nlink: 1, size: PAGE, ...statTimes(1) });
  const resources = state.resources();
  expect(resources.bytes).toBe(state.buffer.byteLength + PAGE * DATA_PAGES_PER_SEGMENT);
  expect(resources.metadataBytes! + resources.poolBytes!).toBe(resources.bytes);
  expect(resources.usedBytes! + resources.freeBytes!).toBe(resources.poolBytes);
  expect(resources.maxBytes).toBe(DEFAULT_SHARED_MAX_BYTES);
});

test("link, unlink and cross-directory rename refresh both affected directory timestamps", () => {
  const backend = new MemoryBackend();
  const call = (operation: string, args: unknown[]) =>
    backend.execute(operation, args, new Uint8Array());
  const root = call("preopen", ["/"]) as number;
  const child = call("create", [call("resolve", [root, "child"]), "directory", true]) as number;
  const file = call("create", [call("resolve", [root, "file"]), "file", true]) as number;
  backend.retain(file);
  call("setTimes", [root, null, ms(1)]);
  expect(call("link", [call("resolve", [root, "file"]), call("resolve", [root, "linked"])])).toBe(
    0,
  );
  expect(backend.shared.stat(root)!.mtime).toBeGreaterThan(ms(1));
  call("setTimes", [root, null, ms(1)]);
  expect(call("removePath", [call("resolve", [root, "linked"]), false])).toBe(0);
  expect(backend.shared.stat(root)!.mtime).toBeGreaterThan(ms(1));
  call("setTimes", [root, null, ms(1)]);
  call("setTimes", [child, null, ms(1)]);
  expect(call("rename", [call("resolve", [root, "file"]), call("resolve", [child, "file"])])).toBe(
    0,
  );
  expect(backend.shared.stat(root)!.mtime).toBeGreaterThan(ms(1));
  expect(backend.shared.stat(child)!.mtime).toBeGreaterThan(ms(1));
});

test("stat rejects a metadata slot reused while waiting for its file lock", () => {
  const state = new SharedFilesystemState();
  state.register(0, { kind: "file", ino: 1, nlink: 1, size: 0, ...statTimes(1) });
  const slot = state.fileSlot(0);
  const lock = slot * SLOT_WORDS + 8;
  Atomics.store(state.slots, lock, 42);
  state.onContention = () => {
    Atomics.store(state.slots, lock, 0);
    state.unlink(0);
    state.register(32767, { kind: "file", ino: 2, nlink: 1, size: 0, ...statTimes(2) });
    state.onContention = undefined;
  };
  expect(state.stat(0)).toBeUndefined();
  expect(state.fileSlot(32767)).toBe(slot);
  expect(state.stat(32767)).toMatchObject({ ino: 2, mtime: ms(2) });
});

test.each([0, 127])("a freed handle %i lookup skips unrelated resident nodes", (handle) => {
  const state = new SharedFilesystemState();
  for (let index = 0; index < 256; index++)
    state.register(index, { kind: "file", ino: index + 1, nlink: 1, size: 0, ...statTimes(1) });
  const observer = new SharedFilesystemState(state.buffer);
  state.unlink(handle);
  const loads = spyOn(Atomics, "load");
  try {
    expect(observer.revision(handle)).toBeUndefined();
    expect(loads.mock.calls.filter(([array]) => Object.is(array, observer.slots))).toHaveLength(1);
  } finally {
    loads.mockRestore();
  }
});

test("reusing collision tombstones preserves live slots and reincarnated handles", () => {
  const state = new SharedFilesystemState();
  const stride = state.slots.length / SLOT_WORDS - 1;
  const register = (handle: number) =>
    state.register(handle, { kind: "file", ino: handle + 1, nlink: 1, size: 0, ...statTimes(1) });
  register(0);
  register(stride);
  register(stride * 2);
  const liveSlot = state.fileSlot(stride * 2);
  state.unlink(stride);
  register(stride * 2);
  expect(state.fileSlot(stride * 2)).toBe(liveSlot);
  expect(state.resources().files).toBe(2);
  state.unlink(0);
  register(stride);
  expect(state.fileSlot(stride)).toBe(1);
  expect(state.fileSlot(stride * 2)).toBe(liveSlot);
  const previous = state.revision(stride * 2)!;
  state.unlink(stride * 2);
  expect(state.revision(stride * 2)).toBeUndefined();
  register(stride * 2);
  expect(state.fileSlot(stride * 2)).toBe(2);
  expect(state.revision(stride * 2)).toBeGreaterThan(previous);
  register(stride * 2);
  expect(state.resources().files).toBe(2);
  state.unlink(stride);
  state.unlink(stride * 2);
  expect(state.registeredHandles()).toEqual([]);
});

test("registered handles stay exact, in slot order, as slots are freed and reused", () => {
  const state = new SharedFilesystemState();
  const stride = state.slots.length / SLOT_WORDS - 1;
  const register = (target: SharedFilesystemState, handle: number) =>
    target.register(handle, { kind: "file", ino: handle + 1, nlink: 1, size: 0, ...statTimes(1) });
  for (const handle of [40, 7, 900, 3]) register(state, handle);
  expect(state.registeredHandles()).toEqual([3, 7, 40, 900]);
  state.unlink(7);
  register(state, 12);
  // 12 + stride collides with 12 and takes the next free slot after it.
  register(state, 12 + stride);
  expect(state.registeredHandles()).toEqual([3, 12, 12 + stride, 40, 900]);
  state.unlink(12);
  register(state, 7);
  expect(state.registeredHandles()).toEqual([3, 7, 12 + stride, 40, 900]);
  // Another state over the same table registers without this one's index knowing.
  const sibling = new SharedFilesystemState(state.buffer);
  register(sibling, 500);
  expect(state.registeredHandles()).toEqual([3, 7, 12 + stride, 40, 500, 900]);
  sibling.unlink(40);
  expect(state.registeredHandles()).toEqual([3, 7, 12 + stride, 500, 900]);
});

test("host namespace edits do not probe shared metadata for an unregistered root", () => {
  const backend = new MemoryBackend();
  const bytes = new Uint8Array();
  for (let index = 0; index < 16; index++) backend.execute("writeFile", [`/node-${index}`], bytes);
  const root = backend.fs.handleForNode(backend.fs.root);
  expect(backend.shared.stat(root)).toBeUndefined();
  const identity = spyOn(backend.shared, "identity");
  const stat = spyOn(backend.shared, "stat");
  const update = spyOn(backend.shared, "updateIdentity");
  try {
    expect(backend.execute("remove", ["/node-0"], bytes)).toBe(true);
    expect(identity.mock.calls.some(([handle]) => handle === root)).toBe(false);
    expect(stat.mock.calls.some(([handle]) => handle === root)).toBe(false);
    expect(update.mock.calls.some(([handle]) => handle === root)).toBe(false);
  } finally {
    identity.mockRestore();
    stat.mockRestore();
    update.mockRestore();
  }
});

test("a borrowing backend keeps registered parent identities and timestamps current", () => {
  const clock = spyOn(Date, "now").mockReturnValue(10_000);
  try {
    const owner = new MemoryBackend();
    const bytes = new Uint8Array();
    const root = owner.execute("preopen", ["/"], bytes);
    if (typeof root !== "number") throw new Error("preopen did not return a handle");
    const alias = new MemoryBackend(undefined, undefined, owner);
    alias.execute("setTimes", [root, null, ms(1)], bytes);
    const previous = alias.shared.identity(root)!;
    alias.execute("writeFile", ["/child"], bytes);
    expect(owner.shared.stat(root)!.mtime).toBeGreaterThan(ms(1));
    expect(owner.shared.identity(root)!.version).toBeGreaterThan(previous.version);
    expect(owner.identity(root)).toEqual(owner.shared.identity(root)!);
  } finally {
    clock.mockRestore();
  }
});
