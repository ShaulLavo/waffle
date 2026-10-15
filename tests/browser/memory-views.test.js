import { expect, test } from "bun:test";
import { memoryViews } from "../src/memory-views.js";

for (const shared of [false, true]) {
  for (const fallback of [false, true]) {
    test(`memory views survive growth (shared=${shared}, fallback=${fallback})`, () => {
      checkGrowth(shared, fallback);
    });
  }
}

function checkGrowth(shared, fallback) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared });
  if (fallback) Object.defineProperty(memory, "toResizableBuffer", { value: undefined });
  const views = memoryViews(memory);
  const bytes = views.bytes();
  const view = views.view();
  const persistent = typeof memory.toResizableBuffer === "function";
  expect(memoryViews(memory)).toBe(views);
  bytes[42] = 123;
  const copy = bytes.slice(40, 44);
  expect(() => views.range(65535, 2)).toThrow(RangeError);
  memory.grow(1);
  expect(views.bytes().length).toBe(2 * 65536);
  expect(views.view().byteLength).toBe(2 * 65536);
  expect(views.bytes() === bytes).toBe(persistent);
  expect(views.view() === view).toBe(persistent);
  expect(views.view().getUint8(42)).toBe(123);
  views.view().setUint32(65536 + 8, 0x12345678, true);
  expect(views.bytes()[65536 + 8]).toBe(0x78);
  expect(Array.from(views.range(65544, 4))).toEqual([0x78, 0x56, 0x34, 0x12]);
  memory.grow(0);
  expect(views.view().getUint32(65536 + 8, true)).toBe(0x12345678);
  expect(Array.from(copy)).toEqual([0, 0, 123, 0]);
  expect(copy.byteLength).toBe(4);
}
