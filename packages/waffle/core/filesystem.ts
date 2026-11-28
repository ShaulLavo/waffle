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
  let modeSupported = 0o600;
  if (kind === "file") modeSupported = 0o777;
  if (kind === "directory") modeSupported = 0o1777;
  return {
    mode,
    modeSupported,
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
export interface CooperativeResolveOptions {
  readonly expectedAlias: number | null;
  readonly machineId: boolean;
}
export type CooperativePath =
  | (ResolvedPath & { readonly kind: "inode" })
  | { readonly kind: "alias"; readonly logical: number }
  | { readonly kind: "null" | "machine-id" };
export interface CooperativePathLease {
  readonly result: CooperativePath;
  release(): void;
}

export function cooperativeResolveOptions(value: unknown): CooperativeResolveOptions {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "expectedAlias") ||
    !Object.hasOwn(value, "machineId")
  )
    throw new FilesystemError(28);
  const { expectedAlias, machineId } = value as Partial<CooperativeResolveOptions>;
  if (
    typeof machineId !== "boolean" ||
    (expectedAlias !== null &&
      (typeof expectedAlias !== "number" ||
        !Number.isInteger(expectedAlias) ||
        expectedAlias < 0 ||
        expectedAlias > 0xffff_ffff))
  )
    throw new FilesystemError(28);
  return { expectedAlias, machineId };
}

export function isCooperativePath(value: unknown): value is CooperativePath {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  if (result.kind === "alias")
    return (
      typeof result.logical === "number" &&
      Number.isInteger(result.logical) &&
      result.logical >= 0 &&
      result.logical <= 0xffff_ffff
    );
  if (result.kind === "null" || result.kind === "machine-id") return true;
  return (
    result.kind === "inode" &&
    typeof result.name === "string" &&
    typeof result.trailingSlash === "boolean" &&
    typeof result.terminalDot === "boolean" &&
    validLookupHandle(result.parent) &&
    validLookupHandle(result.node)
  );
}

function validLookupHandle(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

/** Adopt final handles before discarding the previous owner's lookup result. */
export function retainCooperativePath(
  fs: Pick<FileSystem, "retain" | "release">,
  result: CooperativePath,
): CooperativePathLease {
  if (result.kind !== "inode") return { result, release() {} };
  const held: FileHandle[] = [];
  const release = () => {
    for (const handle of held.splice(0)) fs.release(handle);
  };
  try {
    for (const handle of [result.parent, result.node]) {
      if (handle === undefined || held.includes(handle)) continue;
      fs.retain(handle);
      held.push(handle);
    }
    return { result, release };
  } catch (error) {
    release();
    throw error;
  }
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
  /** Single guarded lookup. Returned inode handles are held until release. */
  resolveCooperative?(
    directory: FileHandle,
    path: string,
    followFinal: boolean,
    options: CooperativeResolveOptions,
  ): CooperativePathLease | number;
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
  /** Change an inode's permission bits. Zero on success, positive WASI errno on failure. */
  setMode?(handle: FileHandle, mode: number): number;
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
  /** Stable 32-char lowercase hex machine identifier served via virtual `/etc/machine-id`. */
  readonly machineId?: string;
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
  /** Checks for fatal signals / process termination before sleeping; throws ExecutionUnwind if fatal. */
  checkActive?(): void;
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
    pid?: number,
  ): FileLockConflict | number;
  releaseOfd(handle: FileHandle, ofdId: string, inFlight?: boolean): void;
  releasePosix(handle: FileHandle, pid?: number): void;
  handoffPosix?(successorOwner: number): void;
  hasActivePosixLocks?(): boolean;
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
