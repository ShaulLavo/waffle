import type { WatchBatch } from "../fs/watch.js";

export class FilesystemError extends Error {
  constructor(
    public errno: number,
    message = `filesystem errno ${errno}`,
  ) {
    super(message);
  }
}

/** Opaque filesystem-owned identity. Open handles remain valid across rename and unlink. */
export type FileHandle = number;
/** What `FileSystem.probe` looks for: a regular file or a directory. */
export type ProbeKind = "file" | "directory";
/** Most pathnames one `probe` call looks up. */
export const PROBE_PATH_LIMIT = 64;
export interface FilePermissions {
  mode: number;
  modeSupported: number;
  access: number;
  accessSupported: number;
}

/** One virtual principal; regular-file execution belongs to the program registry. */
export function permissionsFor(kind: FileStat["kind"], mode: number): FilePermissions {
  const accessSupported = kind === "directory" ? 7 : 6;
  return {
    mode,
    modeSupported: kind === "directory" ? 0o1700 : 0o600,
    access: (mode >>> 6) & accessSupported,
    accessSupported,
  };
}

/** File times are unsigned nanoseconds since 1970, as WASI Preview 1 carries them. A number
 * cannot hold them exactly, so the guest-facing filesystem keeps them as bigint. */
export type FileTime = bigint;
export const NS_PER_MS = 1_000_000n;
export const MAX_FILE_TIME: FileTime = 0xffff_ffff_ffff_ffffn;
// Captured at load: guest code shares this realm and may replace the global later.
const bigint = BigInt;
const number = Number;
// Writes in the same millisecond reuse one bigint instead of allocating two per write.
let lastMs = Number.NaN;
let lastTime: FileTime = 0n;
/** A whole-millisecond clock reading as a file time. */
export function msFileTime(ms: number): FileTime {
  if (ms !== lastMs) {
    lastTime = bigint(ms) * NS_PER_MS;
    lastMs = ms;
  }
  return lastTime;
}
/** The filesystem clock. Like Linux's coarse file-time clock, it has millisecond granularity. */
export function fileTimeNow(): FileTime {
  return msFileTime(Date.now());
}
/** Whole milliseconds, the unit of the host workspace layer. */
export function fileTimeMs(time: FileTime): number {
  return number(time / NS_PER_MS);
}
export function isFileTime(value: unknown): value is FileTime {
  return typeof value === "bigint" && value >= 0n && value <= MAX_FILE_TIME;
}

export interface FileStat {
  kind: "file" | "directory" | "socket" | "symlink";
  ino: number;
  nlink: number;
  size: number;
  atime: FileTime;
  mtime: FileTime;
  ctime: FileTime;
  /** Absent means unsupported, not mode zero. */
  mode?: number;
}
export interface DirectoryEntry {
  name: string;
  ino: number;
  kind: FileStat["kind"];
}
export interface SocketBinding {
  readonly node: FileHandle;
  readonly parent: FileHandle;
  readonly ino: number;
  readonly parentIno: number;
}
export interface ResolvedPath {
  parent: FileHandle | undefined;
  name: string;
  node: FileHandle | undefined;
  trailingSlash: boolean;
  terminalDot: boolean;
}
/** Synchronous preview1 boundary; a worker-backed client can implement the same operations.
 * Path/status operations use positive WASI errno; I/O uses byte counts or negative errno.
 * No tree nodes or owned file buffers cross this interface.
 */
export interface FileSystem {
  preopen(path: string): FileHandle;
  /** One retain/release pair per open description; duplicates share that lifetime. */
  retain(handle: FileHandle): void;
  release(handle: FileHandle): void;
  /** `rooted` resolves in the guest's root namespace, as Linux does: an absolute link target
   * restarts at the filesystem root and `..` climbs above `directory`, stopping at the root.
   * Without it a lookup stays beneath `directory` and an escape is EPERM. */
  resolve(
    directory: FileHandle,
    path: string,
    followFinal?: boolean,
    rooted?: boolean,
  ): ResolvedPath | number;
  /** realpath(3) in one lookup: `path` from `directory` with every link followed. Rooted, an
   * absolute path from the root; otherwise relative to `directory` ("." for itself). Positive
   * WASI errno on failure. */
  realpath(directory: FileHandle, path: string, rooted?: boolean): string | number;
  /** The index of the first of `paths` that names a `kind` node, each looked up from `directory`
   * with every link followed (a stat with the follow flag), or -1 when none does. A path that
   * fails to resolve does not match. A bad `directory` throws a FilesystemError. */
  probe(directory: FileHandle, paths: readonly string[], kind: ProbeKind, rooted?: boolean): number;
  symlink(path: ResolvedPath, target: string): number;
  readlink(handle: FileHandle): string;
  stat(handle: FileHandle): FileStat;
  /** Supported clear bits deny access; unsupported bits carry no answer. */
  permissions?(handle: FileHandle): FilePermissions | undefined;
  /** Bytes transferred, or negative WASI errno; errors must not advance the open offset. */
  read(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number;
  /** Bytes transferred, or negative WASI errno; partial success returns its byte count. */
  write(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number;
  /** Select EOF and write all chunks atomically. Success includes the resulting description offset;
   * failure is negative WASI errno. A partial write reports only its committed bytes and offset. */
  append(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
  ): { written: number; offset: number } | number;
  /** Zero on success, positive WASI errno on failure. */
  resize(handle: FileHandle, size: number, truncate: boolean): number;
  /** Set each given time; null leaves it alone. Any change also sets ctime to now.
   * Zero on success, positive WASI errno on failure. */
  setTimes(handle: FileHandle, atime: FileTime | null, mtime: FileTime | null): number;
  /** Explicit durability barrier; pure-memory filesystems need no storage work. */
  sync?(handle: FileHandle): number;
  /** Throws FilesystemError for mode denial and other filesystem failures. */
  readdir(handle: FileHandle): DirectoryEntry[];
  /** Preview1 bytes after cookie, bounded by unsigned 32-bit byteLength, including a partial dirent. */
  readdirPage(handle: FileHandle, cookie: bigint, byteLength: number): Uint8Array;
  /** Atomically create at parent/name; exclusive rejects existing entries. Nonexclusive file
   * creation returns the current entry, even if it appeared after resolve. */
  create(
    path: ResolvedPath,
    kind: "file" | "directory" | "socket",
    exclusive?: boolean,
  ): FileHandle | { error: number };
  bindSocket(parent: FileHandle, name: string, lease: number): SocketBinding | { error: number };
  unbindSocket(binding: SocketBinding, name: string, lease: number, unlink: boolean): number;
  connectSocket(directory: FileHandle, path: string): { ino: number } | { error: number };
  link(from: ResolvedPath, to: ResolvedPath): number;
  removePath(path: ResolvedPath, directory: boolean): number;
  rename(from: ResolvedPath, to: ResolvedPath): number;
  /** Synchronous committed-watch subscriptions for guest imports; absent means ENOTSUP. */
  readonly watches?: WatchFileSystem;
  /** Advisory whole-file (flock) and byte-range (fcntl) locks; absent means ENOTSUP. */
  readonly locks?: FileLockSystem;
}

/** Advisory whole-file lock operations matching sys/file.h (flock(2)). */
export const LOCK_SH = 1;
export const LOCK_EX = 2;
export const LOCK_NB = 4;
export const LOCK_UN = 8;

/** Advisory byte-range lock commands (fcntl(2) POSIX and OFD locks). */
export const F_GETLK = 0;
export const F_SETLK = 1;
export const F_SETLKW = 2;
export const F_OFD_GETLK = 3;
export const F_OFD_SETLK = 4;
export const F_OFD_SETLKW = 5;

/** Advisory byte-range lock types (fcntl(2)). */
export const F_RDLCK = 0;
export const F_WRLCK = 1;
export const F_UNLCK = 2;

export interface FileLockRange {
  readonly type: 0 | 1 | 2;
  readonly start: number;
  /** Length in bytes; 0 means to EOF (infinity). */
  readonly len: number;
}

export interface FileLockConflict {
  readonly type: 0 | 1 | 2;
  readonly pid: number;
  readonly start: number;
  readonly len: number;
}

export interface LockWaitControl {
  /** Returns true when a signal is pending so a blocking lock wait returns EINTR. */
  interruptPending?(): boolean;
  /** Optional custom wait hook for deterministic tests or embedders. */
  wait?(word: Int32Array, expected: number, milliseconds: number): void;
}

/** Advisory file-lock service attached to a FileSystem. */
export interface FileLockSystem {
  /** Session owner token used to namespace local OFD lock IDs across workers (0 for MemFS). */
  readonly owner?: number;
  flock(handle: FileHandle, ofdId: string, operation: number, control?: LockWaitControl): number;
  setRangeLock(
    handle: FileHandle,
    ofdId: string | undefined,
    pid: number,
    range: FileLockRange,
    blocking: boolean,
    control?: LockWaitControl,
  ): number;
  getRangeLock(
    handle: FileHandle,
    ofdId: string | undefined,
    range: FileLockRange,
  ): FileLockConflict | number;
  releaseOfd(handle: FileHandle, ofdId: string): void;
  releasePosix(handle: FileHandle): void;
}

/** One ready subscription returned by a batched owner drain. */
export type WatchDrainEntry =
  | { readonly id: number; readonly batch: WatchBatch }
  | { readonly id: number; readonly errno: number };

export interface WatchDrainResult {
  readonly entries: readonly WatchDrainEntry[];
  readonly more: boolean;
}

/** The opener's filesystem session owns each subscription; session close releases them all. */
export interface WatchFileSystem {
  /** The root's watch cells. Index 3 counts committed watch records. */
  readonly cells: Int32Array;
  readonly revoked: boolean;
  /** True when watches are served remotely (attach mode); disables local-generation short-circuit. */
  readonly remote?: boolean;
  /** True when `drain()` is currently supported by the active backend role. Defaults to `typeof drain === "function"`. */
  readonly canDrain?: boolean;
  /** Throws FilesystemError. */
  open(handle: FileHandle, recursive: boolean): number;
  read(id: number): WatchBatch;
  /** Optional batched drain of ready watches for this session in one round trip. */
  drain?(): WatchDrainResult;
  close(id: number): void;
}
