import { expect, test } from "bun:test";
import { SharedFilesystemState } from "../fs/shared";
import { DATA_PAGE_BYTES as PAGE } from "../fs/storage-geometry";

test("geometric growth reserves page tables only for storage it can allocate", () => {
  const maxBytes = 1024 * 1024 * 1024;
  const totalPages = maxBytes / PAGE;
  const firstPages = totalPages / 2;
  const singles = 4093;
  const lastPages = totalPages - 2 - firstPages - singles;
  const state = new SharedFilesystemState(undefined, maxBytes);
  state.register(0, { kind: "file", ino: 1, nlink: 1, size: PAGE * firstPages, mtime: 1 });
  for (let handle = 1; handle <= singles; handle++) {
    state.register(handle, { kind: "file", ino: handle + 1, nlink: 1, size: PAGE, mtime: 1 });
  }
  state.register(4094, { kind: "file", ino: 4095, nlink: 1, size: PAGE * lastPages, mtime: 1 });
  expect(state.resources().freeBytes).toBe(PAGE * 2);
  state.grow(0, PAGE * (firstPages + 1));
  expect(state.info(0)?.capacity).toBe(PAGE * (firstPages + 1));
  expect(state.resources().usedBytes).toBe(maxBytes - PAGE);
}, 30000);
