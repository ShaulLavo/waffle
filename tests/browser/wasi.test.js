import { expect, test } from "bun:test";
import { MemFS } from "../src/fs";
import { Wasi } from "../src/wasi";

const encoder = new TextEncoder();
const signatures = {
  path_open: "iiiiijjii",
  path_filestat_get: "iiiii",
  path_filestat_set_times: "iiiijji",
  path_create_directory: "iii",
  path_remove_directory: "iii",
  path_unlink_file: "iii",
  path_readlink: "iiiiii",
  path_rename: "iiiiii",
  path_link: "iiiiiii",
  path_symlink: "iiiii",
  fd_fdstat_get: "ii",
  fd_fdstat_set_rights: "ijj",
  poll_oneoff: "iiii",
  fd_pread: "iiiji",
  fd_readdir: "iiiji",
  fd_renumber: "ii",
  fd_filestat_get: "ii",
  fd_seek: "ijii",
  fd_tell: "ii",
  fd_close: "i",
  fd_read: "iiii",
  fd_write: "iiii",
  fd_pwrite: "iiiji",
};

function uleb(value) {
  const bytes = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
}

const name = (value) => uleb(value.length).concat(Array.from(encoder.encode(value)));
const vector = (items) => uleb(items.length).concat(items.flat());
const section = (id, bytes) => [id].concat(uleb(bytes.length), bytes);

function syscallModule() {
  const entries = Object.entries(signatures);
  const types = entries.map(([, params]) => [0x60, params.length].concat(Array.from(params, (p) => p === "j" ? 0x7e : 0x7f), [1, 0x7f]));
  const imports = entries.map(([key], i) => name("wasi_snapshot_preview1").concat(name(key), [0], uleb(i)));
  const exports = entries.map(([key], i) => name(key).concat([0], uleb(i)));
  exports.push(name("memory").concat([2, 0]), name("_start").concat([0], uleb(entries.length)));
  return new WebAssembly.Module(new Uint8Array(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, vector(types.concat([[0x60, 0, 0]]))),
      section(2, vector(imports)),
      section(3, [1].concat(uleb(entries.length))),
      section(5, [1, 0, 1]),
      section(7, vector(exports)),
      section(10, [1, 2, 0, 0x0b]),
    ),
  ));
}

const module = syscallModule();
function host(preopens = { "/allowed": "/allowed" }, options = {}) {
  const fs = new MemFS();
  fs.writeFile("/allowed/inside", "inside");
  fs.mkdirp("/allowed/sub");
  fs.writeFile("/outside", "outside");
  fs.mkdirp("/outside-dir");
  fs.writeFile("/allowed-sibling/secret", "secret");
  const wasi = new Wasi({ args: [], env: {}, fs, preopens, stdout() {}, stderr() {}, sleep() {}, ...options });
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  expect(wasi.start(instance)).toBe(0);
  const calls = instance.exports;
  const view = new DataView(calls.memory.buffer);
  function path(text, ptr = 256) {
    const bytes = encoder.encode(text);
    new Uint8Array(calls.memory.buffer).set(bytes, ptr);
    return bytes.length;
  }
  function open(text, fd = 3, flags = 0) {
    const result = calls.path_open(fd, 0, 256, path(text), flags, (1n << 29n) - 1n, (1n << 29n) - 1n, 0, 1024);
    return { result, fd: view.getUint32(1024, true) };
  }
  return { fs, calls, view, path, open };
}

const pathCalls = {
  path_open: (h, len) => h.calls.path_open(3, 0, 256, len, 9, 0n, 0n, 0, 1024),
  path_filestat_get: (h, len) => h.calls.path_filestat_get(3, 0, 256, len, 1024),
  path_filestat_set_times: (h, len) => h.calls.path_filestat_set_times(3, 0, 256, len, 0n, 123n, 4),
  path_create_directory: (h, len) => h.calls.path_create_directory(3, 256, len),
  path_remove_directory: (h, len) => h.calls.path_remove_directory(3, 256, len),
  path_unlink_file: (h, len) => h.calls.path_unlink_file(3, 256, len),
  path_readlink: (h, len) => h.calls.path_readlink(3, 256, len, 1024, 32, 1088),
  path_rename_source: (h, len) => h.calls.path_rename(3, 256, len, 3, 512, h.path("inside", 512)),
  path_rename_target: (h, len) => h.calls.path_rename(3, 512, h.path("inside", 512), 3, 256, len),
  path_link_source: (h, len) => h.calls.path_link(3, 0, 256, len, 3, 512, h.path("linked", 512)),
  path_link_target: (h, len) => h.calls.path_link(3, 0, 512, h.path("inside", 512), 3, 256, len),
};

for (const [call, invoke] of Object.entries(pathCalls)) {
  for (const path of ["../outside", "../outside-dir", "/outside", "/allowed/inside", "../allowed/inside", "sub/../../outside", "../../outside", "../allowed-sibling/secret"]) {
    test(`${call} confines ${path} to the directory fd`, () => {
      const h = host();
      const before = structuredClone(h.fs.root);
      h.view.setUint32(1024, 0xfeedface, true);
      expect(invoke(h, h.path(path))).toBe(63);
      expect(h.fs.root).toEqual(before);
      expect(h.view.getUint32(1024, true)).toBe(0xfeedface);
    });
  }
}

test("relative dot segments stay usable inside a directory capability", () => {
  const h = host();
  expect(h.open("sub/.././inside").result).toBe(0);
  expect(h.open("sub//../inside").result).toBe(0);
  expect(h.open(".", 3, 2).result).toBe(0);
});

test("opened subdirectories cannot climb back to the preopen", () => {
  const h = host();
  const sub = h.open("sub", 3, 2);
  expect(sub.result).toBe(0);
  expect(h.open("../inside", sub.fd).result).toBe(63);
  expect(h.open("../sub", sub.fd, 2).result).toBe(63);
});

test("the root preopen rejects absolute paths and parent traversal", () => {
  const h = host({ "/": "/" });
  expect(h.open("allowed/inside").result).toBe(0);
  expect(h.open("/allowed/inside").result).toBe(63);
  expect(h.open("../allowed/inside").result).toBe(63);
});

test("invalid and nondirectory fds keep their errors for path calls", () => {
  const h = host();
  expect(h.open("../outside", 99).result).toBe(8);
  expect(h.open("/outside", 1).result).toBe(54);
});

test("unsupported symlinks cannot introduce an escape", () => {
  const h = host();
  expect(h.calls.path_symlink(256, h.path("../outside"), 3, 512, h.path("link", 512))).toBe(58);
  expect(h.fs.lookup("/allowed/link")).toBeUndefined();
});

for (const fd of [0, 1, 2, 3]) {
  test(`fd_renumber(${fd}, ${fd}) preserves the descriptor`, () => {
    const h = host();
    expect(h.calls.fd_renumber(fd, fd)).toBe(0);
    expect(h.calls.fd_filestat_get(fd, 1024)).toBe(0);
  });
}

test("self-renumber preserves an open file's cursor", () => {
  const h = host();
  const file = h.open("inside");
  expect(file.result).toBe(0);
  expect(h.calls.fd_seek(file.fd, 2n, 0, 1024)).toBe(0);
  expect(h.calls.fd_renumber(file.fd, file.fd)).toBe(0);
  expect(h.calls.fd_tell(file.fd, 1024)).toBe(0);
  expect(h.view.getBigUint64(1024, true)).toBe(2n);
  expect(h.calls.fd_close(file.fd)).toBe(0);
  expect(h.calls.fd_renumber(file.fd, file.fd)).toBe(8);
  expect(h.calls.fd_renumber(99, 99)).toBe(8);
});

test("renumbering distinct descriptors still replaces the target", () => {
  const h = host();
  expect(h.calls.fd_renumber(1, 2)).toBe(0);
  expect(h.calls.fd_filestat_get(1, 1024)).toBe(8);
  expect(h.calls.fd_filestat_get(2, 1024)).toBe(0);
});

test("zero-length writes past EOF do not extend a file or change its cursor", () => {
  const h = host();
  const file = h.open("inside");
  expect(file.result).toBe(0);
  expect(h.calls.fd_seek(file.fd, 100n, 0, 1024)).toBe(0);
  const before = structuredClone(h.fs.root);
  h.view.setUint32(128, 256, true);
  h.view.setUint32(132, 0, true);
  expect(h.calls.fd_write(file.fd, 128, 1, 1024)).toBe(0);
  expect(h.view.getUint32(1024, true)).toBe(0);
  expect(h.fs.root).toEqual(before);
  expect(h.calls.fd_tell(file.fd, 1024)).toBe(0);
  expect(h.view.getBigUint64(1024, true)).toBe(100n);
  expect(h.calls.fd_pwrite(file.fd, 128, 1, 200n, 1024)).toBe(0);
  expect(h.fs.root).toEqual(before);
});

test("zero-length stdin reads do not call a blocking source", () => {
  const h = host(undefined, { stdin() { throw new Error("zero-byte read reached stdin"); } });
  h.view.setUint32(128, 256, true);
  h.view.setUint32(132, 0, true);
  expect(h.calls.fd_read(0, 128, 1, 1024)).toBe(0);
  expect(h.view.getUint32(1024, true)).toBe(0);
  expect(h.calls.fd_read(0, 128, 0, 1024)).toBe(0);
});


function rename(h, from, to) {
  return h.calls.path_rename(3, 256, h.path(from), 3, 512, h.path(to, 512));
}

test("directory descriptors follow their node after rename and pathname replacement", () => {
  const h = host();
  h.fs.writeFile("/allowed/sub/original", "original");
  const dir = h.open("sub", 3, 2);
  expect(dir.result).toBe(0);
  expect(rename(h, "sub", "moved")).toBe(0);
  h.fs.writeFile("/allowed/sub/replacement", "replacement");
  expect(h.open("original", dir.fd).result).toBe(0);
  expect(h.open("replacement", dir.fd).result).toBe(44);
  expect(h.open("created", dir.fd, 1).result).toBe(0);
  expect(h.fs.lookup("/allowed/moved/created")?.kind).toBe("file");
  expect(h.fs.lookup("/allowed/sub/created")).toBeUndefined();
});

for (const [path, errno] of [["inside/", 54], ["inside/.", 54], ["inside/../inside", 54], ["missing/../inside", 44]]) {
  for (const [call, invoke] of Object.entries(pathCalls)) {
    test(`${call} checks real path components in ${path}`, () => {
      const h = host();
      const before = structuredClone(h.fs.root);
      expect(invoke(h, h.path(path))).toBe(errno);
      expect(h.fs.root).toEqual(before);
    });
  }
}

test("rename across hard links to one inode is a no-op", () => {
  const h = host();
  expect(h.calls.path_link(3, 0, 256, h.path("inside"), 3, 512, h.path("alias", 512))).toBe(0);
  const before = structuredClone(h.fs.root);
  expect(rename(h, "inside", "alias")).toBe(0);
  expect(h.fs.root).toEqual(before);
  expect(h.fs.lookup("/allowed/inside")).toBe(h.fs.lookup("/allowed/alias"));
});

test("rename cannot move a directory into its descendant through another directory fd", () => {
  const h = host();
  h.fs.mkdirp("/allowed/sub/child");
  const dir = h.open("sub/child", 3, 2);
  const before = structuredClone(h.fs.root);
  expect(h.calls.path_rename(3, 256, h.path("sub"), dir.fd, 512, h.path("loop", 512))).toBe(28);
  expect(h.fs.root).toEqual(before);
});

const READ = 1n << 1n;
const WRITE = 1n << 6n;
const SEEK = 1n << 2n;
const PATH_OPEN = 1n << 13n;
function openRights(h, text, base, inheriting = 0n, fd = 3, flags = 0) {
  const result = h.calls.path_open(fd, 0, 256, h.path(text), flags, base, inheriting, 0, 1024);
  return { result, fd: h.view.getUint32(1024, true) };
}
function iovec(h) {
  h.view.setUint32(128, 512, true);
  h.view.setUint32(132, h.path("X", 512), true);
}

test("requested file rights are reported and enforced for read, write and positioned I/O", () => {
  const h = host();
  const ro = openRights(h, "inside", READ | SEEK);
  const wo = openRights(h, "inside", WRITE | SEEK);
  expect(ro.result).toBe(0);
  expect(wo.result).toBe(0);
  expect(h.calls.fd_fdstat_get(ro.fd, 1024)).toBe(0);
  expect(h.view.getBigUint64(1032, true)).toBe(READ | SEEK);
  expect(h.view.getBigUint64(1040, true)).toBe(0n);
  iovec(h);
  const before = structuredClone(h.fs.root);
  expect(h.calls.fd_write(ro.fd, 128, 1, 1024)).toBe(76);
  expect(h.calls.fd_pwrite(ro.fd, 128, 1, 0n, 1024)).toBe(76);
  expect(h.calls.fd_read(wo.fd, 128, 1, 1024)).toBe(76);
  expect(h.calls.fd_pread(wo.fd, 128, 1, 0n, 1024)).toBe(76);
  expect(h.fs.root).toEqual(before);
  expect(h.calls.fd_read(ro.fd, 128, 1, 1024)).toBe(0);
  expect(h.calls.fd_write(wo.fd, 128, 1, 1024)).toBe(0);
});

test("fd rights are reduce-only, including inheriting rights", () => {
  const h = host();
  const file = openRights(h, "inside", READ | WRITE);
  expect(h.calls.fd_fdstat_set_rights(file.fd, READ, 0n)).toBe(0);
  expect(h.calls.fd_fdstat_set_rights(file.fd, READ | WRITE, 0n)).toBe(76);
  expect(h.calls.fd_fdstat_set_rights(file.fd, READ, READ)).toBe(76);
  iovec(h);
  expect(h.calls.fd_write(file.fd, 128, 1, 1024)).toBe(76);
  expect(h.calls.fd_read(file.fd, 128, 1, 1024)).toBe(0);
  expect(h.calls.fd_fdstat_set_rights(99, 0n, 0n)).toBe(8);
});

test("path_open respects parent open and inheriting rights before creating or truncating", () => {
  const h = host();
  const dir = openRights(h, "sub", PATH_OPEN, READ, 3, 2);
  expect(dir.result).toBe(0);
  const before = structuredClone(h.fs.root);
  expect(openRights(h, "created", WRITE, 0n, dir.fd, 1).result).toBe(76);
  expect(openRights(h, "created", READ, READ | WRITE, dir.fd, 1).result).toBe(76);
  expect(h.fs.root).toEqual(before);
  expect(h.calls.fd_fdstat_set_rights(dir.fd, 0n, READ)).toBe(0);
  expect(openRights(h, "anything", READ, 0n, dir.fd).result).toBe(76);
  expect(h.fs.root).toEqual(before);
});

for (const tag of [1, 2]) {
  test(`poll_oneoff reports EBADF in a type ${tag} event, not as syscall failure`, () => {
    const h = host();
    h.view.setBigUint64(128, 0x123456789n, true);
    h.view.setUint8(136, tag);
    h.view.setUint32(144, 999, true);
    expect(h.calls.poll_oneoff(128, 512, 1, 1024)).toBe(0);
    expect(h.view.getUint32(1024, true)).toBe(1);
    expect(h.view.getBigUint64(512, true)).toBe(0x123456789n);
    expect(h.view.getUint16(520, true)).toBe(8);
    expect(h.view.getUint8(522)).toBe(tag);
  });
}


for (const operation of ["link", "rename"]) {
  test(`${operation} cannot create a file through a trailing slash`, () => {
    const h = host();
    const before = structuredClone(h.fs.root);
    const result = operation === "link"
      ? h.calls.path_link(3, 0, 256, h.path("inside"), 3, 512, h.path("new/", 512))
      : rename(h, "inside", "new/");
    expect(result).toBe(54);
    expect(h.fs.root).toEqual(before);
  });
}

test("creating a regular file with O_DIRECTORY fails without leaving a file behind", () => {
  const h = host();
  const before = structuredClone(h.fs.root);
  expect(h.open("new", 3, 3).result).toBe(28);
  expect(h.fs.root).toEqual(before);
});


test("readdir follows the directory's new parent after a cross-directory rename", () => {
  const h = host();
  h.fs.mkdirp("/allowed/container");
  const dir = h.open("sub", 3, 2);
  expect(rename(h, "sub", "container/moved")).toBe(0);
  h.fs.mkdirp("/allowed/sub");
  expect(h.calls.fd_readdir(dir.fd, 2048, 128, 0n, 1024)).toBe(0);
  expect(h.view.getBigUint64(2048 + 8, true)).toBe(BigInt(h.fs.lookup("/allowed/container/moved").ino));
  expect(h.view.getBigUint64(2048 + 25 + 8, true)).toBe(BigInt(h.fs.lookup("/allowed/container").ino));
});


test("FD_TELL permits seek CUR zero but not other seeks", () => {
  const h = host();
  const file = openRights(h, "inside", 1n << 5n);
  expect(file.result).toBe(0);
  expect(h.calls.fd_seek(file.fd, 0n, 1, 1024)).toBe(0);
  expect(h.view.getBigUint64(1024, true)).toBe(0n);
  expect(h.calls.fd_seek(file.fd, 1n, 1, 1024)).toBe(76);
  expect(h.calls.fd_seek(file.fd, 0n, 0, 1024)).toBe(76);
});

test("truncation is authorized by the parent, not the returned descriptor's write right", () => {
  const h = host();
  expect(openRights(h, "inside", READ, 0n, 3, 8).result).toBe(0);
  expect(h.fs.readFile("/allowed/inside").length).toBe(0);
  h.fs.writeFile("/allowed/inside", "preserved");
  const all = (1n << 29n) - 1n;
  expect(h.calls.fd_fdstat_set_rights(3, all & ~(1n << 19n), all)).toBe(0);
  expect(openRights(h, "inside", READ | WRITE, 0n, 3, 8).result).toBe(76);
  expect(new TextDecoder().decode(h.fs.readFile("/allowed/inside"))).toBe("preserved");
});

for (const replaced of [false, true]) {
  test(`detached directory descriptors cannot create unreachable files (replaced=${replaced})`, () => {
    const h = host();
    const dir = h.open("sub", 3, 2);
    if (replaced) {
      h.fs.mkdirp("/allowed/other");
      expect(rename(h, "other", "sub")).toBe(0);
    } else {
      expect(h.calls.path_remove_directory(3, 256, h.path("sub"))).toBe(0);
    }
    expect(h.open("lost", dir.fd, 1).result).toBe(44);
    expect(h.calls.path_create_directory(dir.fd, 256, h.path("lost-dir"))).toBe(44);
    expect(h.calls.path_link(3, 0, 256, h.path("inside"), dir.fd, 512, h.path("lost-link", 512))).toBe(44);
    expect(h.calls.path_rename(3, 256, h.path("inside"), dir.fd, 512, h.path("lost-rename", 512))).toBe(44);
    expect(h.fs.lookup("/allowed/inside")?.kind).toBe("file");
  });
}

for (const path of ["sub/.", "sub/./", "."]) {
  test(`rmdir rejects terminal dot in ${path} without removing a directory`, () => {
    const h = host();
    const before = structuredClone(h.fs.root);
    expect(h.calls.path_remove_directory(3, 256, h.path(path))).toBe(28);
    expect(h.fs.root).toEqual(before);
  });
}


for (const [from, to] of [["sub/.", "other"], ["other", "sub/."]]) {
  test(`rename rejects terminal dot in ${from} -> ${to}`, () => {
    const h = host();
    h.fs.mkdirp("/allowed/other");
    const before = structuredClone(h.fs.root);
    expect(rename(h, from, to)).toBe(28);
    expect(h.fs.root).toEqual(before);
  });
}

for (const root of [false, true]) {
  test(`readdir does not search the whole filesystem for a known parent (root=${root})`, () => {
    const h = host(root ? { "/": "/" } : undefined);
    const fd = root ? 3 : h.open("sub", 3, 2).fd;
    h.fs.root.children.values = () => { throw new Error("whole-tree parent scan"); };
    expect(h.calls.fd_readdir(fd, 2048, 128, 0n, 1024)).toBe(0);
  });
}


test("FD_SEEK alone still permits CUR-zero queries", () => {
  const h = host();
  const file = openRights(h, "inside", SEEK);
  expect(file.result).toBe(0);
  expect(h.calls.fd_seek(file.fd, 1n, 0, 1024)).toBe(0);
  expect(h.calls.fd_seek(file.fd, 0n, 1, 1024)).toBe(0);
  expect(h.view.getBigUint64(1024, true)).toBe(1n);
});
