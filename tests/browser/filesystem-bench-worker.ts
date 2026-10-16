// Spike 4's five micro workloads, unchanged counts/fixtures; only host construction differs.
import { Wasi as BaselineWasi } from "benchmark:baseline-core";
import { MemFS as BaselineMemFS } from "benchmark:baseline-fs";
import { Wasi } from "@bun-wasm/runtime/core";
import { FilesystemClient } from "@bun-wasm/runtime/fs";
const encoder = new TextEncoder();
const names = Array.from({ length: 300 }, (_, i) => `file${String(i).padStart(3, "0")}.txt`);
const line = encoder.encode("sample text line\n");
const rights = (1n << 29n) - 1n;
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function micro(arm: string, name: string, n: number, connection: any) {
  const fs = arm === "main" ? new BaselineMemFS() : new FilesystemClient(connection);
  fs.preopen("/home/guest"); fs.preopen("/tmp"); fs.preopen("/data");
  for (const name of names) fs.writeFile(`/data/${name}`, line);
  fs.writeFile("/data/blob", new Uint8Array(4 * 1024 * 1024).fill(65));
  const Host = arm === "main" ? BaselineWasi : Wasi;
  const core: any = new Host({ args: [], env: { HOME: "/home/guest", TERM: "xterm-256color", USER: "guest", PATH: "/bin", LANG: "C.UTF-8", PWD: "/" }, fs, preopens: { "/": "/" }, stdin: () => new Uint8Array(), stdout() {}, stderr() {}, sleep() {} });
  // Exactly the public import wrappers timed in spike 4, including their errno handling.
  const functions = core.functions();
  const api: any = Object.fromEntries(Object.entries(functions).map(([key, fn]) => [key, core.wrap(key, fn)]));
  const memory = new WebAssembly.Memory({ initial: 128, maximum: 1024 });
  core.start({ exports: { memory, _start() {} } });
  const bytes = new Uint8Array(memory.buffer), view = new DataView(memory.buffer);
  bytes.set(encoder.encode("data/blob"), 4096); bytes.set(encoder.encode("data"), 4200); bytes.set(new Uint8Array(64).fill(66), 8192);
  view.setUint32(256, 8192, true); view.setUint32(260, 64, true);
  function open(ptr = 4096, len = 9, flags = 0) {
    assert(api.path_open(3, 0, ptr, len, flags, rights, rights, 0, 1024) === 0, "open");
    return view.getUint32(1024, true);
  }
  const fd = open(), dir = open(4200, 4, 2);
  const calls: Record<string, () => number> = {
    fd_write: () => api.fd_write(fd, 256, 1, 1024),
    fd_read: () => api.fd_read(fd, 256, 1, 1024),
    fd_readdir: () => api.fd_readdir(dir, 16384, 32768, 0n, 1024),
    path_filestat_get: () => api.path_filestat_get(3, 0, 4096, 9, 2048),
    path_open: () => api.path_open(3, 0, 4096, 9, 0, rights, rights, 0, 1024),
  };
  const call = calls[name]!;
  for (let i = 0; i < 200; i++) { assert(call() === 0, `warm ${name}`); if (name === "path_open") api.fd_close(view.getUint32(1024, true)); }
  api.fd_seek(fd, 0n, 0, 1024);
  let ms = 0, checks = 0;
  if (name === "path_open") {
    for (let at = 0; at < n; at += 64) {
      const ids: number[] = [], count = Math.min(64, n - at), started = performance.now();
      for (let j = 0; j < count; j++) { checks |= call(); ids.push(view.getUint32(1024, true)); }
      ms += performance.now() - started;
      for (const id of ids) api.fd_close(id);
    }
  } else { const started = performance.now(); for (let i = 0; i < n; i++) checks |= call(); ms = performance.now() - started; }
  assert(checks === 0, `${arm} ${name}: errno ${checks}`);
  if (name === "fd_read" || name === "fd_write") assert(view.getUint32(1024, true) === 64, "full I/O");
  core.descriptors.dispose();
  if (arm === "head") fs.dispose();
  return { arm, syscall: name, calls: n, ms, nsPerCall: ms * 1e6 / n };
}
self.onmessage = ({ data }) => {
  try { self.postMessage({ result: micro(data.arm, data.name, data.n, data.connection) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.stack : String(error) }); }
};
