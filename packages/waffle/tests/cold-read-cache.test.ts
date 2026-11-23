import { expect, test } from "bun:test";
import { ColdReadCache } from "../fs/cold-read-cache";
import { PAGE } from "../fs/protocol";

const bytes = (length: number, seed: number) =>
  Uint8Array.from({ length }, (_, at) => (at * 7 + seed) & 255);

test("only completely covered pages are kept, including a short final page", () => {
  const cache = new ColdReadCache();
  const size = 2 * PAGE + 10;
  const file = bytes(size, 3);
  cache.store("a", 1, file.subarray(1, PAGE + 1), size);
  expect(cache.read("a", 1, 4)).toBeUndefined();
  cache.store("a", PAGE, file.subarray(PAGE), size);
  expect(cache.read("a", PAGE + 5, PAGE)).toEqual(file.subarray(PAGE + 5, 2 * PAGE + 5));
  expect(cache.read("a", 2 * PAGE + 8, 2)).toEqual(file.subarray(2 * PAGE + 8));
  expect(cache.read("a", PAGE - 1, 2)).toBeUndefined();
  expect(cache.read("b", PAGE, 1)).toBeUndefined();
});

test("results are private copies the caller may change or transfer", () => {
  const cache = new ColdReadCache();
  const source = bytes(PAGE, 5);
  cache.store("a", 0, source, PAGE);
  source.fill(0);
  const first = cache.read("a", 0, PAGE)!;
  expect(first).toEqual(bytes(PAGE, 5));
  first.fill(1);
  structuredClone(first.buffer, { transfer: [first.buffer] });
  expect(cache.read("a", 0, PAGE)).toEqual(bytes(PAGE, 5));
});

test("the least recently read pages leave first and the byte bound holds", () => {
  const cache = new ColdReadCache(2 * PAGE);
  cache.store("a", 0, bytes(PAGE, 1), PAGE);
  cache.store("b", 0, bytes(PAGE, 2), PAGE);
  expect(cache.read("a", 0, 1)).toBeDefined();
  cache.store("c", 0, bytes(PAGE, 3), PAGE);
  expect(cache.read("b", 0, 1)).toBeUndefined();
  expect(cache.read("a", 0, PAGE)).toEqual(bytes(PAGE, 1));
  expect(cache.read("c", 0, PAGE)).toEqual(bytes(PAGE, 3));
  cache.clear();
  expect(cache.read("a", 0, 1)).toBeUndefined();
});
