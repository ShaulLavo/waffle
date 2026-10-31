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

export interface FileStat {
  kind: "file" | "directory" | "socket" | "symlink";
  ino: number;
  nlink: number;
  size: number;
  mtime: number;
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
  resolve(directory: FileHandle, path: string, followFinal?: boolean): ResolvedPath | number;
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
  /** Zero on success, positive WASI errno on failure. */
  setMtime(handle: FileHandle, mtime: number): number;
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
}

/** The opener's filesystem session owns each subscription; session close releases them all. */
export interface WatchFileSystem {
  /** The root's watch cells. Index 3 counts committed watch records. */
  readonly cells: Int32Array;
  readonly revoked: boolean;
  /** Throws FilesystemError. */
  open(handle: FileHandle, recursive: boolean): number;
  read(id: number): WatchBatch;
  close(id: number): void;
}
