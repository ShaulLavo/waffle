import { expect, test } from "bun:test";
import { memoryViews } from "../core/memory-views.ts";

test("forbidden conversion never reads the conversion hook and refreshes after native shared growth", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 3, shared: true });
  Object.defineProperty(memory, "toResizableBuffer", {
    get() {
      throw new Error("forbidden conversion hook was read");
    },
  });
  const views = memoryViews(memory, "forbidden");
  const old = views.bytes();
  views.view().setUint32(8, 42, true);
  expect(memory.grow(1)).toBe(1);
  expect(views.bytes().buffer).toBe(memory.buffer);
  expect(views.bytes()).not.toBe(old);
  expect(views.view().getUint32(8, true)).toBe(42);
  views.range(65536, 4).set([1, 2, 3, 4]);
  expect(Array.from(new Uint8Array(memory.buffer, 65536, 4))).toEqual([1, 2, 3, 4]);
  expect(old.byteLength).toBe(65536);
  expect(() => views.range(131072, 1)).toThrow(RangeError);
  expect(memory.grow(1)).toBe(2);
  expect(() => memory.grow(1)).toThrow(RangeError);
  expect(views.bytes().byteLength).toBe(3 * 65536);
});

test("a conversion-enabled cache cannot select the forbidden helper", () => {
  let conversions = 0;
  const converted = new SharedArrayBuffer(65536);
  const memory = Object.assign(new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }), {
    toResizableBuffer() {
      conversions++;
      return converted;
    },
  });
  const ordinary = memoryViews(memory);
  const fixed = memoryViews(memory, "forbidden");
  expect(ordinary.bytes().buffer).toBe(converted);
  expect(fixed.bytes().buffer).toBe(memory.buffer);
  expect(memoryViews(memory)).toBe(ordinary);
  expect(memoryViews(memory, "forbidden")).toBe(fixed);
  expect(conversions).toBe(1);
  memory.grow(1);
  expect(fixed.view().byteLength).toBe(131072);
});

test("ordinary unshared views retain identity refresh after grow zero detaches the old buffer", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  const views = memoryViews(memory, "forbidden");
  const old = views.bytes();
  expect(memory.grow(0)).toBe(1);
  expect(views.bytes().buffer).toBe(memory.buffer);
  expect(views.bytes()).not.toBe(old);
  expect(old.byteLength).toBe(0);
});
