import { expect, test } from "bun:test";
import { EpochCache } from "../fs/epoch-cache";

test("answers are served only at the epoch they were answered in", () => {
  const cache = new EpochCache<string, number>(8);
  cache.set("a", 1, 2);
  expect(cache.get("a", 2)).toBe(1);
  expect(cache.get("a", 4)).toBeUndefined();
  // A newer answer drops every older one together.
  cache.set("b", 2, 4);
  expect(cache.get("a", 4)).toBeUndefined();
  expect(cache.get("a", 2)).toBeUndefined();
  expect(cache.get("b", 4)).toBe(2);
  cache.clear();
  expect(cache.get("b", 4)).toBeUndefined();
});

test("a working set over the bound loses only its oldest entries", () => {
  const cache = new EpochCache<number, number>(4096);
  for (let key = 0; key < 5000; key++) cache.set(key, key * 2, 6);
  expect(cache.get(903, 6)).toBeUndefined();
  for (let key = 904; key < 5000; key++) expect(cache.get(key, 6)).toBe(key * 2);
  // Replacing an entry neither grows the set nor evicts another one.
  cache.set(4999, 1, 6);
  expect(cache.get(904, 6)).toBe(1808);
  expect(cache.get(4999, 6)).toBe(1);
});
