import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WASI } from "node:wasi";
import { verifyWasiGuest } from "../tools/program-build-tools.ts";

const path = process.argv[2];
assert.ok(path, "Cargo must supply the WASI test binary");
verifyWasiGuest(path, { filesystemAdapter: "waffle_program_support::runtime::wasi" });

const scratch = mkdtempSync(join(tmpdir(), "waffle-root-preopen-"));
try {
  writeFileSync(join(scratch, "target"), "target");
  symlinkSync("target", join(scratch, "alias"));
  const wasi = new WASI({
    version: "preview1",
    args: [path].concat(process.argv.slice(3)),
    preopens: { "/other": scratch, "/": scratch },
    returnOnExit: true,
  });
  const queries: number[] = [];
  const names: number[] = [];
  const live: number[] = [];
  const permissionFlags: number[] = [];
  let memory: WebAssembly.Memory;
  const imports = {
    ...wasi.wasiImport,
    fd_prestat_get(fd: number, output: number) {
      queries.push(fd);
      return wasi.wasiImport.fd_prestat_get(fd, output);
    },
    fd_prestat_dir_name(fd: number, output: number, length: number) {
      names.push(fd);
      return wasi.wasiImport.fd_prestat_dir_name(fd, output, length);
    },
    fd_fdstat_get(fd: number, output: number) {
      live.push(fd);
      return wasi.wasiImport.fd_fdstat_get(fd, output);
    },
  };
  const module = new WebAssembly.Module(readFileSync(path));
  const instance = new WebAssembly.Instance(module, {
    wasi_snapshot_preview1: imports,
    runtime_fs: {
      path_permissions_get(fd: number, ptr: number, len: number, flags: number, output: number) {
        assert.equal(fd, 4);
        const name = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
        assert.equal(name, "alias");
        permissionFlags.push(flags);
        const words = new DataView(memory.buffer, output, 16);
        words.setUint32(0, flags === 1 ? 0o640 : 0o777, true);
        words.setUint32(4, 0o777, true);
        return 0;
      },
    },
  });
  assert.ok(instance.exports.memory instanceof WebAssembly.Memory);
  memory = instance.exports.memory;
  assert.equal(wasi.start(instance), 0);
  assert.deepEqual(permissionFlags, [0, 1]);
  assert.deepEqual(queries, [3, 4], "accessor must not rescan preopens");
  assert.deepEqual(names, [4], "accessor must not query the cached root name again");
  assert.ok(live.includes(4), "cached root must still be a live descriptor");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
