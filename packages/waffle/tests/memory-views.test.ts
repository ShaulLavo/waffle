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

function rangeResult(create: () => Uint8Array) {
  try {
    const bytes = create();
    return { byteOffset: bytes.byteOffset, byteLength: bytes.byteLength };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { constructor: error.constructor, message: error.message };
  }
}

function fixedModeCoercion(shared: boolean, provider: boolean) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared });
  const views = memoryViews(memory);
  if (!("toFixedLengthBuffer" in memory) || typeof memory.toFixedLengthBuffer !== "function")
    throw Error("required positive guard: native fixed-buffer conversion must arm");
  memory.toFixedLengthBuffer();
  const length = {
    valueOf() {
      memory.grow(1);
      return 65537;
    },
  };
  return rangeResult(() =>
    provider
      ? Reflect.apply(views.range, views, [0, length])
      : Reflect.construct(Uint8Array, [memory.buffer, 0, length]),
  );
}

for (const shared of [false, true])
  test(`range coercion preserves the fixed buffer captured before reentrant growth, shared=${shared}`, () => {
    const native = fixedModeCoercion(shared, false);
    expect(native).toMatchObject({ constructor: RangeError });
    expect(fixedModeCoercion(shared, true)).toEqual(native);
  });

for (const shared of [false, true])
  test(`kept-buffer ranges preserve native bounds and coercions, shared=${shared}`, () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared });
    const views = memoryViews(memory);
    const buffer = views.bytes().buffer;
    const resize = Object.getOwnPropertyDescriptor(
      shared ? SharedArrayBuffer.prototype : ArrayBuffer.prototype,
      shared ? "growable" : "resizable",
    )!.get!;
    expect(Reflect.apply(resize, buffer, [])).toBe(true);
    const cases: unknown[][] = [
      [0, 0],
      [65536, 0],
      [65536, 1],
      [65535, 2],
      [-1, 1],
      [0, -1],
      [Infinity, 0],
      [0, Infinity],
      [NaN, 2],
      [1.9, 2.9],
      [undefined, undefined],
      [null, null],
      ["1.9", "2.9"],
      [1n, 1],
      [0, 1n],
      [Symbol("offset"), 1],
      [0, Symbol("length")],
    ];
    const nativeArgs: unknown[] = [buffer];
    for (const args of cases) {
      const native = rangeResult(() => Reflect.construct(Uint8Array, nativeArgs.concat(args)));
      expect(rangeResult(() => Reflect.apply(views.range, views, args))).toEqual(native);
    }
    const calls: string[] = [];
    const offset = {
      valueOf() {
        calls.push("offset");
        return 65536;
      },
    };
    const length = {
      valueOf() {
        calls.push("length");
        memory.grow(1);
        return 1;
      },
    };
    const bytes = Reflect.apply(views.range, views, [offset, length]);
    expect(calls).toEqual(["offset", "length"]);
    expect(bytes.buffer).toBe(buffer);
    expect(bytes.byteOffset).toBe(65536);
    expect(bytes.byteLength).toBe(1);
    memory.grow(0);
    expect(views.bytes().buffer).toBe(buffer);
    expect(views.range(131071, 1).buffer).toBe(buffer);
    expect(() => views.range(131072, 1)).toThrow(RangeError);
  });

for (const shared of [false, true])
  test(`ranges keep native behavior when memory switches back to fixed buffers, shared=${shared}`, () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared });
    const views = memoryViews(memory);
    const kept = views.bytes().buffer;
    if (!("toFixedLengthBuffer" in memory) || typeof memory.toFixedLengthBuffer !== "function")
      throw Error("required positive guard: native fixed-buffer conversion must arm");
    memory.toFixedLengthBuffer();
    expect(kept.byteLength).toBe(shared ? 65536 : 0);
    expect(views.range(0, 1).length).toBe(1);
    memory.grow(0);
    expect(views.range(65535, 1).length).toBe(1);
    memory.grow(1);
    expect(views.range(65536, 1).length).toBe(1);
    expect(views.range(0, 1).buffer).toBe(shared ? kept : memory.buffer);
    expect(() => views.range(131072, 1)).toThrow(RangeError);
  });
