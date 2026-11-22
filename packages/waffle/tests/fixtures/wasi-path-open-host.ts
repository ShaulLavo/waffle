import type { FileHandle, FileSystem } from "../../core/filesystem.js";
import { RIGHTS_ALL } from "../../core/rights.js";
import { Wasi } from "../../core/wasi.js";
import { guestFunction, guestModule } from "./publication-wasm.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const noop = () => {};

export interface FsCounts {
  stat: number;
  preopen: number;
  permissions: number;
  resolve: number;
  create: number;
}

export function countingFs(inner: FileSystem): {
  fs: FileSystem;
  counts: FsCounts;
  reset(): void;
} {
  const counts: FsCounts = { stat: 0, preopen: 0, permissions: 0, resolve: 0, create: 0 };
  const fs = Object.create(inner) as FileSystem;
  fs.stat = (handle: FileHandle) => {
    counts.stat++;
    return inner.stat(handle);
  };
  fs.preopen = (path: string) => {
    counts.preopen++;
    return inner.preopen(path);
  };
  if (inner.permissions) {
    const innerPermissions = inner.permissions.bind(inner);
    fs.permissions = (handle: FileHandle) => {
      counts.permissions++;
      return innerPermissions(handle);
    };
  }
  fs.resolve = (directory: FileHandle, path: string, followFinal?: boolean) => {
    counts.resolve++;
    return inner.resolve(directory, path, followFinal);
  };
  fs.create = (path, kind, exclusive) => {
    counts.create++;
    return inner.create(path, kind, exclusive);
  };
  return {
    fs,
    counts,
    reset() {
      counts.stat = 0;
      counts.preopen = 0;
      counts.permissions = 0;
      counts.resolve = 0;
      counts.create = 0;
    },
  };
}

const pathOpenModule = guestModule("wasi_snapshot_preview1", [
  { name: "fd_close", parameters: ["i32"] },
  { name: "fd_read", parameters: ["i32", "i32", "i32", "i32"] },
  {
    name: "path_open",
    parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
  },
]);

export function createPathOpenHost(
  fs: FileSystem,
  preopens: Record<string, string> = { "/": "/" },
  memory = new WebAssembly.Memory({ initial: 4 }),
) {
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens,
    stdout: noop,
    stderr: noop,
    sleep: noop,
    namespaces: { env: { memory } },
  });
  const instance = new WebAssembly.Instance(pathOpenModule, wasi.imports(pathOpenModule));
  wasi.start(instance);
  const pathOpen = guestFunction(instance, "path_open");
  const fdClose = guestFunction(instance, "fd_close");
  const fdRead = guestFunction(instance, "fd_read");
  const view = () => new DataView(memory.buffer);
  const openRaw = (
    dirfd: number,
    path: string,
    options: {
      dirflags?: number;
      oflags?: number;
      base?: bigint;
      inheriting?: bigint;
      fdOut?: number;
    } = {},
  ) => {
    const encoded = encoder.encode(path);
    new Uint8Array(memory.buffer).set(encoded, 1024);
    const out = options.fdOut ?? 128;
    const errno = pathOpen(
      dirfd,
      options.dirflags ?? 1,
      1024,
      encoded.length,
      options.oflags ?? 0,
      options.base ?? RIGHTS_ALL,
      options.inheriting ?? RIGHTS_ALL,
      0,
      out,
    );
    return { errno, fd: errno === 0 ? view().getUint32(out >>> 0, true) : -1 };
  };
  const readAll = (fd: number) => {
    view().setUint32(256, 4096, true);
    view().setUint32(260, 256, true);
    const errno = fdRead(fd, 256, 1, 264);
    if (errno !== 0) throw new Error(`fd_read failed: ${errno}`);
    const n = view().getUint32(264, true);
    return decoder.decode(new Uint8Array(memory.buffer, 4096, n).slice());
  };
  const close = (fd: number) => fdClose(fd);
  return { wasi, memory, pathOpen, openRaw, readAll, close };
}
