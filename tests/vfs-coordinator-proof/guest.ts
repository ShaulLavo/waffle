import { Wasi } from "../../core/wasi.js";
import { GuestFilesystem } from "./guest-filesystem.js";
import { guestModule } from "./wasm.js";

function call(instance: WebAssembly.Instance, method: string, args: (number | bigint)[]): number {
  const fn = instance.exports[method];
  if (typeof fn !== "function") throw new Error(`Missing Wasm export ${method}`);
  const errno: unknown = Reflect.apply(fn, undefined, args);
  if (typeof errno !== "number" || errno !== 0)
    throw new Error(`${method}: errno ${String(errno)}`);
  return errno;
}
function run(input: { shared: SharedArrayBuffer; path: string; value: string }) {
  const fs = new GuestFilesystem(input.shared);
  const errors: string[] = [];
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    stdout() {},
    stderr(bytes) {
      errors.push(new TextDecoder().decode(bytes));
    },
    sleep() {},
  });
  const module = guestModule();
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Missing guest memory");
  wasi.start(instance);
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const path = new TextEncoder().encode(input.path.replace(/^\//, ""));
  bytes.set(path, 256);
  const rights = (1n << 29n) - 1n;
  call(instance, "path_open", [3, 0, 256, path.length, 0, rights, rights, 1, 1024]);
  const fd = view.getUint32(1024, true);
  const payload = new TextEncoder().encode(input.value);
  bytes.set(payload, 2048);
  view.setUint32(0, 2048, true);
  view.setUint32(4, payload.length, true);
  call(instance, "fd_write", [fd, 0, 1, 1040]);
  const written = view.getUint32(1040, true);
  call(instance, "fd_close", [fd]);
  call(instance, "path_open", [3, 0, 256, path.length, 0, rights, rights, 0, 1024]);
  const readFd = view.getUint32(1024, true);
  view.setUint32(16, 4096, true);
  view.setUint32(20, 1024, true);
  call(instance, "fd_read", [readFd, 16, 1, 1044]);
  const read = new TextDecoder().decode(bytes.subarray(4096, 4096 + view.getUint32(1044, true)));
  if (!read.endsWith(input.value)) throw new Error("Guest read-after-ACK mismatch");
  call(instance, "fd_close", [readFd]);
  const renamed = new TextEncoder().encode(`${input.path.replace(/^\//, "")}.guest`);
  bytes.set(renamed, 512);
  call(instance, "path_rename", [3, 256, path.length, 3, 512, renamed.length]);
  wasi.descriptors.dispose();
  return { kind: "guest-complete", written, read, errors, wasm: true, wasi: true };
}
globalThis.onmessage = (
  event: MessageEvent<{ shared: SharedArrayBuffer; path: string; value: string }>,
) => {
  try {
    globalThis.postMessage(run(event.data));
  } catch (error) {
    globalThis.postMessage({ kind: "guest-error", error: String(error) });
  }
};
