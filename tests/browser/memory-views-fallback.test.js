import assert from "node:assert/strict";
import { test } from "bun:test";
import { memoryViews } from "@bun-wasm/runtime/core";

for (const shared of [false, true]) {
  for (const conversion of ["missing", "throws"]) {
    test(`memory view fallback survives grow(0) and grow(1) (${shared ? "shared" : "unshared"}, ${conversion})`, () => {
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 3, shared });
      let attempts = 0;
      Object.defineProperty(memory, "toResizableBuffer", {
        value: conversion === "missing" ? undefined : () => {
          attempts++;
          throw new TypeError("resizable memory conversion is unavailable");
        },
      });
      const views = memoryViews(memory);
      assert.equal(memoryViews(memory), views);
      views.bytes()[41] = 123;
      const before = views.bytes();
      const beforeView = views.view();
      assert.equal(views.bytes(), before);
      assert.equal(views.view(), beforeView);
      memory.grow(0);
      assert.equal(views.bytes().length, 65536);
      assert.equal(views.bytes()[41], 123);
      assert.equal(views.view().getUint8(41), 123);
      assert.equal(views.range(41, 1)[0], 123);
      assert.equal(views.bytes(), views.bytes());
      assert.equal(views.view(), views.view());
      if (!shared) {
        assert.equal(before.byteLength, 0);
        assert.notEqual(views.bytes(), before);
        assert.notEqual(views.view(), beforeView);
      }
      memory.grow(1);
      assert.equal(views.bytes().length, 2 * 65536);
      assert.equal(views.view().byteLength, 2 * 65536);
      views.view().setUint32(65536 + 8, 0x12345678, true);
      assert.deepEqual(Array.from(views.range(65544, 4)), [0x78, 0x56, 0x34, 0x12]);
      assert.throws(() => views.range(2 * 65536, 1), RangeError);
      assert.equal(attempts, conversion === "throws" ? 1 : 0);
    });
  }
}

for (const fallback of [false, true]) {
  test(`memory without a declared maximum survives zero and positive growth (fallback=${fallback})`, () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    if (fallback) Object.defineProperty(memory, "toResizableBuffer", { value: undefined });
    const views = memoryViews(memory);
    views.bytes()[42] = 77;
    for (const pages of [0, 1]) {
      const oldBuffer = views.bytes().buffer;
      const oldBytes = views.bytes();
      const oldView = views.view();
      memory.grow(pages);
      assert.equal(views.bytes().length, memory.buffer.byteLength);
      assert.equal(views.view().byteLength, memory.buffer.byteLength);
      assert.equal(views.bytes()[42], 77);
      assert.equal(views.view().getUint8(42), 77);
      assert.equal(views.bytes(), views.bytes());
      assert.equal(views.view(), views.view());
      if (memory.buffer !== oldBuffer) {
        assert.notEqual(views.bytes(), oldBytes);
        assert.notEqual(views.view(), oldView);
      }
    }
  });
}
