// Tiny WASI guest assembled here: this smoke never needs dist/ or a Rust build.
import { MemFS } from "../src/fs";
import { memoryViews } from "../src/memory-views.js";
import { Wasi } from "../src/wasi";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}
function uleb(value: number): number[] {
  const bytes: number[] = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
}
const name = (text: string) => uleb(encoder.encode(text).length).concat(Array.from(encoder.encode(text)));
const vector = (items: number[][]) => uleb(items.length).concat(items.flat());
const section = (id: number, bytes: number[]) => [id].concat(uleb(bytes.length), bytes);

function guest(): WebAssembly.Module {
  const syscalls = [
    { name: "fd_write", params: [0x7f, 0x7f, 0x7f, 0x7f] },
    { name: "fd_read", params: [0x7f, 0x7f, 0x7f, 0x7f] },
    { name: "path_open", params: [0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7e, 0x7e, 0x7f, 0x7f] },
  ];
  const types = syscalls.map(({ params }) => [0x60].concat(uleb(params.length), params, [1, 0x7f]));
  const imports = syscalls.map((call, index) => name("wasi_snapshot_preview1").concat(name(call.name), [0], uleb(index)));
  const exports = syscalls.map((call, index) => name(call.name).concat([0], uleb(index)));
  // _start calls fd_write(1, 0, 1, 8), so output actually crosses the Wasm import.
  const start = [0, 0x41, 1, 0x41, 0, 0x41, 1, 0x41, 8, 0x10, 0, 0x1a, 0x0b];
  return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, vector(types.concat([[0x60, 0, 0]]))),
    section(2, vector(imports)),
    section(3, [1, syscalls.length]),
    section(5, [1, 1, 1, 4]),
    section(7, vector(exports.concat([name("memory").concat([2, 0]), name("_start").concat([0, syscalls.length])]))),
    section(10, [1].concat(uleb(start.length), start)),
  )));
}

function smoke(fallback: boolean): string {
  const fs = new MemFS();
  fs.writeFile("/sandbox/hello.txt", "browser host file");
  fs.writeFile("/secret.txt", "outside preopen");
  const cloned = new MemFS(structuredClone(fs.root));
  equal(decoder.decode(cloned.readFile("/sandbox/hello.txt")), "browser host file", "cloned MemFS");
  let memory: WebAssembly.Memory;
  let output = "";
  const wasi = new Wasi({
    args: ["smoke"], env: {}, fs: cloned, preopens: { "/sandbox": "/sandbox" },
    stdout(bytes) { output += decoder.decode(bytes); memory.grow(1); },
    stderr() { throw new Error("unexpected stderr"); },
    sleep() { throw new Error("unexpected blocking sleep"); },
  });
  const module = guest();
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  memory = instance.exports.memory as WebAssembly.Memory;
  if (fallback) Object.defineProperty(memory, "toResizableBuffer", { value: undefined });
  const views = memoryViews(memory);
  const text = encoder.encode("browser WASI ok");
  views.bytes().set(text, 32);
  views.view().setUint32(0, 32, true);
  views.view().setUint32(4, text.length, true);
  equal(wasi.start(instance), 0, "WASI exit");
  equal(output, "browser WASI ok", "guest stdout");
  equal(views.view().getUint32(8, true), text.length, "write count after callback grows memory");
  equal(views.bytes().length, 2 * 65536, "refreshed memory size");

  const open = instance.exports.path_open as (fd: number, dirflags: number, path: number, len: number, flags: number, base: bigint, inheriting: bigint, fdflags: number, result: number) => number;
  const read = instance.exports.fd_read as (fd: number, iovs: number, count: number, result: number) => number;
  const rights = (1n << 29n) - 1n;
  function openPath(path: string, base = rights, inheriting = rights): number {
    const bytes = encoder.encode(path);
    views.bytes().set(bytes, 256);
    return open(3, 0, 256, bytes.length, 0, base, inheriting, 0, 512);
  }
  equal(openPath("../secret.txt"), 63, "preopen escape rejected");
  equal(openPath("hello.txt"), 0, "open sandbox file");
  const fd = views.view().getUint32(512, true);
  views.view().setUint32(0, 65536, true);
  views.view().setUint32(4, 64, true);
  equal(read(fd, 0, 1, 8), 0, "read file into grown page");
  const count = views.view().getUint32(8, true);
  // TextDecoder's WebIDL rejects resizable buffers; take a fixed-buffer snapshot.
  equal(decoder.decode(views.bytes().slice(65536, 65536 + count)), "browser host file", "WASI file contents");
  memory.grow(0);
  equal(views.view().getUint32(8, true), count, "zero-growth refresh");
  equal(openPath("hello.txt", 2n, 0n), 0, "open read-only file");
  const readOnlyFd = views.view().getUint32(512, true);
  const write = instance.exports.fd_write as typeof read;
  views.view().setUint32(8, 0xfeedbeef, true);
  equal(write(readOnlyFd, 0, 1, 8), 76, "write denied without descriptor rights");
  equal(views.view().getUint32(8, true), 0xfeedbeef, "denied write preserves output count");
  equal(decoder.decode(cloned.readFile("/sandbox/hello.txt")), "browser host file", "denied write preserves file");
  return fallback ? "fallback memory views" : "native memory views";
}

function unboundedMemory(): string {
  // Real browser conversion can throw for memory with no declared maximum.
  // Do not override toResizableBuffer: exercise Chromium's actual implementation.
  const memory = new WebAssembly.Memory({ initial: 1 });
  const views = memoryViews(memory);
  views.bytes()[42] = 91;
  memory.grow(0);
  equal(views.bytes()[42], 91, "unbounded zero-growth refresh");
  memory.grow(1);
  equal(views.bytes().length, 2 * 65536, "unbounded growth refresh");
  equal(views.bytes()[42], 91, "unbounded growth preserves bytes");
  views.view().setUint32(65536, 0x12345678, true);
  equal(views.view().getUint32(65536, true), 0x12345678, "unbounded grown page accessible");
  return "unbounded memory views";
}

try {
  equal(self.crossOriginIsolated, true, "isolated browser worker");
  equal(typeof SharedArrayBuffer, "function", "SharedArrayBuffer available");
  self.postMessage({ ok: true, checks: [smoke(false), smoke(true), unboundedMemory()] });
} catch (error) {
  self.postMessage({ ok: false, error: error instanceof Error ? error.stack : String(error) });
}
