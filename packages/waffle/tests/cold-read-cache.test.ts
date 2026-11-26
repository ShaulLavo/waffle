import { expect, test } from "bun:test";
import { COLD_PAGE_OVERHEAD, ColdReadCache, READAHEAD_BYTES } from "../fs/cold-read-cache";
import { PAGE } from "../fs/protocol";

/** Room for exactly this many full pages. */
const pages = (count: number) => count * (PAGE + COLD_PAGE_OVERHEAD);

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
  const cache = new ColdReadCache(pages(2));
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

test("many tiny files are charged their per-page overhead, not just their bytes", () => {
  const limit = 64 * 1024;
  const cache = new ColdReadCache(limit);
  const count = 10_000;
  for (let index = 0; index < count; index++)
    cache.store(`tiny-${index}`, 0, new Uint8Array([index & 255]), 1);
  let kept = 0;
  for (let index = 0; index < count; index++) if (cache.read(`tiny-${index}`, 0, 1)) kept++;
  expect(kept).toBe(Math.floor(limit / (1 + COLD_PAGE_OVERHEAD)));
  // The newest survive.
  expect(cache.read(`tiny-${count - 1}`, 0, 1)).toEqual(new Uint8Array([(count - 1) & 255]));
});

test("a range ending in an incomplete page makes room page by page", () => {
  const cache = new ColdReadCache(pages(2));
  cache.store("old", 0, bytes(PAGE, 9), PAGE);
  // Two complete pages and a trailing partial one of a three-page file.
  const file = bytes(3 * PAGE, 4);
  cache.store("big", 0, file.subarray(0, 2 * PAGE + 10), 3 * PAGE);
  expect(cache.read("old", 0, 1)).toBeUndefined();
  expect(cache.read("big", 0, 2 * PAGE)).toEqual(file.subarray(0, 2 * PAGE));
  expect(cache.read("big", 2 * PAGE, 1)).toBeUndefined();
  // The bound held: storing another page now drops exactly the oldest one.
  cache.store("next", 0, bytes(PAGE, 2), PAGE);
  expect(cache.read("big", 0, 1)).toBeUndefined();
  expect(cache.read("big", PAGE, 1)).toBeDefined();
});

test("only a read that continues the previous one gets a readahead window", () => {
  const cache = new ColdReadCache();
  const size = 40 * PAGE;
  expect(cache.readWindow("a", 0, PAGE, size)).toEqual({ offset: 0, length: PAGE });
  cache.noteRead("a", PAGE);
  expect(cache.readWindow("a", PAGE, PAGE, size)).toEqual({
    offset: PAGE,
    length: READAHEAD_BYTES,
  });
  // Another offset, or another payload, is not a continuation.
  expect(cache.readWindow("a", 3 * PAGE, PAGE, size)).toEqual({ offset: 3 * PAGE, length: PAGE });
  expect(cache.readWindow("b", PAGE, PAGE, size)).toEqual({ offset: PAGE, length: PAGE });
  // The window never passes the end of the payload, including a short final page.
  cache.noteRead("a", size - 2 * PAGE);
  expect(cache.readWindow("a", size - 2 * PAGE, PAGE, size)).toEqual({
    offset: size - 2 * PAGE,
    length: 2 * PAGE,
  });
  const oddSize = 3 * PAGE + 100;
  cache.noteRead("odd", PAGE);
  expect(cache.readWindow("odd", PAGE, PAGE, oddSize)).toEqual({
    offset: PAGE,
    length: 2 * PAGE + 100,
  });
  // Small sequential reads align the window start to the current page so page 0 is cached too.
  cache.noteRead("small", 8192);
  expect(cache.readWindow("small", 8192, 8192, size)).toEqual({
    offset: 0,
    length: READAHEAD_BYTES,
  });
  cache.clear();
  expect(cache.readWindow("a", size - 2 * PAGE, PAGE, size)).toEqual({
    offset: size - 2 * PAGE,
    length: PAGE,
  });
});

test("a readahead window stays an integer within half of the cache bound", () => {
  const cache = new ColdReadCache(pages(4));
  cache.noteRead("a", PAGE);
  expect(cache.readWindow("a", PAGE, PAGE, 40 * PAGE)).toEqual({ offset: PAGE, length: 2 * PAGE });
  // Odd or tiny cache limits never produce fractional spans or shrink the request.
  const odd = new ColdReadCache(100_001);
  odd.noteRead("a", PAGE);
  expect(odd.readWindow("a", PAGE, PAGE, 40 * PAGE)).toEqual({ offset: PAGE, length: PAGE });
  const zero = new ColdReadCache(0);
  zero.noteRead("a", PAGE);
  expect(zero.readWindow("a", PAGE, PAGE, 40 * PAGE)).toEqual({ offset: PAGE, length: PAGE });
  // A one-page readahead budget falls back when a request straddles a page boundary.
  const tight = new ColdReadCache(pages(2));
  tight.noteRead("a", PAGE - 2);
  expect(tight.readWindow("a", PAGE - 2, 5, 40 * PAGE)).toEqual({ offset: PAGE - 2, length: 5 });
});

test("sequential stream tracking is bounded and evicts the oldest stream", () => {
  const cache = new ColdReadCache();
  const size = 40 * PAGE;
  for (let index = 0; index < 80; index++) cache.noteRead(`stream-${index}`, PAGE);
  expect(cache.readWindow("stream-0", PAGE, PAGE, size)).toEqual({ offset: PAGE, length: PAGE });
  expect(cache.readWindow("stream-79", PAGE, PAGE, size)).toEqual({
    offset: PAGE,
    length: READAHEAD_BYTES,
  });
});
