import { expect, test } from "bun:test";
import { PipePublicationRegistry } from "../proc/pipes.js";

test("registry allocator receives the exact initial and maximum backing sizes", () => {
  const calls: number[][] = [];
  let backing: SharedArrayBuffer | undefined;
  const registry = new PipePublicationRegistry({
    allocate(length, maxByteLength) {
      calls.push([length, maxByteLength]);
      backing = new SharedArrayBuffer(length, { maxByteLength });
      return backing;
    },
  });
  expect(calls).toEqual([[2105360, 16785424]]);
  expect(registry.handle().buffer).toBe(backing);
  registry.registerProcess(1);
  registry.allocate(1);
  registry.collectProcess(1);
});

test("registry allocator failures propagate without constructing a registry", () => {
  const failure = new Error("memory budget denied");
  let calls = 0;
  expect(
    () =>
      new PipePublicationRegistry({
        allocate() {
          calls++;
          throw failure;
        },
      }),
  ).toThrow(failure);
  expect(calls).toBe(1);
});
