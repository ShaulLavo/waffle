import type { FileSystem, FileStat, DirectoryEntry, ResolvedPath } from "../../core/filesystem.js";
import { number, object, text } from "./filesystem.js";

function path(value: unknown): ResolvedPath {
  const entry = object(value);
  return { node: entry.node === undefined ? undefined : number(entry.node),
    parent: entry.parent === undefined ? undefined : number(entry.parent), name: text(entry.name),
    trailingSlash: entry.trailingSlash === true, terminalDot: entry.terminalDot === true };
}
function kind(value: unknown): FileStat["kind"] {
  if (value !== "file" && value !== "directory") throw new Error("INVALID: file kind");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("INVALID: array");
  return value;
}
export class GuestFilesystem implements FileSystem {
  constructor(private shared: SharedArrayBuffer) {}
  private call(method: string, args: unknown[], bytes: number[] = []): unknown {
    const cells = new Int32Array(this.shared, 0, 4);
    Atomics.store(cells, 0, 0);
    globalThis.postMessage({ kind: "syscall", operation: { kind: "guest", method, args, bytes } });
    if (Atomics.wait(cells, 0, 0, 5000) === "timed-out") throw new Error("UNAVAILABLE: guest syscall deadline");
    const encoded = new Uint8Array(this.shared, 16, Atomics.load(cells, 1));
    const reply = object(JSON.parse(new TextDecoder().decode(encoded)));
    if (reply.kind !== "ok") throw new Error(text(reply.message));
    if (["write", "append", "create", "rename", "resize", "setMtime"].includes(method)) return object(reply.result).result;
    return reply.result;
  }
  preopen(value: string): number { return number(this.call("preopen", [value])); }
  retain(_handle: number): void {}
  release(_handle: number): void {}
  resolve(directory: number, value: string): ResolvedPath | number {
    const result = this.call("resolve", [directory, value]);
    return typeof result === "number" ? result : path(result);
  }
  stat(handle: number): FileStat {
    const result = object(this.call("stat", [handle]));
    return { ino: number(result.ino), size: number(result.size), mtime: number(result.mtime), kind: kind(result.kind) };
  }
  read(handle: number, chunks: readonly Uint8Array[], offset: number): number {
    let count = 0;
    for (const chunk of chunks) {
      const bytes = Uint8Array.from(array(this.call("read", [handle, chunk.length, offset + count])).map(number));
      chunk.set(bytes); count += bytes.length;
    }
    return count;
  }
  write(handle: number, chunks: readonly Uint8Array[], offset: number): number {
    return number(this.call("write", [handle, offset], chunks.flatMap((chunk) => Array.from(chunk))));
  }
  append(handle: number, chunks: readonly Uint8Array[]): { written: number; offset: number } | number {
    const result = this.call("append", [handle], chunks.flatMap((chunk) => Array.from(chunk)));
    if (typeof result === "number") return result;
    const entry = object(result);
    return { written: number(entry.written), offset: number(entry.offset) };
  }
  resize(handle: number, size: number, truncate: boolean): number { return number(this.call("resize", [handle, size, truncate])); }
  setMtime(handle: number, mtime: number): number { return number(this.call("setMtime", [handle, mtime])); }
  sync(_handle: number): number { throw new Error("UNSUPPORTED: guest fsync in bounded proof"); }
  readdir(handle: number): DirectoryEntry[] {
    return array(this.call("readdir", [handle])).map((value) => {
      const entry = object(value);
      return { name: text(entry.name), ino: number(entry.ino), kind: kind(entry.kind) };
    });
  }
  create(value: ResolvedPath, entryKind: FileStat["kind"], exclusive = false): number | { error: number } {
    const result = this.call("create", [value, entryKind, exclusive]);
    return typeof result === "number" ? result : { error: number(object(result).error) };
  }
  rename(from: ResolvedPath, to: ResolvedPath): number { return number(this.call("rename", [from, to])); }
  link(_from: ResolvedPath, _to: ResolvedPath): number { throw new Error("UNSUPPORTED: guest link"); }
  removePath(_value: ResolvedPath, _directory: boolean): number { throw new Error("UNSUPPORTED: guest unlink"); }
}
