import assert from "node:assert/strict";
import { test } from "bun:test";
import { Wasi } from "../../waffle/core/wasi.ts";
import { MemFS } from "../../waffle/fs/memory.ts";
import { openInode } from "../../waffle/core/fd-reopen.ts";
import { RIGHT_FD_FILESTAT_GET } from "../../waffle/core/rights.ts";
import { dfCapacityGuest } from "../fixtures/df-capacity-guest.ts";

function fixture() {
  const fs = new MemFS();
  fs.mkdirp("/owned");
  fs.writeFile("/owned/input", "abc");
  const wasi = new Wasi({
    args: ["df-capacity-control"],
    env: {},
    fs,
    preopens: { "/": "/" },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  return { fs, wasi };
}

test("df prerequisite: preview1 reports file size and preopen metadata, not capacity", () => {
  const { fs, wasi } = fixture();
  try {
    const module = dfCapacityGuest();
    const instance = new WebAssembly.Instance(module, wasi.imports(module));
    assert.equal(wasi.start(instance), 0);
    const { memory, fd_filestat_get, fd_prestat_get } = instance.exports;
    assert.ok(memory instanceof WebAssembly.Memory);
    assert.equal(typeof fd_filestat_get, "function");
    assert.equal(typeof fd_prestat_get, "function");
    if (typeof fd_filestat_get !== "function" || typeof fd_prestat_get !== "function")
      throw new Error("Missing probe exports");
    assert.equal(fd_filestat_get(3, 64), 0);
    assert.equal(fd_prestat_get(3, 128), 0);
    const view = new DataView(memory.buffer);
    assert.equal(view.getUint8(80), 3);
    assert.equal(view.getUint32(132, true), 1);
    const path = fs.resolve(fs.preopen("/"), "owned/input");
    assert.ok(typeof path !== "number" && path.node !== undefined);
    const fd = openInode(wasi.descriptors, fs, path.node, "file", 0, 0, RIGHT_FD_FILESTAT_GET, 0n);
    assert.ok(fd >= 0);
    assert.equal(fd_filestat_get(fd, 192), 0);
    assert.equal(view.getUint8(208), 4);
    assert.equal(view.getBigUint64(224, true), 3n);
    assert.equal(fd_prestat_get(fd, 256), 8);
    assert.equal(fs.lookup("/proc/self/mountinfo"), undefined);
    assert.equal(fs.lookup("/etc/mtab"), undefined);
    assert.equal(
      Wasi.implemented().some((name) => /statvfs|statfs|mount/.test(name)),
      false,
    );
  } finally {
    wasi.descriptors.dispose();
  }
});

test("df prerequisite: requesting statvfs fails instead of returning invented usage", () => {
  const { wasi } = fixture();
  try {
    // This intentionally nonexistent name tests rejection. It proposes no guest ABI.
    assert.throws(
      () => wasi.imports(dfCapacityGuest(["statvfs"])),
      /unsupported import wasi_snapshot_preview1.statvfs/,
    );
  } finally {
    wasi.descriptors.dispose();
  }
});

test.skipIf(!process.env.DF_CAPACITY_GUEST)(
  "df prerequisite: real patched libc returns ENOSYS for statvfs and fstatvfs",
  async () => {
    const path = process.env.DF_CAPACITY_GUEST;
    assert.ok(path);
    const fs = new MemFS();
    fs.mkdirp("/owned");
    const stderr: Uint8Array[] = [];
    const stdout: Uint8Array[] = [];
    const wasi = new Wasi({
      args: ["df-statvfs"],
      env: {},
      fs,
      preopens: { "/": "/" },
      stdout: (bytes) => stdout.push(bytes.slice()),
      stderr: (bytes) => stderr.push(bytes.slice()),
      sleep() {},
    });
    try {
      const module = await WebAssembly.compile(await Bun.file(path).arrayBuffer());
      const instance = new WebAssembly.Instance(module, wasi.imports(module));
      assert.equal(wasi.start(instance), 1);
      assert.equal(Buffer.concat(stdout).length, 0);
      assert.equal(
        Buffer.concat(stderr).toString(),
        "statvfs status=-1 errno=52\nfstatvfs status=-1 errno=52\n",
      );
    } finally {
      wasi.descriptors.dispose();
    }
  },
);
