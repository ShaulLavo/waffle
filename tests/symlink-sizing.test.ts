import { expect, test } from "bun:test";
import { FilesystemError } from "../core/filesystem.js";
import { parseFileIdentity } from "../fs/file-identity.js";
import { newDir, newFile, newSymlink, nodeSize } from "../fs/memory.js";
import { NamespaceCursor, type NamespaceSource } from "../fs/namespace-cursor.js";
import { namespaceCut, namespacePage, nodeMetadata } from "../fs/workspace-protocol.js";
import { WORKSPACE_LIMITS } from "../fs/workspace-types.js";

const encoder = new TextEncoder();
const rootIdentity = parseFileIdentity({ id: "10000000000000001", version: "10000000000000003" });
const linkIdentity = parseFileIdentity({ id: "10000000000000002", version: "10000000000000004" });

function fixture(target: string) {
  const root = newDir();
  const link = newSymlink(target);
  link.mode = 0o640;
  link.mtime = 123;
  root.children.set("l", link);
  const cut = namespaceCut("sizing", { history: "sizing", generation: 1 });
  const reads: string[] = [];
  const source: NamespaceSource = {
    root,
    current: () => cut,
    metadata(node) {
      reads.push(node.kind);
      return {
        ...(node === root ? rootIdentity : linkIdentity),
        size: nodeSize(node),
        mode: node.mode,
        mtime: node.mtime,
      };
    },
  };
  return { root, link, source, reads, cut };
}

const pressure = { kind: "pressure", resource: "page" };
const released = { frames: 0, pending: 0, pathUnits: 0 };
const scenarios = [
  { scenario: "node-size", expected: { size: 96 } },
  { scenario: "protocol-size", expected: { errno: 29 } },
  {
    scenario: "cursor-pressure",
    expected: { page: pressure, again: pressure, resources: released },
  },
];

test.each(scenarios)("sizing does not encode a target in $scenario", ({ scenario, expected }) => {
  const child = Bun.spawnSync(
    [process.execPath, `${import.meta.dir}/fixtures/symlink-sizing-probe.ts`, scenario],
    { timeout: 5000, stdout: "pipe", stderr: "pipe" },
  );
  expect(child.exitCode).toBe(0);
  expect(new TextDecoder().decode(child.stderr)).toBe("");
  const receipt: unknown = JSON.parse(new TextDecoder().decode(child.stdout));
  console.log(JSON.stringify({ scenario, receipt }));
  expect(receipt).toMatchObject({ result: expected, restored: true });
  expect(receipt).toMatchObject({ encodedBytes: [] });
});

const targets = [
  "",
  "\0",
  "ascii",
  "\u007f\u0080\u07ff\u0800\uffff",
  "\ud800",
  "\udbff",
  "\udc00",
  "\udfff",
  "\ud800\udc00",
  "\udbff\udfff",
  "a😀b",
  "\ud800a\udc00",
  "\udc00\ud800",
  "\ud800\ud800\udc00\udc00",
  "./missing//../a\\b",
  "\u0001\t\n\r\"\\",
];

test.each(targets)("node sizes match TextEncoder for raw target %j", (target) => {
  expect(nodeSize(newSymlink(target))).toBe(encoder.encode(target).length);
});

test("mixed raw UTF-16 strings retain TextEncoder sizes", () => {
  let seed = 68;
  for (let sample = 0; sample < 256; sample++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const target = String.fromCharCode(seed & 0xffff, seed >>> 16, 0xd800, sample, 0xdc00);
    expect(nodeSize(newSymlink(target))).toBe(encoder.encode(target).length);
  }
});

test("file and directory sizing keeps logical file sizes", () => {
  const file = newFile(new Uint8Array([1, 2]));
  expect(nodeSize(file)).toBe(2);
  file.size = 9;
  expect(nodeSize(file)).toBe(9);
  expect(nodeSize(newDir())).toBe(0);
});

test.each(targets.filter((target) => target && !target.includes("\0")))(
  "snapshot and protocol preserve raw link metadata %j",
  (target) => {
    const value = fixture(target);
    const cursor = new NamespaceCursor(value.source);
    try {
      const page = namespacePage(cursor.next());
      if (page.kind !== "entries") throw new Error(`unexpected ${page.kind}`);
      expect(page.entries).toHaveLength(2);
      expect(page.entries[1]).toEqual({
        ...linkIdentity,
        parent: rootIdentity.id,
        path: "/l",
        name: "l",
        selected: true,
        kind: "symlink",
        target,
        size: encoder.encode(target).length,
        mode: 0o640,
        mtime: 123,
      });
      expect(cursor.next()).toEqual({ kind: "complete", cut: value.cut });
      expect(cursor.resources()).toEqual(released);
    } finally {
      cursor.close();
    }
  },
);

test("protocol keeps invalid-target and wrong-size errors", () => {
  const invalid = [
    { kind: "symlink", target: "", size: 0 },
    { kind: "symlink", target: "a\0b", size: 3 },
    { kind: "symlink", target: 1, size: 1 },
    { kind: "symlink", size: 0 },
    { kind: "symlink", target: "😀", size: 2 },
    { kind: "symlink", target: "\ud800", size: 1 },
    { kind: "unknown", target: "a", size: 1 },
    { kind: "file", target: "a", size: 1 },
    { kind: "directory", target: "a", size: 1 },
  ];
  for (const record of invalid)
    expect(() => nodeMetadata(record)).toThrow(expect.objectContaining({ errno: 29 }));
  expect(nodeMetadata({ kind: "file", size: 0 })).toEqual({ kind: "file" });
  expect(nodeMetadata({ kind: "directory", size: 0 })).toEqual({ kind: "directory" });
});

function pageCharge(target: string): number {
  return 198 + 2 * target.length + encoder.encode(target).length;
}

function boundary(target: string, pageBytes: number, fits: boolean): void {
  const value = fixture(target);
  const cursor = new NamespaceCursor(value.source, {}, undefined, { pageBytes, pageEntries: 1 });
  try {
    expect(cursor.next().kind).toBe("entries");
    const page = cursor.next();
    if (!fits) {
      expect(page).toEqual(pressure);
      expect(cursor.next()).toEqual(pressure);
      expect(value.reads).toEqual(["dir"]);
      expect(cursor.resources()).toEqual(released);
      return;
    }
    if (page.kind !== "entries") throw new Error(`unexpected ${page.kind}`);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ target, size: encoder.encode(target).length });
    expect(cursor.next()).toEqual({ kind: "complete", cut: value.cut });
    expect(value.reads).toEqual(["dir", "symlink"]);
    expect(cursor.resources()).toEqual(released);
  } finally {
    cursor.close();
  }
}

test("exact and one-byte-over tightened pages retain the same pressure category", () => {
  const target = "😀\ud800\u0001";
  boundary(target, pageCharge(target), true);
  boundary(target, pageCharge(target) - 1, false);
});

test("default page boundary admits exact charge and refuses one byte over", () => {
  const target = "a".repeat(21778) + "é";
  expect(pageCharge(target)).toBe(WORKSPACE_LIMITS.pageBytes);
  boundary(target, WORKSPACE_LIMITS.pageBytes, true);
  const over = target.slice(0, -1) + "\ud800";
  expect(pageCharge(over)).toBe(WORKSPACE_LIMITS.pageBytes + 1);
  boundary(over, WORKSPACE_LIMITS.pageBytes, false);
});

test("byte-full pages defer the link once without lost or duplicate metadata", () => {
  const target = "😀\ud800\n";
  const value = fixture(target);
  const cursor = new NamespaceCursor(value.source, {}, undefined, { pageBytes: pageCharge(target) });
  try {
    const first = cursor.next();
    if (first.kind !== "entries") throw new Error(`unexpected ${first.kind}`);
    expect(first.entries.map((entry) => entry.path)).toEqual(["/"]);
    expect(value.reads).toEqual(["dir"]);
    expect(cursor.resources().pending).toBe(1);
    const second = cursor.next();
    if (second.kind !== "entries") throw new Error(`unexpected ${second.kind}`);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]).toMatchObject({ path: "/l", target });
    expect(value.reads).toEqual(["dir", "symlink"]);
    expect(cursor.next()).toEqual({ kind: "complete", cut: value.cut });
    expect(cursor.resources()).toEqual(released);
  } finally {
    cursor.close();
  }
});

test("invalid prefix keeps its filesystem error and releases cursor state", () => {
  const value = fixture("raw");
  const cursor = new NamespaceCursor(value.source, { prefix: "/bad\0prefix" });
  expect(() => cursor.next()).toThrow(FilesystemError);
  expect(cursor.next()).toEqual({ kind: "cancelled" });
  expect(cursor.resources()).toEqual(released);
});
