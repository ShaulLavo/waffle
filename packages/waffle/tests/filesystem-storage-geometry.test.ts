import { expect, test } from "bun:test";
import { SharedFilesystemState, SLOT_WORDS } from "../fs/shared";
import { CONNECTION_SHARED_BYTES, PAGE, createFilesystemIdentity } from "../fs/protocol";
import { MAX_SHARED_FILE_BYTES } from "../fs/shared-capacity";

const storagePage = 16 * 1024;
const segmentBytes = 16 * 1024 * 1024;
const rootBytes = 88_098_640;
const stat = (size: number) => ({ kind: "file" as const, ino: 1, nlink: 1, size, mtime: 1 });

test("one-byte files consume 16 KiB storage pages, not 64 KiB transport pages", () => {
  const state = new SharedFilesystemState();
  state.register(1, stat(1), new Uint8Array([91]));
  expect(state.info(1)?.capacity).toBe(storagePage);
  expect(state.resources().usedBytes).toBe(storagePage);
  expect(PAGE).toBe(65536);
});

test("ordinary and connected roots have the exact complete storage layout", () => {
  const state = new SharedFilesystemState();
  const identity = createFilesystemIdentity();
  expect(state.buffer.byteLength).toBe(rootBytes);
  expect(identity.shared.byteLength).toBe(rootBytes);
  expect(CONNECTION_SHARED_BYTES).toBe(rootBytes);
  expect(state.cells.byteLength).toBe(320);
  expect(state.owners.byteOffset).toBe(320);
  expect(state.owners.length).toBe(98304);
  expect(state.slots.byteOffset).toBe(393536);
  expect(state.slots.length).toBe(32768 * SLOT_WORDS);
  expect(state.pages.byteOffset).toBe(37226304);
  expect(state.pages.length).toBe(33152 * 256);
  expect(state.watch.cells.byteOffset).toBe(71173952);
  expect(state.buffer.byteLength - segmentBytes).toBe(71321424);
});

test("last logical file address maps independently of physical segment geometry", () => {
  const state = new SharedFilesystemState();
  const handle = 32766;
  state.register(handle, stat(MAX_SHARED_FILE_BYTES), undefined, false);
  const slot = state.fileSlot(handle);
  expect(slot).toBe(32767);
  const roots = new Int32Array(state.buffer, 3539264, 32768 * 256);
  const finalLogical = MAX_SHARED_FILE_BYTES / storagePage - 1;
  const root = slot * 256 + Math.floor(finalLogical / 256);
  expect(root).toBe(8388607);
  expect(finalLogical % 256).toBe(255);
  roots[root] = 1;
  state.pages[255] = 1;
  state.owners[0] = slot;
  state.slots[slot * SLOT_WORDS + 5] = 65536;
  state.slots[slot * SLOT_WORDS + 11]! |= 1;
  new Uint8Array(state.buffer)[71321424 + storagePage - 1] = 93;
  const out = new Uint8Array(1);
  expect(state.read(handle, [out], MAX_SHARED_FILE_BYTES - 1)).toBe(1);
  expect(out[0]).toBe(93);
  expect(() => state.grow(handle, MAX_SHARED_FILE_BYTES + 1)).toThrow("file is too large");
  expect(state.info(handle)?.size).toBe(MAX_SHARED_FILE_BYTES);
});

test("two connections cross storage pages and true 4 MiB logical leaves", () => {
  const identity = createFilesystemIdentity();
  const state = new SharedFilesystemState(
    identity.shared,
    identity.maxBytes,
    undefined,
    identity.segments,
  );
  const peer = new SharedFilesystemState(
    identity.shared,
    identity.maxBytes,
    undefined,
    identity.segments,
  );
  const leaf = 256 * storagePage;
  state.register(1, stat(leaf + storagePage));
  const input = Uint8Array.from({ length: PAGE }, (_, index) => index % 251);
  for (const offset of [storagePage - 3, leaf - 3]) {
    state.grow(1, offset + input.length);
    state.write(1, [input], offset);
    const output = new Uint8Array(input.length);
    expect(peer.read(1, [output], offset)).toBe(input.length);
    expect(output).toEqual(input);
    expect(peer.write(1, [new Uint8Array([91, 92])], offset + 2)).toBe(2);
    expect(state.snapshot(1)!.data.slice(offset + 2, offset + 4)).toEqual(new Uint8Array([91, 92]));
  }
});

test("physical pages cross 16 MiB separately from logical leaves and reuse zeroed holes", () => {
  const identity = createFilesystemIdentity(undefined, segmentBytes * 2);
  const state = new SharedFilesystemState(
    identity.shared,
    identity.maxBytes,
    undefined,
    identity.segments,
  );
  const peer = new SharedFilesystemState(
    identity.shared,
    identity.maxBytes,
    undefined,
    identity.segments,
  );
  state.register(1, stat(segmentBytes - storagePage));
  state.register(2, { ...stat(storagePage * 2), ino: 2 });
  const slot = state.fileSlot(2);
  const roots = new Int32Array(state.buffer, 3539264, 32768 * 256);
  const block = roots[slot * 256]! - 1;
  expect(Array.from(state.pages.subarray(block * 256, block * 256 + 2))).toEqual([1024, 1025]);
  expect(identity.segments.map((buffer) => buffer.byteLength)).toEqual([segmentBytes]);
  state.write(2, [new Uint8Array([91, 92, 93])], storagePage - 1);
  const out = new Uint8Array(3);
  expect(peer.read(2, [out], storagePage - 1)).toBe(3);
  expect(out).toEqual(new Uint8Array([91, 92, 93]));
  state.unlink(1);
  state.register(3, { ...stat(1), ino: 3 });
  expect(state.owners[0]).toBe(state.fileSlot(3));
  expect(peer.read(3, [out], 0)).toBe(1);
  expect(out[0]).toBe(0);
  expect(state.resources().usedBytes).toBe(3 * storagePage);
});

test("the final physical page has a reader counter and stays pinned until release", () => {
  const identity = createFilesystemIdentity(undefined, undefined, { workspace: true });
  const state = new SharedFilesystemState(
    identity.shared,
    identity.maxBytes,
    undefined,
    identity.segments,
    undefined,
    identity.publication!.buffers,
  );
  expect(identity.publication!.buffers.pageReaders!.byteLength).toBe(393216);
  state.register(1, stat(storagePage));
  const slot = state.fileSlot(1);
  const roots = new Int32Array(state.buffer, 3539264, 32768 * 256);
  const entry = (roots[slot * 256]! - 1) * 256;
  const physical = 98303;
  const segment = Math.floor(physical / 1024);
  const local = (physical % 1024) * storagePage;
  expect(segment).toBe(95);
  expect(local + storagePage).toBe(segmentBytes);
  const backing = identity.segments[segment - 1]!;
  Reflect.apply(Reflect.get(backing, "grow"), backing, [segmentBytes]);
  state.owners[0] = 0;
  state.owners[physical] = slot;
  state.pages[entry] = physical + 1;
  new Uint8Array(backing)[local + storagePage - 1] = 94;
  const version = state.retainVersionPages(1, 0, storagePage);
  try {
    expect(state.readerPinBytes()).toBe(storagePage);
    expect(version.read(storagePage - 1, 1)[0]).toBe(94);
    expect(new Int32Array(identity.publication!.buffers.pageReaders!)[physical]).toBe(1);
    state.unlink(1);
    expect(version.read(storagePage - 1, 1)[0]).toBe(94);
    expect(state.resources().usedBytes).toBe(storagePage);
  } finally {
    version.release();
  }
  expect(state.resources().usedBytes).toBe(0);
  expect(state.readerPinBytes()).toBe(0);
  expect(new Uint8Array(backing)[local + storagePage - 1]).toBe(0);
});

test("a bounded size histogram allocates each nonempty file by storage pages", () => {
  const state = new SharedFilesystemState();
  const histogram = [
    { bytes: 0, files: 16 },
    { bytes: 1, files: 1024 },
    { bytes: 16384, files: 16 },
    { bytes: 16385, files: 16 },
    { bytes: 65536, files: 16 },
    { bytes: 65537, files: 16 },
  ];
  let handle = 0;
  for (const bucket of histogram) {
    for (let index = 0; index < bucket.files; index++) {
      state.register(handle, { ...stat(bucket.bytes), ino: handle + 1 });
      handle++;
    }
  }
  const used = histogram.reduce(
    (sum, bucket) => sum + Math.ceil(bucket.bytes / storagePage) * storagePage * bucket.files,
    0,
  );
  const previous = histogram.reduce(
    (sum, bucket) => sum + Math.ceil(bucket.bytes / PAGE) * PAGE * bucket.files,
    0,
  );
  expect(state.resources().usedBytes).toBe(used);
  expect(used).toBe(19_922_944);
  expect(previous).toBe(72_351_744);
});

test("slot zero stays reserved and all 32,767 usable node slots remain available", () => {
  const state = new SharedFilesystemState();
  for (let handle = 0; handle < 32767; handle++)
    state.register(handle, { ...stat(0), ino: handle + 1 });
  expect(state.resources().files).toBe(32767);
  expect(state.slots[0]).toBe(0);
  expect(() => state.register(32767, stat(0))).toThrow("identity table exhausted");
});
