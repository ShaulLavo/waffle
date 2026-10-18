import { Wasi } from "../core/wasi.js";
import type { FileSystem } from "../core/filesystem.js";
import type { WorkloadIO } from "./vfs-workloads.js";

const signatures: Record<string, readonly number[]> = {
  path_open: [0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7e, 0x7e, 0x7f, 0x7f],
  path_create_directory: [0x7f, 0x7f, 0x7f], path_rename: [0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f],
  path_unlink_file: [0x7f, 0x7f, 0x7f], path_remove_directory: [0x7f, 0x7f, 0x7f],
  path_filestat_get: [0x7f, 0x7f, 0x7f, 0x7f, 0x7f], fd_close: [0x7f], fd_sync: [0x7f],
  fd_pwrite: [0x7f, 0x7f, 0x7f, 0x7e, 0x7f], fd_pread: [0x7f, 0x7f, 0x7f, 0x7e, 0x7f],
  fd_readdir: [0x7f, 0x7f, 0x7f, 0x7e, 0x7f],
};
function leb(value: number): number[] { const bytes: number[] = []; do { const next = value & 127; value >>>= 7; bytes.push(next | (value ? 128 : 0)); } while (value); return bytes; }
function text(value: string): number[] { const bytes = Array.from(new TextEncoder().encode(value)); return leb(bytes.length).concat(bytes); }
function vector(entries: readonly number[][]): number[] { return leb(entries.length).concat(entries.flat()); }
function section(id: number, data: number[]): number[] { return [id].concat(leb(data.length), data); }
/** Original deterministic WASI-call fixture. Each exported Wasm function forwards
 * its typed arguments through an actual Wasm call instruction to preview1. Build
 * and compile before all clocks start; no SDK/download or generated binary in git.
 * The trace driver is TS, not a C/libc/application benchmark. */
export function guestFixture(): Uint8Array<ArrayBuffer> {
  const entries = Object.entries(signatures), count = entries.length;
  const types = entries.map(([, args]) => [0x60].concat(leb(args.length), Array.from(args), [1, 0x7f])).concat([[0x60, 0, 0]]);
  const imports = entries.map(([name], i) => text("wasi_snapshot_preview1").concat(text(name), [0], leb(i)));
  const functions = entries.map((_, i) => leb(i)).concat([leb(count)]);
  const exports = entries.map(([name], i) => text(name).concat([0], leb(count + i))).concat([text("memory").concat([2, 0]), text("_start").concat([0], leb(count * 2))]);
  const bodies = entries.map(([, args], i) => {
    const body = [0].concat(Array.from(args, (_, index) => [0x20].concat(leb(index))).flat(), [0x10], leb(i), [0x0b]); return leb(body.length).concat(body);
  }).concat([[2, 0, 0x0b]]);
  return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(section(1, vector(types)), section(2, vector(imports)), section(3, vector(functions)), section(5, [1, 0, 2]), section(7, vector(exports)), section(10, vector(bodies))));
}
export class GuestIO implements WorkloadIO {
  private wasi: Wasi;
  private exports: Record<string, (...args: (number | bigint)[]) => number>;
  private bytes: Uint8Array;
  private view: DataView;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private fds = new Map<string, number>();
  constructor(fs: FileSystem, module: WebAssembly.Module) {
    this.wasi = new Wasi({ fs, args: [], env: {}, preopens: { "/": "/" }, stdout() {}, stderr() {}, sleep() {} });
    const instance = new WebAssembly.Instance(module, this.wasi.imports(module)); this.wasi.start(instance);
    this.exports = instance.exports as unknown as typeof this.exports;
    const memory = instance.exports.memory as WebAssembly.Memory; this.bytes = new Uint8Array(memory.buffer); this.view = new DataView(memory.buffer);
  }
  private call(name: string, ...args: (number | bigint)[]): void {
    const error = this.exports[name]!(...args); if (error) throw Object.assign(new Error(`WASI ${name}: errno ${error}`), { errno: error });
  }
  private path(path: string, pointer = 1024): number { const bytes = this.encoder.encode(path.replace(/^\//, "")); this.bytes.set(bytes, pointer); return bytes.length; }
  private open(path: string, create = false, directory = false): number {
    const old = this.fds.get(path); if (old !== undefined) return old;
    this.call("path_open", 3, 0, 1024, this.path(path), (create ? 1 : 0) | (directory ? 2 : 0), (1n << 29n) - 1n, (1n << 29n) - 1n, 0, 128);
    const fd = this.view.getUint32(128, true); this.fds.set(path, fd); return fd;
  }
  private closePath(path: string): void { const fd = this.fds.get(path); if (fd !== undefined) { this.call("fd_close", fd); this.fds.delete(path); } }
  async mkdir(path: string): Promise<void> { this.call("path_create_directory", 3, 1024, this.path(path)); }
  async write(path: string, bytes: Uint8Array, offset?: number): Promise<void> {
    // One open description per file call; closing is part of file creation/write/close.
    const fd = this.open(path, true);
    try {
      for (let chunk = 0; chunk < bytes.length; chunk += 65536) {
        const part = bytes.subarray(chunk, chunk + 65536); this.bytes.set(part, 8192); this.view.setUint32(0, 8192, true); this.view.setUint32(4, part.length, true);
        this.call("fd_pwrite", fd, 0, 1, BigInt((offset ?? 0) + chunk), 128);
        if (this.view.getUint32(128, true) !== part.length) throw new Error("Short guest write");
      }
    } finally { this.closePath(path); }
  }
  async stat(path: string): Promise<{ size: number }> { this.call("path_filestat_get", 3, 0, 1024, this.path(path), 256); return { size: Number(this.view.getBigUint64(288, true)) }; }
  async read(path: string, offset = 0, size?: number): Promise<Uint8Array> {
    const fd = this.open(path); const out = new Uint8Array(size ?? (await this.stat(path)).size);
    try {
      for (let done = 0; done < out.length; done += 65536) {
        const count = Math.min(65536, out.length - done); this.view.setUint32(0, 8192, true); this.view.setUint32(4, count, true);
        this.call("fd_pread", fd, 0, 1, BigInt(offset + done), 128);
        if (this.view.getUint32(128, true) !== count) throw new Error("Short guest read"); out.set(this.bytes.subarray(8192, 8192 + count), done);
      }
    } finally { this.closePath(path); }
    return out;
  }
  async readdir(path: string): Promise<string[]> {
    const fd = this.open(path, false, true), result: string[] = []; let cookie = 0n;
    try {
      for (;;) {
        this.call("fd_readdir", fd, 8192, 65536, cookie, 128); const count = this.view.getUint32(128, true); if (!count) break;
        let offset = 0;
        while (offset + 24 <= count) {
          const nameLength = this.view.getUint32(8192 + offset + 16, true); if (offset + 24 + nameLength > count) break;
          cookie = this.view.getBigUint64(8192 + offset, true); result.push(this.decoder.decode(this.bytes.subarray(8192 + offset + 24, 8192 + offset + 24 + nameLength))); offset += 24 + nameLength;
        }
        if (!offset) throw new Error("Guest readdir made no progress");
      }
    } finally { this.closePath(path); }
    return result.filter(name => name !== "." && name !== "..");
  }
  async rename(from: string, to: string): Promise<void> { this.call("path_rename", 3, 1024, this.path(from), 3, 4096, this.path(to, 4096)); }
  async remove(path: string): Promise<void> {
    // W2 removes package trees; preview1 deliberately exposes unlink/rmdir separately.
    this.call("path_filestat_get", 3, 0, 1024, this.path(path), 256);
    if (this.bytes[272] === 3) { for (const name of await this.readdir(path)) await this.remove(`${path}/${name}`); this.call("path_remove_directory", 3, 1024, this.path(path)); }
    else this.call("path_unlink_file", 3, 1024, this.path(path));
  }
  async barrier(path?: string): Promise<void> { if (!path) this.call("fd_sync", 3); else { const fd = this.open(path); try { this.call("fd_sync", fd); } finally { this.closePath(path); } } }
  dispose(): void { this.wasi.descriptors.dispose(); }
}
