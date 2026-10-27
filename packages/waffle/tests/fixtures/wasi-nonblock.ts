import type { Stream } from "../../core/descriptors.js";
import { Wasi, type WasiOptions } from "../../core/wasi.js";
import { MemFS } from "../../fs/memory.js";
import { guestFunction, guestModule } from "./publication-wasm.js";

const module = guestModule("wasi_snapshot_preview1", [
  { name: "fd_fdstat_get", parameters: ["i32", "i32"] },
  { name: "fd_fdstat_set_flags", parameters: ["i32", "i32"] },
  { name: "fd_fdstat_set_rights", parameters: ["i32", "i64", "i64"] },
  { name: "fd_read", parameters: ["i32", "i32", "i32", "i32"] },
  { name: "fd_write", parameters: ["i32", "i32", "i32", "i32"] },
]);

export function nonblockGuest(
  stdio: Partial<Record<0 | 1 | 2, Stream>> = {},
  options: Partial<WasiOptions> = {},
) {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: new MemFS(),
    preopens: {},
    stdout() {},
    stderr() {},
    sleep() {},
    ...options,
    stdio,
    namespaces: { env: { memory } },
  });
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  wasi.start(instance);
  const view = new DataView(memory.buffer);
  const call = (name: string, ...args: (number | bigint)[]) =>
    guestFunction(instance, name)(...args);
  const flags = (fd: number) => {
    const errno = call("fd_fdstat_get", fd, 128);
    if (errno) throw new Error(`fdstat failed: ${errno}`);
    return view.getUint16(130, true);
  };
  const io = (name: "fd_read" | "fd_write", fd: number, size = 1, count = 1) => {
    view.setUint32(256, 4096, true);
    view.setUint32(260, size, true);
    view.setUint32(264, 0xabcdef, true);
    return call(name, fd, 256, count, 264);
  };
  return { wasi, memory, view, call, flags, io };
}
