import { Wasi } from "../../core/wasi.js";
import type { FileSystem } from "../../core/filesystem.js";

function text(value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [bytes.length].concat(bytes);
}
function section(id: number, payload: number[]): number[] {
  if (payload.length >= 128) throw new Error("fixture section must fit one-byte LEB");
  return [id, payload.length].concat(payload);
}
export function permissionsHost(fs: FileSystem, shared = false) {
  const module = new WebAssembly.Module(
    Uint8Array.from(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [2, 0x60, 5, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]),
        section(2, [1].concat(text("runtime_fs"), text("path_permissions_get"), [0, 0])),
        section(3, [2, 0, 1]),
        section(5, shared ? [1, 3, 1, 2] : [1, 0, 1]),
        section(
          7,
          [3].concat(text("memory"), [2, 0], text("query"), [0, 1], text("_start"), [0, 2]),
        ),
        section(
          10,
          [2, 14, 0, 0x20, 0, 0x20, 1, 0x20, 2, 0x20, 3, 0x20, 4, 0x10, 0, 0x0b, 2, 0, 0x0b],
        ),
      ),
    ),
  );
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  const { memory, query } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory) || typeof query !== "function")
    throw new Error("invalid permissions guest");
  wasi.start(instance);
  const call = (path: string, flags = 0, fd = 3, out = 512) => {
    const encoded = new TextEncoder().encode(path);
    new Uint8Array(memory.buffer, 256, encoded.length).set(encoded);
    return Number(query(fd, 256, encoded.length, flags, out));
  };
  const words = () => {
    const view = new DataView(memory.buffer);
    return Array.from({ length: 4 }, (_, index) => view.getUint32(512 + index * 4, true));
  };
  return { wasi, memory, query, call, words };
}
