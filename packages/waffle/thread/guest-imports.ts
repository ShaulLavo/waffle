import type { FileStat } from "../core/filesystem.ts";
import {
  Uint8ArrayConstructor,
  DataViewConstructor,
  wasmMemoryBuffer,
  wasmMemoryByteLength,
  dataViewGetUint32,
  dataViewSetUint32,
  dataViewSetBigUint64,
  typedArraySet,
  cryptoGetRandomValues,
  objectCreate,
  objectHasOwn,
  objectKeys,
  wasmModuleImports,
} from "../proc/intrinsics.ts";
import { guestProcExit, type GuestTerminal } from "./entry.ts";
import type { ThreadLane } from "./lane.ts";
import type { GuestSpan, ThreadOperation } from "./protocol.ts";

const encoder = new TextEncoder();
const encode = TextEncoder.prototype.encode;
const apply = Reflect.apply;
const now = performance.now.bind(performance);
const origin = performance.timeOrigin;
const floor = Math.floor;
const integer = Number.isSafeInteger;
const number = Number;
const bigint = BigInt;
const EFAULT = 21;
const EINVAL = 28;
const EIO = 29;
type GuestFunction = (...args: never[]) => number | void;
export interface GuestImportOptions {
  readonly memory: WebAssembly.Memory;
  readonly lane: ThreadLane;
  readonly terminal: GuestTerminal;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly interrupt: Readonly<Record<string, GuestFunction>>;
}
class GuestFault extends Error {}
class GuestMemory {
  constructor(readonly memory: WebAssembly.Memory) {}
  span(pointer: number, length: number): Uint8Array {
    const address = pointer >>> 0;
    if (!integer(length) || length < 0 || address > wasmMemoryByteLength(this.memory) - length)
      throw new GuestFault();
    return new Uint8ArrayConstructor(wasmMemoryBuffer(this.memory), address, length);
  }
  view(): DataView {
    return new DataViewConstructor(wasmMemoryBuffer(this.memory));
  }
  u32(pointer: number, value: number): void {
    this.span(pointer, 4);
    dataViewSetUint32(this.view(), pointer >>> 0, value, true);
  }
  u64(pointer: number, value: bigint): void {
    this.span(pointer, 8);
    dataViewSetBigUint64(this.view(), pointer >>> 0, value, true);
  }
  iovecs(pointer: number, count: number): GuestSpan[] {
    const size = count >>> 0;
    this.span(pointer, size * 8);
    const view = this.view();
    const spans: GuestSpan[] = [];
    for (let i = 0; i < size; i++) {
      const at = (pointer >>> 0) + i * 8;
      const address = dataViewGetUint32(view, at, true);
      const length = dataViewGetUint32(view, at + 4, true);
      this.span(address, length);
      spans.push({ address, length });
    }
    return spans;
  }
}
interface Strings {
  readonly values: readonly Uint8Array[];
  readonly size: number;
}
function strings(values: readonly string[]): Strings {
  const result: Uint8Array[] = [];
  let size = 0;
  for (let i = 0; i < values.length; i++) {
    const bytes: Uint8Array = apply(encode, encoder, [`${values[i]}\0`]);
    result.push(bytes);
    size += bytes.length;
  }
  return { values: result, size };
}
function environment(env: Readonly<Record<string, string>>): Strings {
  const keys = objectKeys(env);
  const values: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    values.push(`${key}=${env[key]}`);
  }
  return strings(values);
}
function stringSizes(memory: GuestMemory, values: Strings, count: number, size: number): number {
  memory.span(count, 4);
  memory.span(size, 4);
  memory.u32(count, values.values.length);
  memory.u32(size, values.size);
  return 0;
}
function writeStrings(
  memory: GuestMemory,
  values: Strings,
  pointers: number,
  buffer: number,
): number {
  memory.span(pointers, values.values.length * 4);
  memory.span(buffer, values.size);
  let cursor = buffer >>> 0;
  for (let i = 0; i < values.values.length; i++) {
    const value = values.values[i]!;
    memory.u32((pointers >>> 0) + i * 4, cursor);
    typedArraySet(memory.span(cursor, value.length), value);
    cursor += value.length;
  }
  return 0;
}
function guarded(lane: ThreadLane, run: () => number): number {
  lane.check();
  try {
    return run();
  } catch (error) {
    if (error instanceof GuestFault) return EFAULT;
    throw error;
  }
}
function numeric(
  options: GuestImportOptions,
  memory: GuestMemory,
  request: ThreadOperation,
  out: number,
  width: 4 | 8,
): number {
  memory.span(out, width);
  const result = options.lane.call(request);
  options.lane.check();
  if (result.kind === "error") return result.errno;
  if (typeof result.value !== "number") return EIO;
  if (width === 4) memory.u32(out, result.value);
  else memory.u64(out, bigint(result.value));
  return 0;
}
function io(
  options: GuestImportOptions,
  memory: GuestMemory,
  kind: "read" | "write",
  fd: number,
  iovs: number,
  count: number,
  out: number,
  position?: bigint,
): number {
  if (position !== undefined && (position < 0n || position > 9007199254740991n)) return EINVAL;
  const spans = memory.iovecs(iovs, count);
  return numeric(
    options,
    memory,
    {
      kind,
      fd: fd >>> 0,
      spans,
      ...(position === undefined ? {} : { position: number(position) }),
    },
    out,
    4,
  );
}
function seek(
  options: GuestImportOptions,
  memory: GuestMemory,
  fd: number,
  offset: bigint,
  whence: number,
  out: number,
): number {
  if (offset < -9007199254740991n || offset > 9007199254740991n) return EINVAL;
  const selected =
    whence === 0 ? "set" : whence === 1 ? "current" : whence === 2 ? "end" : undefined;
  if (!selected) return EINVAL;
  return numeric(
    options,
    memory,
    { kind: "seek", fd: fd >>> 0, offset: number(offset), whence: selected },
    out,
    8,
  );
}
function stat(options: GuestImportOptions, memory: GuestMemory, fd: number, out: number): number {
  memory.span(out, 64);
  const result = options.lane.call({ kind: "stat", fd: fd >>> 0 });
  options.lane.check();
  if (result.kind === "error") return result.errno;
  if (typeof result.value === "number") return EIO;
  writeStat(memory, out >>> 0, result.value);
  return 0;
}
function writeStat(memory: GuestMemory, out: number, value: FileStat): void {
  const type =
    value.kind === "file" ? 4 : value.kind === "directory" ? 3 : value.kind === "socket" ? 6 : 7;
  const time = bigint(floor(value.mtime * 1_000_000));
  // The Preview 1 structure includes seven padding bytes after filetype.
  typedArraySet(memory.span(out, 64), new Uint8ArrayConstructor(64));
  memory.u64(out, 0n);
  memory.u64(out + 8, bigint(value.ino));
  memory.u32(out + 16, type);
  memory.u64(out + 24, bigint(value.nlink));
  memory.u64(out + 32, bigint(value.size));
  memory.u64(out + 40, time);
  memory.u64(out + 48, time);
  memory.u64(out + 56, time);
}
function clock(memory: GuestMemory, id: number, pointer: number): number {
  if (id !== 0 && id !== 1) return EINVAL;
  memory.span(pointer, 8);
  memory.u64(pointer, bigint(floor((now() + (id === 0 ? origin : 0)) * 1_000_000)));
  return 0;
}
function random(memory: GuestMemory, pointer: number, length: number): number {
  const size = length >>> 0;
  memory.span(pointer, size);
  for (let at = 0; at < size; at += 65536)
    cryptoGetRandomValues(memory.span((pointer >>> 0) + at, Math.min(65536, size - at)));
  return 0;
}
function wasiImports(options: GuestImportOptions): Record<string, GuestFunction> {
  const memory = new GuestMemory(options.memory);
  const args = strings(options.args);
  const env = environment(options.env);
  const run = (action: () => number) => guarded(options.lane, action);
  return {
    args_sizes_get: (count: number, size: number) =>
      run(() => stringSizes(memory, args, count, size)),
    args_get: (pointers: number, buffer: number) =>
      run(() => writeStrings(memory, args, pointers, buffer)),
    environ_sizes_get: (count: number, size: number) =>
      run(() => stringSizes(memory, env, count, size)),
    environ_get: (pointers: number, buffer: number) =>
      run(() => writeStrings(memory, env, pointers, buffer)),
    clock_time_get: (id: number, _precision: bigint, out: number) =>
      run(() => clock(memory, id, out)),
    random_get: (pointer: number, length: number) => run(() => random(memory, pointer, length)),
    sched_yield: () => run(() => 0),
    fd_read: (fd: number, iovs: number, count: number, out: number) =>
      run(() => io(options, memory, "read", fd, iovs, count, out)),
    fd_write: (fd: number, iovs: number, count: number, out: number) =>
      run(() => io(options, memory, "write", fd, iovs, count, out)),
    fd_pread: (fd: number, iovs: number, count: number, position: bigint, out: number) =>
      run(() => io(options, memory, "read", fd, iovs, count, out, position)),
    fd_pwrite: (fd: number, iovs: number, count: number, position: bigint, out: number) =>
      run(() => io(options, memory, "write", fd, iovs, count, out, position)),
    fd_seek: (fd: number, offset: bigint, whence: number, out: number) =>
      run(() => seek(options, memory, fd, offset, whence, out)),
    fd_tell: (fd: number, out: number) =>
      run(() => numeric(options, memory, { kind: "tell", fd: fd >>> 0 }, out, 8)),
    fd_filestat_get: (fd: number, out: number) => run(() => stat(options, memory, fd, out)),
    fd_close: (fd: number) =>
      run(() => {
        const result = options.lane.call({ kind: "close", fd: fd >>> 0 });
        return result.kind === "error" ? result.errno : 0;
      }),
    proc_exit: (code: number) => guestProcExit(code, options.terminal),
  };
}
export function guestImports(
  module: WebAssembly.Module,
  options: GuestImportOptions,
): WebAssembly.Imports {
  const wasi = wasiImports(options);
  const spawn = (startArg: number): number => {
    const result = options.lane.call({ kind: "spawn", startArg: startArg >>> 0 });
    if (result.kind === "error") return -result.errno;
    if (typeof result.value !== "number" || result.value <= 0 || result.value > 0x1fffffff)
      throw new Error("thread dispatcher did not create a valid TID");
    return result.value;
  };
  const imports: WebAssembly.Imports = objectCreate(null);
  const entries = wasmModuleImports(module);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const namespace = (imports[entry.module] ??= objectCreate(null));
    namespace[entry.name] = importValue(entry, options, wasi, spawn);
  }
  return imports;
}
function importValue(
  entry: WebAssembly.ModuleImportDescriptor,
  options: GuestImportOptions,
  wasi: Record<string, GuestFunction>,
  spawn: (startArg: number) => number,
): WebAssembly.ImportValue {
  if (entry.kind === "memory" && entry.module === "env" && entry.name === "memory")
    return options.memory;
  if (entry.kind !== "function")
    throw new TypeError(`unsupported thread import ${entry.module}.${entry.name}`);
  if (entry.module === "wasi_snapshot_preview1" && objectHasOwn(wasi, entry.name))
    return wasi[entry.name]!;
  if (entry.module === "wasi" && entry.name === "thread-spawn") return spawn;
  if (entry.module === "runtime_proc" && objectHasOwn(options.interrupt, entry.name))
    return options.interrupt[entry.name]!;
  throw new TypeError(`unsupported thread import ${entry.module}.${entry.name}`);
}
