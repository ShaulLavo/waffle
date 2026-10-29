import { expect, test } from "bun:test";
import { WalkSource, outputBound } from "../search/engine.js";
import { FilesystemError } from "../core/filesystem.js";
import type { WalkPage } from "../fs/walk.js";
import type { Candidate } from "../search/shards.js";
import type { SearchPlan } from "../search/types.js";

const plan: SearchPlan = {
  tool: "rg",
  operands: ["."],
  matcher: { kind: "literal", patterns: ["x"], ignoreCase: false },
  output: { kind: "count", withFilename: true, zeroCounts: false },
  walk: { include: [], exclude: [], excludeDirectories: [], hidden: true, maxDepth: null },
};

function fixture(operands: readonly string[], pages: readonly (WalkPage | Error)[]) {
  const released: number[] = [];
  const grants: number[][] = [];
  const closed: { id: number; sequence: number }[] = [];
  let at = 0;
  let walk = 0;
  let expectedIndex = 0;
  const source = new WalkSource({
    request: { plan: { ...plan, operands } },
    checkActive() {},
    open(path) {
      if (path === "missing") return -44;
      return { kind: path === "file-link" ? "file" : "directory", handle: 10, size: 2 };
    },
    fs: {
      walkOpen() {
        return { id: ++walk, sequence: 0 };
      },
      walkPage(_cursor, options) {
        expect(options.maxEntries).toBeLessThanOrEqual(128);
        const page = pages[at++];
        if (page instanceof Error) throw page;
        if (!page) throw new Error("no fixture page");
        expect(page.entries.length).toBeLessThanOrEqual(options.maxEntries);
        return page;
      },
      walkRelease(tokens) {
        grants.push(Array.from(tokens));
      },
      walkClose(cursor) {
        closed.push(cursor);
      },
      release(handle) {
        released.push(handle);
      },
    },
  });
  function take(credits = 256) {
    const page = source.next(credits);
    const candidates: Candidate[] = page.entries.map((entry) => ({
      ...entry,
      index: expectedIndex++,
    }));
    return { ...page, candidates };
  }
  return { source, take, released, grants, closed };
}

function file(path: string, grant: number) {
  return { kind: "file", path, handle: 22, grant, size: 2 } as const;
}

test("walk paths preserve ./ and release exact tokens for overlapping handles", () => {
  const f = fixture(
    [".", "./other/", "file-link", "missing"],
    [
      { entries: [file("a", 91), file("b", 92)], next: null },
      { entries: [file("a", 93)], next: null },
    ],
  );
  const first = f.take(2);
  expect(first.entries.map((entry) => entry.path)).toEqual(["./a", "./b"]);
  expect(f.take().entries).toEqual([]);
  expect(f.closed).toEqual([]);
  f.source.release(first.candidates);
  const second = f.take();
  expect(second.entries.map((entry) => entry.path)).toEqual(["./other/a"]);
  f.source.release(second.candidates);
  const last = f.take();
  expect(last.entries.map((entry) => entry.path)).toEqual(["file-link", "missing"]);
  expect(last.done).toBe(true);
  f.source.release(last.candidates);
  f.source.close();
  expect(f.grants).toEqual([[91, 92], [93]]);
  expect(f.released).toEqual([10, 10, 10]);
  expect(f.closed).toEqual([
    { id: 1, sequence: 0 },
    { id: 2, sequence: 0 },
  ]);
});

test("page failure retains original cleanup cursor and previously returned grants", () => {
  const f = fixture(
    ["."],
    [{ entries: [file("a", 91)], next: { id: 1, sequence: 1 } }, new FilesystemError(37)],
  );
  const page = f.take();
  expect(page.entries).toEqual([
    { kind: "file", path: "./a", handle: 22, size: 2 },
    { kind: "error", path: ".", errno: 37 },
  ]);
  expect(f.closed).toEqual([]);
  f.source.release(page.candidates);
  f.source.close();
  expect(f.grants).toEqual([[91]]);
  expect(f.closed).toEqual([{ id: 1, sequence: 0 }]);
});

test("close reclaims undelivered candidates and the original cursor", () => {
  const f = fixture(["."], [{ entries: [file("a", 91)], next: { id: 1, sequence: 1 } }]);
  f.take(1);
  f.source.close();
  f.source.close();
  expect(f.grants).toEqual([[91]]);
  expect(f.closed).toEqual([{ id: 1, sequence: 0 }]);
});

test("output reservations fit the fixed per-file budget", () => {
  expect(
    outputBound({ kind: "lines", withFilename: true, lineNumbers: true }, 16 * 1024 * 1024, 4096),
  ).toBe(32 * 1024 * 1024);
  expect(outputBound({ kind: "count", withFilename: true, zeroCounts: true }, 100, 10)).toBe(35);
  expect(outputBound({ kind: "files-with-matches" }, 100, 10)).toBe(11);
});
