import { expect, test } from "bun:test";
import { SharedFilesystemState, SLOT_WORDS } from "../fs/shared";
import { CONNECTION_SHARED_BYTES, PAGE, createFilesystemIdentity } from "../fs/protocol";
import { MAX_SHARED_FILE_BYTES } from "../fs/shared-capacity";
import { TABLE_BLOCKS } from "../fs/storage-geometry";

const storagePage = 4 * 1024;
const segmentBytes = 16 * 1024 * 1024;
const rootBytes = 33_289_256;
const metadataBytes = 16_512_040;
const blockCount = 40_758;
const blockWords = 64;
const rootCellBase = blockCount * blockWords;
const rootWords = 8;
const physicalHint = 27;
const tableHint = 28;
const pinnedPages = 29;
const stat = (size: number, ino = 1) => ({ kind: "file" as const, ino, nlink: 1, size, mtime: 1 });

interface StateInternals {
  tableOwners: Int32Array;
  pageAt(slot: number, logical: number): number;
  reservePageTables(slot: number, from: number, needed: number): void;
  trimPageTables(slot: number, needed: number): void;
}
const internals = (state: SharedFilesystemState) => state as unknown as StateInternals;
const usedBlocks = (state: SharedFilesystemState) =>
  internals(state).tableOwners.reduce((count, owner) => count + (owner !== 0 ? 1 : 0), 0);
const connected = (maxBytes?: number) => {
  const identity = createFilesystemIdentity(undefined, maxBytes);
  const open = () =>
    new SharedFilesystemState(
      identity.shared,
      identity.maxBytes,
      undefined,
      identity.segments,
    );
  return { identity, state: open(), peer: open() };
};

test("one-byte files consume 4 KiB storage pages, not 64 KiB transport pages", () => {
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
  expect(state.owners.length).toBe(393216);
  expect(state.slots.byteOffset).toBe(1573184);
  expect(state.slots.length).toBe(32768 * SLOT_WORDS);
  expect(internals(state).tableOwners.byteOffset).toBe(4718912);
  expect(internals(state).tableOwners.length).toBe(blockCount);
  expect(state.pages.byteOffset).toBe(4881944);
  expect(state.pages.length).toBe(2_870_656);
  expect(state.watch.cells.byteOffset).toBe(16364568);
  expect(state.buffer.byteLength - segmentBytes).toBe(metadataBytes);
});

test("the block pool covers the worst distribution of files and data", () => {
  const physical = (1536 * 1024 * 1024) / storagePage;
  const tailFiles = Math.floor(physical / (7 * 64 + 1));
  expect(tailFiles).toBe(875);
  expect(TABLE_BLOCKS).toBe(
    32768 + Math.ceil(physical / 64) + 2 * tailFiles + Math.ceil(physical / 4096),
  );
  expect(TABLE_BLOCKS).toBe(blockCount);
});

test("mapping blocks follow direct leaves and the first tail path", () => {
  const state = new SharedFilesystemState();
  state.register(1, stat(1));
  expect(usedBlocks(state)).toBe(1);
  state.unlink(1);
  expect(usedBlocks(state)).toBe(0);
  state.register(2, stat(448 * storagePage, 2));
  expect(usedBlocks(state)).toBe(7);
  state.unlink(2);
  state.register(3, stat(449 * storagePage, 3));
  expect(usedBlocks(state)).toBe(8 + 1 + 1);
  state.unlink(3);
  expect(usedBlocks(state)).toBe(0);
});

test("two connections cross leaf, direct-tail and tail-branch boundaries", () => {
  const { state, peer } = connected();
  state.register(1, stat(0));
  const input = Uint8Array.from({ length: PAGE }, (_, index) => index % 251);
  for (const boundary of [262_144, 1_835_008, 18_612_224]) {
    const offset = boundary - 3;
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
  const { identity, state, peer } = connected(segmentBytes * 2);
  state.register(1, stat(segmentBytes - storagePage));
  state.register(2, stat(storagePage * 2, 2));
  const slot = state.fileSlot(2);
  const block = state.pages[rootCellBase + slot * rootWords]! - 1;
  expect(Array.from(state.pages.subarray(block * blockWords, block * blockWords + 2))).toEqual([
    4096, 4097,
  ]);
  expect(identity.segments.map((buffer) => buffer.byteLength)).toEqual([segmentBytes]);
  state.write(2, [new Uint8Array([91, 92, 93])], storagePage - 1);
  const out = new Uint8Array(3);
  expect(peer.read(2, [out], storagePage - 1)).toBe(3);
  expect(out).toEqual(new Uint8Array([91, 92, 93]));
  state.unlink(1);
  state.register(3, stat(1, 3));
  expect(state.owners[0]).toBe(state.fileSlot(3));
  expect(peer.read(3, [out], 0)).toBe(1);
  expect(out[0]).toBe(0);
  expect(state.resources().usedBytes).toBe(3 * storagePage);
});

test("the last logical file address maps through real reservation and trims completely", () => {
  const state = new SharedFilesystemState();
  const handle = 32766;
  state.register(handle, stat(MAX_SHARED_FILE_BYTES), undefined, false);
  state.register(0, stat(1, 2));
  const slot = state.fileSlot(handle);
  expect(slot).toBe(32767);
  const adjacent = rootCellBase + (slot - 1) * rootWords;
  state.pages[adjacent] = 12345;
  const before = usedBlocks(state);
  const hidden = internals(state);
  const finalLogical = MAX_SHARED_FILE_BYTES / storagePage - 1;
  hidden.reservePageTables(slot, 0, finalLogical + 1);
  expect(usedBlocks(state) - before).toBe(4096 + 1 + 64);
  expect(state.pages[rootCellBase + slot * rootWords + 7]).toBeGreaterThan(0);
  const entry = hidden.pageAt(slot, finalLogical);
  expect(entry).toBeLessThan(rootCellBase);
  expect(entry % blockWords).toBe(63);
  const physical = state.owners.indexOf(0);
  state.pages[entry] = physical + 1;
  state.owners[physical] = slot;
  state.slots[slot * SLOT_WORDS + 5] = finalLogical + 1;
  state.slots[slot * SLOT_WORDS + 11]! |= 1;
  new Uint8Array(state.buffer)[metadataBytes + physical * storagePage + storagePage - 1] = 93;
  const out = new Uint8Array(1);
  expect(state.read(handle, [out], MAX_SHARED_FILE_BYTES - 1)).toBe(1);
  expect(out[0]).toBe(93);
  expect(() => state.grow(handle, MAX_SHARED_FILE_BYTES + 1)).toThrow("file is too large");
  expect(state.info(handle)?.size).toBe(MAX_SHARED_FILE_BYTES);
  state.pages[entry] = 0;
  state.owners[physical] = 0;
  state.slots[slot * SLOT_WORDS + 5] = 0;
  hidden.trimPageTables(slot, 0);
  expect(usedBlocks(state)).toBe(before);
  expect(state.pages[adjacent]).toBe(12345);
  state.pages[adjacent] = 0;
});

test("a tail fits among a dense population of one-page files at the slot cap", () => {
  const state = new SharedFilesystemState();
  for (let handle = 0; handle < 32767; handle++) state.register(handle, stat(1, handle + 1));
  expect(usedBlocks(state)).toBe(32767);
  state.grow(0, 449 * storagePage);
  expect(usedBlocks(state)).toBe(32767 + 7 + 1 + 1);
  expect(() => state.register(32767, stat(1, 32768))).toThrow("identity table exhausted");
});

test("the allocator hints follow frees and reuse", () => {
  const state = new SharedFilesystemState();
  for (let handle = 1; handle <= 3; handle++) state.register(handle, stat(1, handle));
  expect(state.cells[physicalHint]).toBe(3);
  expect(state.cells[tableHint]).toBe(3);
  state.write(1, [new Uint8Array([7])], 0);
  state.unlink(1);
  expect(state.cells[physicalHint]).toBe(0);
  expect(state.cells[tableHint]).toBe(0);
  state.register(4, stat(1, 4));
  expect(state.owners[0]).toBe(state.fileSlot(4));
  const out = new Uint8Array(1);
  expect(state.read(4, [out], 0)).toBe(1);
  expect(out[0]).toBe(0);
  expect(state.cells[physicalHint]).toBe(1);
  expect(state.cells[tableHint]).toBe(1);
});

test("a stale-high hint cannot report false exhaustion", () => {
  const state = new SharedFilesystemState(undefined, segmentBytes);
  state.register(1, stat(1));
  state.unlink(1);
  state.cells[physicalHint] = 4096;
  state.cells[tableHint] = blockCount;
  state.register(2, stat(1, 2));
  expect(state.owners[0]).toBe(state.fileSlot(2));
  expect(internals(state).tableOwners[0]).toBe(state.fileSlot(2));
});

for (const { free, failedAt } of [
  { free: 0, failedAt: "top" },
  { free: 1, failedAt: "branch" },
  { free: 2, failedAt: "first tail leaf" },
]) {
  test(`table exhaustion at the ${failedAt} unwinds the new tail path`, () => {
    const state = new SharedFilesystemState();
    const directBytes = 448 * storagePage;
    state.register(1, stat(directBytes));
    const sentinel = new Uint8Array([11, 22, 33]);
    state.write(1, [sentinel], directBytes - 3);
    const slot = state.fileSlot(1);
    const owners = internals(state).tableOwners;
    const blocks = state.cells[tableHint]!;
    const pages = state.cells[physicalHint]!;
    const physicalOwners = Array.from(state.owners);
    owners.fill(99, blocks + free);
    const zeroCells = () =>
      state.pages.subarray(blocks * blockWords, (blocks + free) * blockWords).every((v) => v === 0);
    let failure: unknown;
    try {
      state.grow(1, directBytes + 1);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ errno: 51 });
    expect(state.pages[rootCellBase + slot * rootWords + 7]).toBe(0);
    expect(Array.from(owners.subarray(blocks, blocks + free))).toEqual(new Array(free).fill(0));
    expect(zeroCells()).toBe(true);
    expect(state.cells[physicalHint]).toBe(pages);
    expect(state.cells[tableHint]).toBe(blocks);
    expect(Array.from(state.owners)).toEqual(physicalOwners);
    expect(state.info(1)?.capacity).toBe(directBytes);
    expect(state.resources().usedBytes).toBe(directBytes);
    expect(state.snapshot(1)!.data.slice(directBytes - 3)).toEqual(sentinel);
    owners.fill(0, blocks);
    state.grow(1, directBytes + 1);
    expect(state.info(1)!.capacity).toBeGreaterThan(directBytes);
    expect(state.pages[rootCellBase + slot * rootWords + 7]).toBeGreaterThan(0);
    expect(state.snapshot(1)!.data.slice(directBytes - 3)).toEqual(sentinel);
  });
}

test("the pinned page count follows distinct reader-held physical pages", () => {
  const identity = createFilesystemIdentity(undefined, undefined, { workspace: true });
  const state = new SharedFilesystemState(
    identity.shared,
    identity.maxBytes,
    undefined,
    identity.segments,
    undefined,
    identity.publication!.buffers,
  );
  const counters = new Int32Array(identity.publication!.buffers.pageReaders!);
  const held = () => counters.reduce((count, value) => count + (value > 0 ? 1 : 0), 0);
  const expectPinned = (pages: number) => {
    expect(state.cells[pinnedPages]).toBe(pages);
    expect(held()).toBe(pages);
    expect(state.readerPinBytes()).toBe(pages * storagePage);
  };
  state.register(1, stat(3 * storagePage));
  expectPinned(0);
  const whole = state.retainVersionPages(1, 0, 3 * storagePage);
  expectPinned(3);
  const first = state.retainVersionPages(1, 0, storagePage);
  expectPinned(3);
  state.write(1, [new Uint8Array([1])], 0);
  expectPinned(3);
  expect(first.read(0, 1)[0]).toBe(0);
  whole.release();
  expectPinned(1);
  whole.release();
  expectPinned(1);
  first.release();
  expectPinned(0);
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
  expect(identity.publication!.buffers.pageReaders!.byteLength).toBe(1_572_864);
  state.register(1, stat(storagePage));
  const slot = state.fileSlot(1);
  const entry = (state.pages[rootCellBase + slot * rootWords]! - 1) * blockWords;
  const physical = 393215;
  const segment = Math.floor(physical / 4096);
  const local = (physical % 4096) * storagePage;
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
    { bytes: 4096, files: 16 },
    { bytes: 4097, files: 16 },
    { bytes: 65536, files: 16 },
    { bytes: 65537, files: 16 },
  ];
  let handle = 0;
  for (const bucket of histogram) {
    for (let index = 0; index < bucket.files; index++) {
      state.register(handle, stat(bucket.bytes, handle + 1));
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
  expect(used).toBe(6_553_600);
  expect(previous).toBe(72_351_744);
});

test("slot zero stays reserved and all 32,767 usable node slots remain available", () => {
  const state = new SharedFilesystemState();
  for (let handle = 0; handle < 32767; handle++)
    state.register(handle, stat(0, handle + 1));
  expect(state.resources().files).toBe(32767);
  expect(state.slots[0]).toBe(0);
  expect(() => state.register(32767, stat(0))).toThrow("identity table exhausted");
});
