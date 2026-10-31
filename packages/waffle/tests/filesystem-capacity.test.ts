import { expect, test } from "bun:test";
import { SharedFilesystemState } from "../fs/shared";
import { PAGE } from "../fs/protocol";

test("geometric growth reserves page tables only for storage it can allocate", () => {
  const maxBytes = 1024 * 1024 * 1024;
  const state = new SharedFilesystemState(undefined, maxBytes);
  state.register(0, { kind: "file", ino: 1, nlink: 1, size: PAGE * 8192, mtime: 1 });
  for (let handle = 1; handle <= 4093; handle++) {
    state.register(handle, { kind: "file", ino: handle + 1, nlink: 1, size: PAGE, mtime: 1 });
  }
  state.register(4094, { kind: "file", ino: 4095, nlink: 1, size: PAGE * 4097, mtime: 1 });
  expect(state.resources().freeBytes).toBe(PAGE * 2);
  state.grow(0, PAGE * 8193);
  expect(state.info(0)?.capacity).toBe(PAGE * 8193);
  expect(state.resources().usedBytes).toBe(maxBytes - PAGE);
}, 30000);
