import { expect, test } from "bun:test";
import { SharedFilesystemState, SLOT_WORDS } from "../fs/shared";
import {
  CONNECTION_SHARED_BYTES,
  PAGE,
  createFilesystemIdentity,
} from "../fs/protocol";
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
