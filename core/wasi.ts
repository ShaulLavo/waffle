import { resolveDescriptorPath, reopenDescriptor, openInode } from "./fd-reopen.js";
import { ExecutionUnwind } from "./unwind.js";
import { type ControlCells, controlLoad, controlWait } from "../proc/control.js";
import { withFileOffset } from "./open-file.js";
// WASI preview1 adapter over filesystem handles and shared open descriptions.
// Runs synchronously in a guest worker; services supply blocking I/O and readiness.

import {
  FilesystemError,
  type FileSystem,
  type FileStat,
  type ResolvedPath,
} from "./filesystem.js";
import { DescriptorTable, MAX_DESCRIPTOR, type Resource, type Stream } from "./descriptors.js";
import { memoryViews, type MemoryViews } from "./memory-views.js";

// errno
const SUCCESS = 0;
const EBADF = 8;
const EEXIST = 20;
const EINTR = 27;
const EINVAL = 28;
const EIO = 29;
const EISDIR = 31;
const ENOENT = 44;
const ENOSYS = 52;
const ENOTDIR = 54;
const ENOTSUP = 58;
const ESPIPE = 70;
const ENOTCAPABLE = 76;

// filetype
const FT_CHAR = 2;
const FT_DIR = 3;
const FT_FILE = 4;

// oflags / fdflags
const O_CREAT = 1;
const O_DIRECTORY = 2;
const O_EXCL = 4;
const O_TRUNC = 8;
const FDFLAG_APPEND = 1;

const RIGHTS_ALL = (1n << 29n) - 1n;
const RIGHT_FD_DATASYNC = 1n << 0n;
const RIGHT_FD_READ = 1n << 1n;
const RIGHT_FD_SEEK = 1n << 2n;
const RIGHT_FD_FDSTAT_SET_FLAGS = 1n << 3n;
const RIGHT_FD_SYNC = 1n << 4n;
const RIGHT_FD_TELL = 1n << 5n;
const RIGHT_FD_WRITE = 1n << 6n;
const RIGHT_FD_ADVISE = 1n << 7n;
const RIGHT_FD_ALLOCATE = 1n << 8n;
const RIGHT_PATH_CREATE_DIRECTORY = 1n << 9n;
const RIGHT_PATH_CREATE_FILE = 1n << 10n;
const RIGHT_PATH_LINK_SOURCE = 1n << 11n;
const RIGHT_PATH_LINK_TARGET = 1n << 12n;
const RIGHT_PATH_OPEN = 1n << 13n;
const RIGHT_FD_READDIR = 1n << 14n;
const RIGHT_PATH_READLINK = 1n << 15n;
const RIGHT_PATH_RENAME_SOURCE = 1n << 16n;
const RIGHT_PATH_RENAME_TARGET = 1n << 17n;
const RIGHT_PATH_FILESTAT_GET = 1n << 18n;
const RIGHT_PATH_FILESTAT_SET_SIZE = 1n << 19n;
const RIGHT_PATH_FILESTAT_SET_TIMES = 1n << 20n;
const RIGHT_FD_FILESTAT_GET = 1n << 21n;
const RIGHT_FD_FILESTAT_SET_SIZE = 1n << 22n;
const RIGHT_FD_FILESTAT_SET_TIMES = 1n << 23n;
const RIGHT_PATH_REMOVE_DIRECTORY = 1n << 25n;
const RIGHT_PATH_UNLINK_FILE = 1n << 26n;
const RIGHT_POLL_FD_READWRITE = 1n << 27n;
// wasi-libc's isatty(): character device without seek/tell rights.
const RIGHTS_TTY = RIGHTS_ALL & ~(RIGHT_FD_SEEK | RIGHT_FD_TELL);

const CLOCK_REALTIME = 0;
const SUBCLOCK_ABSTIME = 1;
const EVENTTYPE_CLOCK = 0;
const EVENTTYPE_FD_READ = 1;
const EVENTRWFLAGS_HANGUP = 1;

export class WasiExit extends ExecutionUnwind {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

export interface WasiOptions {
  args: readonly string[];
  env: Record<string, string>;
  fs: FileSystem;
  /** Explicit guest adapter namespaces; unknown imports fail before instantiation. */
  namespaces?: WebAssembly.Imports;
  /** Reserved socket number used by a guest adapter, not an ordinary descriptor. */
  hostCallFd?: number;
  /** Preopened directories: guest name -> absolute path in `fs`. */
  preopens: Record<string, string>;
  /** Child descriptor targets reserved before preopens are placed. */
  reservedFds?: readonly number[];
  /** Optional blocking stdin for subprocess pipes; absent means EOF. */
  stdin?(cap: number): Uint8Array | number;
  /** Bound endpoints replace the default terminal descriptions (for example child pipes). */
  stdio?: Partial<Record<0 | 1 | 2, Stream>>;
  stdout(data: Uint8Array): void;
  stderr(data: Uint8Array): void;
  /** Host diagnostics may follow live stderr independently of a terminal destination callback. */
  diagnostic?(data: Uint8Array): void;
  /** Blocks the calling thread for `ms` milliseconds when no shared notification exists. */
  sleep(ms: number): void;
  /** Wake word; without interruptPending, a nonzero value is ready. Poll never consumes it. */
  interrupt?: ControlCells;
  /** Nonconsuming readiness when interrupt is advisory (for example handled process signals). */
  interruptPending?(): boolean;
  /** Shared readiness wait. Preserve expected, observed before the readiness scan, to avoid
   * losing a publication. Embedders may check process liveness before and after this wait. */
  wait?(word: ControlCells, expected: number, milliseconds: number): void;
  trace?: (line: string) => void;
}

// The host's own clock and RNG, taken before anything runs: the browser engine (engine-host.js)
// replaces globalThis.performance and crypto with the runtime's polyfills, which call back into
// bun.wasm, which calls clock_time_get / random_get here.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const perfNow = performance.now.bind(performance);
const timeOrigin = performance.timeOrigin;
const getRandomValues = crypto.getRandomValues.bind(crypto);

function nowNs(clock: number): bigint {
  if (clock === CLOCK_REALTIME) {
    const ms = timeOrigin + perfNow();
    return BigInt(Math.floor(ms)) * 1_000_000n + BigInt(Math.round((ms % 1) * 1e6));
  }
  return BigInt(Math.round(perfNow() * 1e6));
}

function msToNs(ms: number): bigint {
  return BigInt(Math.floor(ms)) * 1_000_000n;
}

export class Wasi {
  private memory!: MemoryViews;
  /**
   * Host-ABI calls the guest makes through `sock_send` on HOST_CALL_FD (net/trampoline.ts,
   * installHostSlotsViaImport): `(slot, [a, b, c, d]) -> result`.
   */
  hostCall: ((slot: number, args: number[]) => number) | null = null;
  readonly descriptors = new DescriptorTable();
  private importedMemory?: WebAssembly.Memory;
  private args: Uint8Array[];
  private env: Uint8Array[];

  private readStdin(iovecs: readonly Uint8Array[]): number {
    if (!this.opts.stdin) return 0;
    const size = iovecs.reduce((n, chunk) => n + chunk.length, 0);
    if (size === 0) return 0;
    const bytes = this.opts.stdin(size);
    if (typeof bytes === "number") return 0;
    let at = 0;
    for (const chunk of iovecs) {
      const n = Math.min(chunk.length, bytes.length - at);
      chunk.set(bytes.subarray(at, at + n));
      at += n;
    }
    return at;
  }

  private writeTerminal(which: 0 | 1 | 2, chunks: readonly Uint8Array[]): number {
    const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    if (total > 0) (which === 2 ? this.opts.stderr : this.opts.stdout)(out);
    return total;
  }

  constructor(private opts: WasiOptions) {
    const reserved = new Set<number>();
    for (const fd of opts.reservedFds ?? []) {
      if (!Number.isInteger(fd) || fd < 0 || fd > MAX_DESCRIPTOR || reserved.has(fd))
        throw new RangeError("invalid or duplicate reserved descriptor number");
      reserved.add(fd);
    }
    this.args = opts.args.map((a) => encoder.encode(`${a}\0`));
    this.env = Object.entries(opts.env).map(([k, v]) => encoder.encode(`${k}=${v}\0`));
    for (const which of [0, 1, 2] as const) {
      this.descriptors.open(
        opts.stdio?.[which] ?? {
          kind: "terminal",
          read: (chunks) => (which === 0 ? this.readStdin(chunks) : 0),
          // stdin's preview1 callback may block. Async guests need an explicit nonblocking
          // endpoint supplied through stdio; they must not enter that callback accidentally.
          tryRead: which === 0 && opts.stdin ? undefined : () => 0,
          write: (chunks) => this.writeTerminal(which, chunks),
          tryWrite: (chunks) => this.writeTerminal(which, chunks),
          readiness: () => ({
            readable: true,
            writable: true,
            hangup: which === 0 && !this.opts.stdin,
          }),
        },
        RIGHTS_TTY,
        RIGHTS_TTY,
      );
    }
    // Preopens are contiguous from fd 3 in the absence of bindings, and fill only the
    // lowest gaps that incoming child targets do not reserve. This keeps libc discovery
    // bounded by the occupied prefix rather than by a sparse high descriptor.
    let fd = 3;
    for (const [name, path] of Object.entries(opts.preopens)) {
      while (reserved.has(fd) || this.descriptors.get(fd)) {
        if (fd === MAX_DESCRIPTOR) throw new RangeError("descriptor table is full");
        fd++;
      }
      if (fd > MAX_DESCRIPTOR) throw new RangeError("descriptor table is full");
      this.openFileAt(
        fd,
        { kind: "directory", handle: opts.fs.preopen(path) },
        RIGHTS_ALL,
        RIGHTS_ALL,
        name,
      );
      fd++;
    }
  }

  private openFileAt(
    fd: number,
    resource: Extract<Resource, { handle: number }>,
    base: bigint,
    inheriting: bigint,
    preopen?: string,
  ): number {
    this.opts.fs.retain(resource.handle);
    return this.descriptors.openAt(
      fd,
      resource,
      base,
      inheriting,
      () => this.opts.fs.release(resource.handle),
      preopen,
    );
  }

  /** runtime_proc uses positive errno and checks output memory before changing the inode. */
  fdReopen(fd: number, oflags: number, fdflags: number, base: bigint, out: number): number {
    try {
      return this.reopen(fd >>> 0, oflags, fdflags, base, 0n, out);
    } catch (error) {
      if (error instanceof FilesystemError) return error.errno;
      throw error;
    }
  }

  private reopen(
    source: number,
    oflags: number,
    fdflags: number,
    base: bigint,
    inheriting: bigint,
    out: number,
  ): number {
    if ((out >>> 0) + 4 > this.bytes().length) return 21;
    const result = reopenDescriptor(
      this.descriptors,
      this.opts.fs,
      source,
      oflags,
      fdflags,
      base,
      inheriting,
    );
    return this.writeResult(result, out >>> 0);
  }

  private writeResult(result: number, out: number): number {
    if (result < 0) return -result;
    this.view().setUint32(out, result, true);
    return SUCCESS;
  }

  /** Runs `_start`; returns the exit code. */
  start(instance: WebAssembly.Instance, beforeStart?: () => void): number {
    return this.launch(instance, beforeStart) ?? 0;
  }

  /** Runs `_start`; returns the `proc_exit` code, or null when `_start` returned without exiting. */
  launch(instance: WebAssembly.Instance, beforeStart?: () => void): number | null {
    const memory = instance.exports.memory ?? this.importedMemory;
    if (!(memory instanceof WebAssembly.Memory))
      throw new TypeError("guest has no exported or supplied memory");
    const start = instance.exports._start;
    if (typeof start !== "function") throw new TypeError("guest has no _start entry point");
    this.memory = memoryViews(memory);
    // Hosts commit entry after all fallible setup, with no user hook before the call.
    beforeStart?.();
    try {
      start();
      return null;
    } catch (err) {
      if (err instanceof WasiExit) return err.code;
      throw err;
    }
  }

  /** Link preview1, inode permission queries and explicit adapter imports, including memory. */
  imports(module: WebAssembly.Module): WebAssembly.Imports {
    const impl: Record<string, (...args: never[]) => number | void> = this.functions();
    const filesystem: Record<string, (...args: never[]) => number> = {
      path_permissions_get: this.pathPermissions.bind(this),
    };
    const out: WebAssembly.Imports = Object.create(null);
    this.importedMemory = undefined;
    for (const imp of WebAssembly.Module.imports(module)) {
      const ns = (out[imp.module] ??= Object.create(null));
      const supplied =
        this.opts.namespaces && Object.hasOwn(this.opts.namespaces, imp.module)
          ? this.opts.namespaces[imp.module]
          : undefined;
      const value =
        imp.module === "runtime_fs" && imp.kind === "function"
          ? Object.hasOwn(filesystem, imp.name)
            ? this.wrap(imp.name, filesystem[imp.name]!)
            : undefined
          : imp.module === "wasi_snapshot_preview1" && imp.kind === "function"
            ? Object.hasOwn(impl, imp.name)
              ? this.wrap(imp.name, impl[imp.name]!)
              : undefined
            : supplied && Object.hasOwn(supplied, imp.name)
              ? supplied[imp.name]
              : undefined;
      if (value === undefined)
        throw new TypeError(`unsupported import ${imp.module}.${imp.name} (${imp.kind})`);
      if (imp.kind === "memory") {
        if (!(value instanceof WebAssembly.Memory))
          throw new TypeError(`import ${imp.module}.${imp.name} must be WebAssembly.Memory`);
        if (this.importedMemory && this.importedMemory !== value)
          throw new TypeError("multiple imported memories are unsupported");
        this.importedMemory = value;
        this.memory = memoryViews(value);
      }
      ns[imp.name] = value;
    }
    return out;
  }

  /** Names of the preview1 functions this shim implements. */
  static implemented(): string[] {
    return Object.keys(Wasi.prototype.functions()).sort();
  }

  private wrap(name: string, fn: (...args: never[]) => number | void) {
    const trace = this.opts.trace;
    return (...args: never[]) => {
      try {
        const result = fn(...args);
        if (trace) trace(`${name}(${args.join(", ")}) = ${result}`);
        return result;
      } catch (err) {
        if (err instanceof WasiExit) throw err;
        if (err instanceof FilesystemError) return err.errno;
        (this.opts.diagnostic ?? this.opts.stderr)(
          encoder.encode(`[wasi] ${name} failed: ${String(err)}\n`),
        );
        return EIO;
      }
    };
  }

  private view(): DataView {
    return this.memory.view();
  }

  private bytes(): Uint8Array {
    return this.memory.bytes();
  }

  private str(ptr: number, len: number): string {
    return decoder.decode(this.bytes().slice(ptr, ptr + len));
  }

  private iovecs(ptr: number, count: number): Uint8Array[] {
    const view = this.view();
    const out: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const buf = view.getUint32(ptr + i * 8, true);
      const len = view.getUint32(ptr + i * 8 + 4, true);
      out.push(this.memory.range(buf, len));
    }
    return out;
  }

  private resolve(dirfd: number, ptr: number, len: number, right: bigint): ResolvedPath | number {
    const dir = this.descriptors.get(dirfd);
    if (!dir) return EBADF;
    if (dir.resource.kind !== "directory") return ENOTDIR;
    if ((dir.rightsBase & right) !== right) return ENOTCAPABLE;
    return this.opts.fs.resolve(dir.resource.handle, this.str(ptr, len));
  }

  private pathPermissions(
    fd: number,
    ptr: number,
    len: number,
    flags: number,
    out: number,
  ): number {
    if (flags !== 0) return ENOTSUP;
    const bytes = this.bytes();
    ptr >>>= 0;
    len >>>= 0;
    out >>>= 0;
    if (ptr + len > bytes.length || out + 16 > bytes.length) return 21;
    let path: string;
    try {
      path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.slice(ptr, ptr + len),
      );
    } catch {
      return EINVAL;
    }
    if (!path || path.includes("\0")) return EINVAL;
    const entry = this.descriptors.get(fd);
    if (!entry) return EBADF;
    if (entry.resource.kind !== "directory") return ENOTDIR;
    if (!(entry.rightsBase & RIGHT_PATH_FILESTAT_GET)) return ENOTCAPABLE;
    const resolved = this.opts.fs.resolve(entry.resource.handle, path);
    if (typeof resolved === "number") return resolved;
    if (resolved.node === undefined) return ENOENT;
    const result = this.opts.fs.permissions?.(resolved.node);
    if (!result) return ENOTSUP;
    const view = this.view();
    view.setUint32(out, result.mode, true);
    view.setUint32(out + 4, result.modeSupported, true);
    view.setUint32(out + 8, result.access, true);
    view.setUint32(out + 12, result.accessSupported, true);
    return SUCCESS;
  }

  private writeFilestat(ptr: number, node: FileStat | null, streamType = FT_CHAR): void {
    const view = this.view();
    const times = node ? msToNs(node.mtime) : 0n;
    view.setBigUint64(ptr, 0n, true); // dev
    view.setBigUint64(ptr + 8, BigInt(node?.ino ?? 0), true);
    view.setUint8(ptr + 16, node ? (node.kind === "directory" ? FT_DIR : FT_FILE) : streamType);
    view.setBigUint64(ptr + 24, 1n, true); // nlink
    view.setBigUint64(ptr + 32, BigInt(node?.kind === "file" ? node.size : 0), true);
    view.setBigUint64(ptr + 40, times, true);
    view.setBigUint64(ptr + 48, times, true);
    view.setBigUint64(ptr + 56, times, true);
  }

  private writeOut(
    file: Extract<Resource, { kind: "file" }>,
    iovs: number,
    count: number,
    at: number | null,
  ): number {
    if (count === 0) return 0;
    const chunks = this.iovecs(iovs, count);
    if (chunks.every((chunk) => chunk.length === 0)) return 0;
    const write = () => {
      if (at === null && file.append) {
        const result = this.opts.fs.append(file.handle, chunks);
        if (typeof result === "number") return result;
        file.offset = result.offset;
        return result.written;
      }
      const pos = at ?? file.offset;
      const written = this.opts.fs.write(file.handle, chunks, pos);
      if (written >= 0 && at === null) file.offset = pos + written;
      return written;
    };
    return at === null ? withFileOffset(file, write) : write();
  }

  private readIn(
    file: Extract<Resource, { kind: "file" }>,
    chunks: Uint8Array[],
    at: number | null,
  ): number {
    const read = () => {
      const pos = at ?? file.offset;
      const count = this.opts.fs.read(file.handle, chunks, pos);
      if (count >= 0 && at === null) file.offset = pos + count;
      return count;
    };
    return at === null ? withFileOffset(file, read) : read();
  }

  private descriptorCall<Args extends unknown[]>(
    right: bigint,
    operation: (resource: Resource, ...args: Args) => number,
  ): (fd: number, ...args: Args) => number {
    return (fd, ...args) => {
      const entry = this.descriptors.get(fd);
      if (!entry) return EBADF;
      if ((entry.rightsBase & right) !== right) return ENOTCAPABLE;
      return operation(entry.resource, ...args);
    };
  }

  private functions() {
    const sizes = (list: Uint8Array[], countPtr: number, sizePtr: number) => {
      const view = this.view();
      view.setUint32(countPtr, list.length, true);
      view.setUint32(
        sizePtr,
        list.reduce((n, a) => n + a.length, 0),
        true,
      );
      return SUCCESS;
    };
    const fill = (list: Uint8Array[], ptrs: number, buf: number) => {
      const view = this.view();
      const mem = this.bytes();
      list.forEach((item, i) => {
        view.setUint32(ptrs + i * 4, buf, true);
        mem.set(item, buf);
        buf += item.length;
      });
      return SUCCESS;
    };

    const sync = (resource: Resource) =>
      resource.kind === "file" || resource.kind === "directory"
        ? (this.opts.fs.sync?.(resource.handle) ?? SUCCESS)
        : SUCCESS;

    return {
      args_sizes_get: (countPtr: number, sizePtr: number) => sizes(this.args, countPtr, sizePtr),
      args_get: (argv: number, buf: number) => fill(this.args, argv, buf),
      environ_sizes_get: (countPtr: number, sizePtr: number) => sizes(this.env, countPtr, sizePtr),
      environ_get: (environ: number, buf: number) => fill(this.env, environ, buf),

      clock_res_get: (_id: number, ptr: number) => {
        this.view().setBigUint64(ptr, 1000n, true);
        return SUCCESS;
      },
      clock_time_get: (id: number, _precision: bigint, ptr: number) => {
        if (id > 3) return EINVAL;
        this.view().setBigUint64(ptr, nowNs(id), true);
        return SUCCESS;
      },

      fd_advise: this.descriptorCall(RIGHT_FD_ADVISE, () => SUCCESS),
      fd_allocate: this.descriptorCall(
        RIGHT_FD_ALLOCATE,
        (resource, offset: bigint, len: bigint) => {
          if (resource.kind !== "file") return EINVAL;
          return this.opts.fs.resize(resource.handle, Number(offset + len), false);
        },
      ),
      fd_close: (fd: number) => (this.descriptors.close(fd) ? SUCCESS : EBADF),
      fd_datasync: this.descriptorCall(RIGHT_FD_DATASYNC, sync),
      fd_sync: this.descriptorCall(RIGHT_FD_SYNC, sync),
      fd_fdstat_get: (fd: number, ptr: number) => {
        const entry = this.descriptors.get(fd);
        if (!entry) return EBADF;
        const view = this.view();
        const filetype =
          entry.resource.kind === "terminal"
            ? FT_CHAR
            : entry.resource.kind === "directory"
              ? FT_DIR
              : entry.resource.kind === "pipe"
                ? 0
                : FT_FILE;
        view.setUint8(ptr, filetype);
        view.setUint16(
          ptr + 2,
          entry.resource.kind === "file"
            ? ((entry.resource.fdflags ?? 0) & ~FDFLAG_APPEND) |
                (entry.resource.append ? FDFLAG_APPEND : 0)
            : 0,
          true,
        );
        view.setBigUint64(ptr + 8, entry.rightsBase, true);
        view.setBigUint64(ptr + 16, entry.rightsInheriting, true);
        return SUCCESS;
      },
      fd_fdstat_set_flags: this.descriptorCall(
        RIGHT_FD_FDSTAT_SET_FLAGS,
        (resource, flags: number) => {
          if (flags & ~31) return EINVAL;
          if (resource.kind === "file") {
            resource.fdflags = flags;
            resource.append = (flags & FDFLAG_APPEND) !== 0;
          }
          return SUCCESS;
        },
      ),
      fd_fdstat_set_rights: (fd: number, base: bigint, inheriting: bigint) => {
        const entry = this.descriptors.get(fd);
        if (!entry) return EBADF;
        base = BigInt.asUintN(64, base);
        inheriting = BigInt.asUintN(64, inheriting);
        if (
          (base & entry.rightsBase) !== base ||
          (inheriting & entry.rightsInheriting) !== inheriting
        )
          return ENOTCAPABLE;
        entry.rightsBase = base;
        entry.rightsInheriting = inheriting;
        return SUCCESS;
      },
      fd_filestat_get: this.descriptorCall(RIGHT_FD_FILESTAT_GET, (resource, ptr: number) => {
        this.writeFilestat(
          ptr,
          resource.kind === "file" || resource.kind === "directory"
            ? this.opts.fs.stat(resource.handle)
            : null,
          resource.kind === "pipe" ? 0 : FT_CHAR,
        );
        return SUCCESS;
      }),
      fd_filestat_set_size: this.descriptorCall(
        RIGHT_FD_FILESTAT_SET_SIZE,
        (resource, size: bigint) => {
          if (resource.kind !== "file") return EINVAL;
          return this.opts.fs.resize(resource.handle, Number(size), true);
        },
      ),
      fd_filestat_set_times: this.descriptorCall(
        RIGHT_FD_FILESTAT_SET_TIMES,
        (resource, _atim: bigint, mtim: bigint, flags: number) => {
          if ((resource.kind === "file" || resource.kind === "directory") && flags & 12)
            return this.opts.fs.setMtime(
              resource.handle,
              flags & 8 ? Date.now() : Number(mtim / 1_000_000n),
            );
          return SUCCESS;
        },
      ),
      fd_pread: this.descriptorCall(
        RIGHT_FD_READ | RIGHT_FD_SEEK,
        (resource, iovs: number, count: number, offset: bigint, nreadPtr: number) => {
          if (resource.kind === "directory") return EISDIR;
          if (resource.kind !== "file") return ESPIPE;
          if (offset < 0n) return EINVAL;
          return this.writeResult(
            this.readIn(resource, this.iovecs(iovs, count), Number(offset)),
            nreadPtr,
          );
        },
      ),
      fd_pwrite: this.descriptorCall(
        RIGHT_FD_WRITE | RIGHT_FD_SEEK,
        (resource, iovs: number, count: number, offset: bigint, nwrittenPtr: number) => {
          if (resource.kind === "directory") return EISDIR;
          if (resource.kind !== "file") return ESPIPE;
          if (offset < 0n) return EINVAL;
          return this.writeResult(
            this.writeOut(resource, iovs, count, Number(offset)),
            nwrittenPtr,
          );
        },
      ),
      fd_prestat_get: (fd: number, ptr: number) => {
        const entry = this.descriptors.get(fd);
        if (!entry || entry.resource.kind !== "directory" || entry.preopen === undefined)
          return EBADF;
        const view = this.view();
        view.setUint8(ptr, 0);
        view.setUint32(ptr + 4, encoder.encode(entry.preopen).length, true);
        return SUCCESS;
      },
      fd_prestat_dir_name: (fd: number, ptr: number, len: number) => {
        const entry = this.descriptors.get(fd);
        if (!entry || entry.resource.kind !== "directory" || entry.preopen === undefined)
          return EBADF;
        this.bytes().set(encoder.encode(entry.preopen).subarray(0, len), ptr);
        return SUCCESS;
      },
      fd_read: this.descriptorCall(
        RIGHT_FD_READ,
        (resource, iovs: number, count: number, nreadPtr: number) => {
          if (resource.kind === "directory") return EISDIR;
          const chunks = this.iovecs(iovs, count);
          return this.writeResult(
            resource.kind === "file" ? this.readIn(resource, chunks, null) : resource.read(chunks),
            nreadPtr,
          );
        },
      ),
      fd_readdir: this.descriptorCall(
        RIGHT_FD_READDIR,
        (resource, buf: number, bufLen: number, cookie: bigint, usedPtr: number) => {
          if (resource.kind !== "directory") return ENOTDIR;
          const list = this.opts.fs.readdir(resource.handle);
          const mem = this.bytes();
          let used = 0;
          for (let i = Number(cookie); i < list.length; i++) {
            const { name, ino, kind } = list[i]!;
            const nameBytes = encoder.encode(name);
            const record = new Uint8Array(24 + nameBytes.length);
            const rv = new DataView(record.buffer);
            rv.setBigUint64(0, BigInt(i + 1), true);
            rv.setBigUint64(8, BigInt(ino), true);
            rv.setUint32(16, nameBytes.length, true);
            rv.setUint8(20, kind === "directory" ? FT_DIR : FT_FILE);
            record.set(nameBytes, 24);
            const room = bufLen - used;
            mem.set(record.subarray(0, Math.min(room, record.length)), buf + used);
            used += Math.min(room, record.length);
            if (used >= bufLen) break;
          }
          this.view().setUint32(usedPtr, used, true);
          return SUCCESS;
        },
      ),
      fd_renumber: (from: number, to: number) => {
        return this.descriptors.renumber(from, to) ? SUCCESS : EBADF;
      },
      fd_seek: (fd: number, offset: bigint, whence: number, newOffsetPtr: number) => {
        const entry = this.descriptors.get(fd);
        if (!entry) return EBADF;
        const right = offset === 0n && whence === 1 ? RIGHT_FD_TELL | RIGHT_FD_SEEK : RIGHT_FD_SEEK;
        if (!(entry.rightsBase & right)) return ENOTCAPABLE;
        if (entry.resource.kind === "directory") return EISDIR;
        if (entry.resource.kind !== "file") return ESPIPE;
        const file = entry.resource;
        const result = withFileOffset(file, () => {
          const base =
            whence === 0
              ? 0
              : whence === 1
                ? file.offset
                : whence === 2
                  ? this.opts.fs.stat(file.handle).size
                  : NaN;
          const pos = base + Number(offset);
          if (!(pos >= 0)) return -EINVAL;
          file.offset = pos;
          this.view().setBigUint64(newOffsetPtr, BigInt(pos), true);
          return SUCCESS;
        });
        return result < 0 ? -result : result;
      },
      fd_tell: this.descriptorCall(RIGHT_FD_TELL, (resource, ptr: number) => {
        if (resource.kind !== "file") return ESPIPE;
        this.view().setBigUint64(ptr, BigInt(resource.offset), true);
        return SUCCESS;
      }),
      fd_write: this.descriptorCall(
        RIGHT_FD_WRITE,
        (resource, iovs: number, count: number, nwrittenPtr: number) => {
          if (resource.kind === "directory") return EISDIR;
          return this.writeResult(
            resource.kind === "file"
              ? this.writeOut(resource, iovs, count, null)
              : resource.write(this.iovecs(iovs, count)),
            nwrittenPtr,
          );
        },
      ),

      path_create_directory: (fd: number, ptr: number, len: number) => {
        const path = this.resolve(fd, ptr, len, RIGHT_PATH_CREATE_DIRECTORY);
        if (typeof path === "number") return path;
        if (path.node !== undefined) return EEXIST;
        const result = this.opts.fs.create(path, "directory");
        return typeof result === "number" ? SUCCESS : result.error;
      },
      path_filestat_get: (fd: number, _flags: number, ptr: number, len: number, buf: number) => {
        const path = this.resolve(fd, ptr, len, RIGHT_PATH_FILESTAT_GET);
        if (typeof path === "number") return path;
        const node = path.node;
        if (node === undefined) return ENOENT;
        this.writeFilestat(buf, this.opts.fs.stat(node));
        return SUCCESS;
      },
      path_filestat_set_times: (
        fd: number,
        _flags: number,
        ptr: number,
        len: number,
        _atim: bigint,
        mtim: bigint,
        fst: number,
      ) => {
        const path = this.resolve(fd, ptr, len, RIGHT_PATH_FILESTAT_SET_TIMES);
        if (typeof path === "number") return path;
        const node = path.node;
        if (node === undefined) return ENOENT;
        if (fst & 12)
          return this.opts.fs.setMtime(node, fst & 8 ? Date.now() : Number(mtim / 1_000_000n));
        return SUCCESS;
      },
      path_link: (
        oldFd: number,
        _flags: number,
        oldPtr: number,
        oldLen: number,
        newFd: number,
        newPtr: number,
        newLen: number,
      ) => {
        const from = this.resolve(oldFd, oldPtr, oldLen, RIGHT_PATH_LINK_SOURCE);
        if (typeof from === "number") return from;
        const to = this.resolve(newFd, newPtr, newLen, RIGHT_PATH_LINK_TARGET);
        if (typeof to === "number") return to;
        return this.opts.fs.link(from, to);
      },
      path_open: (
        fd: number,
        _dirflags: number,
        ptr: number,
        len: number,
        oflags: number,
        rightsBase: bigint,
        rightsInheriting: bigint,
        fdflags: number,
        fdOut: number,
      ) => {
        const dir = this.descriptors.get(fd);
        if (!dir) return EBADF;
        if (dir.resource.kind !== "directory") return ENOTDIR;
        if (!(dir.rightsBase & RIGHT_PATH_OPEN)) return ENOTCAPABLE;
        rightsBase = BigInt.asUintN(64, rightsBase);
        rightsInheriting = BigInt.asUintN(64, rightsInheriting);
        if (
          (rightsBase & dir.rightsInheriting) !== rightsBase ||
          (rightsInheriting & dir.rightsInheriting) !== rightsInheriting
        )
          return ENOTCAPABLE;
        if (oflags & O_CREAT && !(dir.rightsBase & RIGHT_PATH_CREATE_FILE)) return ENOTCAPABLE;
        if (oflags & O_TRUNC && !(dir.rightsBase & RIGHT_PATH_FILESTAT_SET_SIZE))
          return ENOTCAPABLE;
        const name = this.str(ptr, len);
        const alias = resolveDescriptorPath(this.descriptors, this.opts.fs, dir, name);
        if (typeof alias === "number") return alias;
        if (alias !== undefined) {
          if (!this.descriptors.get(alias.source)) return ENOENT;
          return this.reopen(alias.source, oflags, fdflags, rightsBase, rightsInheriting, fdOut);
        }
        const path = this.opts.fs.resolve(dir.resource.handle, name);
        if (typeof path === "number") return path;
        let node = path.node;
        if (node !== undefined && oflags & O_CREAT && oflags & O_EXCL) return EEXIST;
        if (node === undefined) {
          if (!(oflags & O_CREAT) || path.trailingSlash) return ENOENT;
          if (oflags & O_DIRECTORY) return EINVAL;
          const result = this.opts.fs.create(path, "file", (oflags & O_EXCL) !== 0);
          if (typeof result !== "number") return result.error;
          node = result;
        }
        return this.writeResult(
          openInode(
            this.descriptors,
            this.opts.fs,
            node,
            this.opts.fs.stat(node).kind,
            oflags,
            fdflags,
            rightsBase,
            rightsInheriting,
          ),
          fdOut,
        );
      },
      path_readlink: (fd: number, ptr: number, len: number) => {
        const path = this.resolve(fd, ptr, len, RIGHT_PATH_READLINK);
        if (typeof path === "number") return path;
        return path.node !== undefined ? EINVAL : ENOENT; // this filesystem has no symlinks
      },
      path_remove_directory: (fd: number, ptr: number, len: number) => {
        const path = this.resolve(fd, ptr, len, RIGHT_PATH_REMOVE_DIRECTORY);
        if (typeof path === "number") return path;
        return this.opts.fs.removePath(path, true);
      },
      path_rename: (
        oldFd: number,
        oldPtr: number,
        oldLen: number,
        newFd: number,
        newPtr: number,
        newLen: number,
      ) => {
        const from = this.resolve(oldFd, oldPtr, oldLen, RIGHT_PATH_RENAME_SOURCE);
        if (typeof from === "number") return from;
        const to = this.resolve(newFd, newPtr, newLen, RIGHT_PATH_RENAME_TARGET);
        if (typeof to === "number") return to;
        return this.opts.fs.rename(from, to);
      },
      path_symlink: () => ENOTSUP,
      path_unlink_file: (fd: number, ptr: number, len: number) => {
        const path = this.resolve(fd, ptr, len, RIGHT_PATH_UNLINK_FILE);
        if (typeof path === "number") return path;
        return this.opts.fs.removePath(path, false);
      },

      poll_oneoff: (inPtr: number, outPtr: number, nsubs: number, neventsPtr: number) => {
        nsubs >>>= 0;
        inPtr >>>= 0;
        const view = this.view();
        if (nsubs === 0 || nsubs * 48 > view.byteLength - inPtr) return EINVAL;
        type Event = {
          userdata: bigint;
          type: number;
          error: number;
          nbytes: bigint;
          flags: number;
        };
        const ready: Event[] = [];
        const clocks: { userdata: bigint; deadline: bigint; clock: number }[] = [];
        const subscriptions: { userdata: bigint; type: number; fd: number }[] = [];
        for (let i = 0; i < nsubs; i++) {
          const sub = inPtr + i * 48;
          const userdata = view.getBigUint64(sub, true);
          const type = view.getUint8(sub + 8);
          if (type === EVENTTYPE_CLOCK) {
            const clock = view.getUint32(sub + 16, true);
            if (clock > 3) {
              ready.push({ userdata, type, error: EINVAL, nbytes: 0n, flags: 0 });
              continue;
            }
            const timeout = view.getBigUint64(sub + 24, true);
            const abs = (view.getUint16(sub + 40, true) & SUBCLOCK_ABSTIME) !== 0;
            clocks.push({ userdata, clock, deadline: abs ? timeout : nowNs(clock) + timeout });
          } else if (type === EVENTTYPE_FD_READ || type === 2) {
            subscriptions.push({ userdata, type, fd: view.getUint32(sub + 16, true) });
          } else ready.push({ userdata, type, error: EINVAL, nbytes: 0n, flags: 0 });
        }
        for (;;) {
          let notification: ControlCells | undefined;
          let observed = 0;
          let mixedSources = false;
          const observe = (word?: ControlCells) => {
            if (
              !word ||
              typeof SharedArrayBuffer === "undefined" ||
              !(word.buffer instanceof SharedArrayBuffer) ||
              word.length !== 1
            ) {
              mixedSources = true;
            } else if (!notification) {
              notification = word;
              observed = controlLoad(word, 0);
            } else if (
              notification.buffer !== word.buffer ||
              notification.byteOffset !== word.byteOffset
            )
              mixedSources = true;
          };
          // Snapshot before checking readiness. A publisher racing the scan makes wait return
          // not-equal instead of sleeping after its only notification has already happened.
          for (const sub of subscriptions) {
            const resource = this.descriptors.get(sub.fd)?.resource;
            observe(
              resource && resource.kind !== "file" && resource.kind !== "directory"
                ? resource.notification
                : undefined,
            );
          }
          if (this.opts.interrupt) observe(this.opts.interrupt);
          if (
            this.opts.interruptPending?.() ??
            (this.opts.interrupt !== undefined && controlLoad(this.opts.interrupt, 0) !== 0)
          )
            return EINTR;
          let waitMs = Infinity;
          for (const c of clocks) {
            const remaining = c.deadline - nowNs(c.clock);
            if (remaining <= 0n)
              ready.push({
                userdata: c.userdata,
                type: EVENTTYPE_CLOCK,
                error: SUCCESS,
                nbytes: 0n,
                flags: 0,
              });
            else waitMs = Math.min(waitMs, Number(remaining) / 1e6);
          }
          for (const sub of subscriptions) {
            const entry = this.descriptors.get(sub.fd);
            const error = !entry
              ? EBADF
              : !(entry.rightsBase & RIGHT_POLL_FD_READWRITE)
                ? ENOTCAPABLE
                : SUCCESS;
            if (error) {
              ready.push({ ...sub, error, nbytes: 0n, flags: 0 });
              continue;
            }
            const resource = entry!.resource;
            const state =
              resource.kind === "file" || resource.kind === "directory"
                ? {
                    readable: true,
                    writable: true,
                    hangup: false,
                    nbytes:
                      resource.kind === "file"
                        ? Math.max(0, this.opts.fs.stat(resource.handle).size - resource.offset)
                        : 0,
                  }
                : resource.readiness();
            if (
              (sub.type === EVENTTYPE_FD_READ ? state.readable : state.writable) ||
              state.hangup
            ) {
              ready.push({
                ...sub,
                error: SUCCESS,
                nbytes: BigInt(sub.type === EVENTTYPE_FD_READ ? (state.nbytes ?? 0) : 0),
                flags: state.hangup ? EVENTRWFLAGS_HANGUP : 0,
              });
            }
          }
          if (ready.length > 0) break;
          if (
            this.opts.interruptPending?.() ??
            (this.opts.interrupt !== undefined && controlLoad(this.opts.interrupt, 0) !== 0)
          )
            return EINTR;
          // Advisory signal hints can repeat the same value after the readiness scan, losing
          // a notify before wait. Bound rescans for those as well as independent sources.
          if (mixedSources || this.opts.interruptPending) waitMs = Math.min(waitMs, 10);
          if (notification) {
            if (this.opts.wait) this.opts.wait(notification, observed, waitMs);
            else controlWait(notification, 0, observed, waitMs);
          } else this.opts.sleep(subscriptions.length > 0 ? Math.min(waitMs, 10) : waitMs);
        }
        // A service may have reentered or grown memory while waiting.
        const output = this.view();
        ready.forEach((ev, i) => {
          const at = outPtr + i * 32;
          output.setBigUint64(at, ev.userdata, true);
          output.setUint16(at + 8, ev.error, true);
          output.setUint8(at + 10, ev.type);
          output.setBigUint64(at + 16, ev.nbytes, true);
          output.setUint16(at + 24, ev.flags, true);
        });
        output.setUint32(neventsPtr, ready.length, true);
        return SUCCESS;
      },

      proc_exit: (code: number) => {
        this.descriptors.dispose();
        // Match native process exits; negative i32 values must not alias child-control errors.
        throw new WasiExit(code & 0xff);
      },
      proc_raise: () => ENOSYS,
      random_get: (ptr: number, len: number) => {
        const mem = this.bytes();
        for (let at = 0; at < len; at += 65536) {
          const chunk = new Uint8Array(Math.min(65536, len - at));
          getRandomValues(chunk);
          mem.set(chunk, ptr + at);
        }
        return SUCCESS;
      },
      sched_yield: () => SUCCESS,
      sock_accept: () => ENOTSUP,
      sock_recv: () => ENOTSUP,
      sock_send: (fd: number, siData: number, siLen: number, _flags: number, retPtr: number) => {
        if (fd !== this.opts.hostCallFd || !this.hostCall || siLen !== 5) return ENOTSUP;
        const view = this.memory.view();
        const at = siData >>> 0;
        const words = [0, 1, 2, 3, 4].map((i) => view.getInt32(at + 4 * i, true));
        const result = this.hostCall(words[0]!, words.slice(1));
        // Reacquire after reentry for hosts without length-tracking wasm views.
        this.memory.view().setInt32(retPtr >>> 0, result, true);
        return SUCCESS;
      },
      sock_shutdown: () => ENOTSUP,
    };
  }
}
