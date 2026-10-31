import { afterEach, expect, test } from "bun:test";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";

const allRights = (1n << 29n) - 1n;
const encoder = new TextEncoder();
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});

function host(preopens: Record<string, string> = { "/": "/" }) {
  const fs = new MemFS();
  fs.writeFile("/sandbox/packages/member/index.ts", "before");
  fs.writeFile("/other/private", "other");
  fs.mkdirp("/sandbox/node_modules");
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens,
    stdout() {},
    stderr() {},
    sleep() {},
  });
  cleanup.push(() => wasi.descriptors.dispose());
  const memory = new WebAssembly.Memory({ initial: 1 });
  wasi.start({ exports: { memory, _start() {} } });
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const calls = wasi["functions"]();
  function path(value: string, at = 256) {
    const encoded = encoder.encode(value);
    bytes.set(encoded, at);
    return encoded.length;
  }
  function symlink(target: string, name: string, fd = 3) {
    return calls.path_symlink(256, path(target), fd, 2048, path(name, 2048));
  }
  function stat(name: string, follow: boolean, fd = 3) {
    const error = calls.path_filestat_get(fd, Number(follow), 256, path(name), 4096);
    return {
      error,
      kind: view.getUint8(4112),
      ino: view.getBigUint64(4104, true),
      nlink: view.getBigUint64(4120, true),
    };
  }
  function readlink(name: string, capacity = 1024, fd = 3) {
    bytes.fill(0xcc, 5000, 6024);
    const error = calls.path_readlink(fd, 256, path(name), 5000, capacity, 4096);
    const count = view.getUint32(4096, true);
    return { error, count, bytes: bytes.slice(5000, 5000 + Math.min(count, capacity)) };
  }
  function open(name: string, follow = true, fd = 3) {
    const error = calls.path_open(fd, Number(follow), 256, path(name), 0, allRights, 0n, 0, 4096);
    return { error, fd: view.getUint32(4096, true) };
  }
  function fstatLinks(fd: number) {
    expect(calls.fd_filestat_get(fd, 4096)).toBe(0);
    return view.getBigUint64(4120, true);
  }
  function read(fd: number) {
    view.setUint32(0, 5000, true);
    view.setUint32(4, 1024, true);
    expect(calls.fd_read(fd, 0, 1, 4096)).toBe(0);
    return new TextDecoder().decode(bytes.slice(5000, 5000 + view.getUint32(4096, true)));
  }
  return { fs, wasi, calls, path, symlink, stat, readlink, open, read, fstatLinks };
}

test("Preview1 creates a real relative workspace link and follows intermediate components", () => {
  const h = host();
  expect(h.symlink("../packages/member", "sandbox/node_modules/member")).toBe(0);
  const opened = h.open("sandbox/node_modules/member/index.ts");
  expect(opened.error).toBe(0);
  expect(h.read(opened.fd)).toBe("before");
  h.fs.writeFile("/sandbox/packages/member/index.ts", "after editor write");
  const edited = h.open("sandbox/node_modules/member/index.ts");
  expect(edited.error).toBe(0);
  expect(h.read(edited.fd)).toBe("after editor write");
});

test("Preview1 keeps raw UTF-8 readlink targets and truncates by bytes without a terminator", () => {
  const h = host();
  const target = "../packages//mémber/./index.ts";
  expect(h.symlink(target, "sandbox/node_modules/raw")).toBe(0);
  expect(h.readlink("sandbox/node_modules/raw")).toEqual({
    error: 0,
    count: encoder.encode(target).length,
    bytes: encoder.encode(target),
  });
  expect(h.readlink("sandbox/node_modules/raw", 15)).toEqual({
    error: 0,
    count: 15,
    bytes: encoder.encode(target).slice(0, 15),
  });
  expect(h.readlink("sandbox/node_modules/raw", 0)).toEqual({
    error: 0,
    count: 0,
    bytes: new Uint8Array(),
  });
});

test("Preview1 lstat sees the link inode while stat follows the final link", () => {
  const h = host();
  expect(h.symlink("packages/member/index.ts", "sandbox/final")).toBe(0);
  const link = h.stat("sandbox/final", false);
  const followed = h.stat("sandbox/final", true);
  expect(link.error).toBe(0);
  expect(link.kind).toBe(7);
  expect(followed).toEqual(h.stat("sandbox/packages/member/index.ts", true));
  expect(followed.kind).toBe(4);
  expect(link.ino).not.toBe(followed.ino);
  expect(h.open("sandbox/final", false).error).toBe(32);
});

test("Preview1 retains dangling links without pretending the target exists", () => {
  const h = host();
  expect(h.symlink("missing", "sandbox/dangling")).toBe(0);
  expect(h.stat("sandbox/dangling", false).kind).toBe(7);
  expect(h.readlink("sandbox/dangling").error).toBe(0);
  expect(h.stat("sandbox/dangling", true).error).toBe(44);
  expect(h.open("sandbox/dangling").error).toBe(44);
});

test("Preview1 bounds a link cycle but still reads each raw link", () => {
  const h = host();
  expect(h.symlink("cycle-b", "sandbox/cycle-a")).toBe(0);
  expect(h.symlink("cycle-a", "sandbox/cycle-b")).toBe(0);
  expect(h.stat("sandbox/cycle-a", true).error).toBe(32);
  expect(h.open("sandbox/cycle-b").error).toBe(32);
  expect(h.readlink("sandbox/cycle-a").bytes).toEqual(encoder.encode("cycle-b"));
});

const confinedPreopens: Record<string, string>[] = [
  { "/sandbox": "/sandbox" },
  { "/sandbox": "/sandbox", "/other": "/other" },
];
for (const preopens of confinedPreopens) {
  test(`relative links stay confined with ${Object.keys(preopens).length} non-root preopens`, () => {
    const h = host(preopens);
    expect(h.symlink("../packages/member", "node_modules/member")).toBe(0);
    expect(h.open("node_modules/member/index.ts").error).toBe(0);
    expect(h.symlink("../../other/private", "node_modules/escape")).toBe(0);
    expect(h.open("node_modules/escape").error).toBe(63);
    expect(h.readlink("node_modules/escape").bytes).toEqual(encoder.encode("../../other/private"));
    expect(h.symlink("/other/private", "absolute")).toBe(0);
    expect(h.open("absolute").error).toBe(63);
    expect(h.open("../other/private").error).toBe(63);
    if (Object.keys(preopens).length === 2) expect(h.open("private", true, 4).error).toBe(0);
  });
}

test("Preview1 checks symlink directory rights before mutation", () => {
  const h = host({ "/sandbox": "/sandbox" });
  expect(h.calls.fd_fdstat_set_rights(3, allRights & ~(1n << 24n), allRights)).toBe(0);
  expect(h.symlink("packages/member", "denied")).toBe(76);
  expect(h.stat("denied", false).error).toBe(44);
});

test("Preview1 existing readlink and lexical capability controls remain explicit", () => {
  const h = host({ "/sandbox": "/sandbox", "/other": "/other" });
  expect(h.readlink("packages/member/index.ts").error).toBe(28);
  expect(h.readlink("missing").error).toBe(44);
  expect(h.open("../other/private").error).toBe(63);
  expect(h.open("packages/member/index.ts").error).toBe(0);
  expect(h.open("private", true, 4).error).toBe(0);
});

test("Preview1 preserves hardlink rename unlink and open-description identity", () => {
  const h = host({ "/sandbox": "/sandbox" });
  const original = h.stat("packages/member/index.ts", true);
  expect(original.nlink).toBe(1n);
  const opened = h.open("packages/member/index.ts");
  expect(opened.error).toBe(0);
  expect(
    h.calls.path_link(3, 0, 256, h.path("packages/member/index.ts"), 3, 2048, h.path("hard", 2048)),
  ).toBe(0);
  expect(h.stat("hard", false).ino).toBe(original.ino);
  expect(h.stat("hard", false).nlink).toBe(2n);
  expect(h.calls.path_rename(3, 256, h.path("hard"), 3, 2048, h.path("moved", 2048))).toBe(0);
  expect(h.calls.path_unlink_file(3, 256, h.path("packages/member/index.ts"))).toBe(0);
  expect(h.stat("moved", false).ino).toBe(original.ino);
  expect(h.stat("moved", false).nlink).toBe(1n);
  expect(h.calls.path_unlink_file(3, 256, h.path("moved"))).toBe(0);
  expect(h.read(opened.fd)).toBe("before");
  expect(h.fstatLinks(opened.fd)).toBe(0n);
});

test("Preview1 bounds expansion count without rejecting an ordinary acyclic chain", () => {
  const h = host();
  for (let index = 0; index < 41; index++) {
    const target = index === 40 ? "packages/member/index.ts" : `chain-${index + 1}`;
    expect(h.symlink(target, `sandbox/chain-${index}`)).toBe(0);
  }
  expect(h.open("sandbox/chain-1").error).toBe(0);
  expect(h.open("sandbox/chain-0").error).toBe(32);
});

test("Preview1 hardlink source follow flags distinguish a link from its target", () => {
  const h = host({ "/sandbox": "/sandbox" });
  expect(h.symlink("packages/member/index.ts", "original-link")).toBe(0);
  expect(
    h.calls.path_link(3, 0, 256, h.path("original-link"), 3, 2048, h.path("link-copy", 2048)),
  ).toBe(0);
  expect(
    h.calls.path_link(3, 1, 256, h.path("original-link"), 3, 2048, h.path("target-copy", 2048)),
  ).toBe(0);
  expect(h.stat("link-copy", false)).toEqual(h.stat("original-link", false));
  expect(h.stat("target-copy", false)).toEqual(h.stat("packages/member/index.ts", false));
});

test("Preview1 creates a dangling target but O_EXCL still addresses the existing link", () => {
  const h = host({ "/sandbox": "/sandbox" });
  expect(h.symlink("created", "link")).toBe(0);
  const open = (flags: number) =>
    h.calls.path_open(3, 1, 256, h.path("link"), flags, allRights, 0n, 0, 4096);
  expect(open(1 | 4)).toBe(20);
  expect(h.stat("created", false).error).toBe(44);
  expect(open(1)).toBe(0);
  expect(h.stat("link", false).kind).toBe(7);
  expect(h.stat("created", false).kind).toBe(4);
});

test("Preview1 set-times follows only when requested and moving a link never moves its target", () => {
  const h = host({ "/sandbox": "/sandbox" });
  expect(h.symlink("packages/member/index.ts", "link")).toBe(0);
  const target = h.fs.lookup("/sandbox/packages/member/index.ts");
  const raw = h.fs.lookup("/sandbox/link", false);
  if (!target || !raw) throw new Error("missing test inodes");
  expect(h.calls.path_filestat_set_times(3, 0, 256, h.path("link"), 0n, 1000000n, 4)).toBe(0);
  expect(raw.mtime).toBe(1);
  expect(target.mtime).not.toBe(1);
  expect(h.calls.path_filestat_set_times(3, 1, 256, h.path("link"), 0n, 2000000n, 4)).toBe(0);
  expect(raw.mtime).toBe(1);
  expect(target.mtime).toBe(2);
  expect(h.calls.path_rename(3, 256, h.path("link"), 3, 2048, h.path("moved", 2048))).toBe(0);
  expect(h.readlink("moved").bytes).toEqual(encoder.encode("packages/member/index.ts"));
  expect(h.calls.path_unlink_file(3, 256, h.path("moved"))).toBe(0);
  expect(h.stat("packages/member/index.ts", true).error).toBe(0);
});

test("Preview1 readlink rejects an invalid count buffer before changing output", () => {
  const h = host({ "/sandbox": "/sandbox" });
  expect(h.symlink("raw-target", "link")).toBe(0);
  const view = h.wasi["view"]();
  new Uint8Array(view.buffer, 5000, 10).fill(0xcc);
  expect(h.calls.path_readlink(3, 256, h.path("link"), 5000, 10, view.byteLength)).toBe(21);
  expect(new Uint8Array(view.buffer, 5000, 10)).toEqual(new Uint8Array(10).fill(0xcc));
});
