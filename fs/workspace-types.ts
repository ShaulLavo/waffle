import type { FileId, FileVersion } from "./file-identity.js";
export type { FileId, FileVersion } from "./file-identity.js";

export type Generation = bigint & { readonly __brand: "Generation" };
export type ChangeSeq = bigint & { readonly __brand: "ChangeSeq" };
export interface Watermark {
  readonly history: string;
  readonly seq: ChangeSeq;
}
export interface NamespaceCut {
  readonly workspace: string;
  readonly generation: Generation;
  readonly watermark: Watermark;
}
export type NodeMetadata =
  | { readonly kind: "file" | "directory"; readonly target?: never }
  | { readonly kind: "symlink"; readonly target: string };
export type InodeMetadata =
  | { readonly nodeKind: "file" | "directory"; readonly target?: never }
  | { readonly nodeKind: "symlink"; readonly target: string };
export type NamespaceEntry = NodeMetadata & {
  readonly id: FileId;
  readonly version: FileVersion;
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
  readonly mode: number;
};
export interface SnapshotOptions {
  readonly prefix?: string;
  readonly includeDirs?: boolean;
}
export type WorkspacePressure = {
  readonly kind: "pressure";
  readonly resource: "cursor" | "pull" | "depth" | "path" | "page" | "index" | "changes";
};
export type WorkspaceTerminal =
  | WorkspacePressure
  | { readonly kind: "stopped" }
  | { readonly kind: "cancelled" };
export type SnapshotPage =
  | { readonly kind: "entries"; readonly entries: readonly NamespaceEntry[] }
  | { readonly kind: "complete"; readonly cut: NamespaceCut }
  | { readonly kind: "restart"; readonly current: NamespaceCut }
  | WorkspaceTerminal;
export interface SnapshotCursor {
  next(): Promise<SnapshotPage>;
  close(): Promise<void>;
}
export interface HistoryGap {
  readonly kind: "gap";
  readonly current: NamespaceCut;
  /** First retained batch. Its immediate predecessor is the earliest resumable position. */
  readonly oldestAvailable: Watermark;
  readonly resync: "snapshot";
}
interface ChangedFile {
  readonly id: FileId;
  readonly version: FileVersion;
  /** Resulting historical names. Empty for a retained unlinked file. */
  readonly paths: readonly string[];
}
interface FileReference {
  readonly id: FileId;
  readonly version: FileVersion;
}
export type WorkspaceChange =
  | (ChangedFile & {
      readonly kind: "write";
      readonly range: { readonly offset: number; readonly length: number };
      readonly size: number;
    })
  | (ChangedFile & { readonly kind: "resize"; readonly size: number })
  | (ChangedFile & { readonly kind: "metadata"; readonly mode: number; readonly mtime: number })
  | (ChangedFile &
      InodeMetadata & {
        readonly kind: "inode";
        readonly mode: number;
        readonly mtime: number;
      })
  | {
      readonly kind: "entry";
      readonly parent: FileReference;
      readonly name: string;
      readonly before: FileReference | null;
      readonly after: FileReference | null;
      readonly beforePath: string | null;
      readonly afterPath: string | null;
    };
export interface ChangeBatch {
  readonly seq: ChangeSeq;
  readonly generation: Generation;
  readonly actor: string;
  readonly transaction: { readonly actor: string; readonly sequence: number };
  readonly durability: { readonly kind: "untracked" };
  readonly changes: readonly WorkspaceChange[];
}
export type WorkspaceChangePage =
  | { readonly kind: "changes"; readonly batches: readonly ChangeBatch[]; readonly next: Watermark }
  | HistoryGap
  | WorkspaceTerminal;
export type FileTarget = FileId | string;
export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}
export type VersionStat = NodeMetadata & {
  readonly id: FileId;
  readonly version: FileVersion;
  readonly cut: NamespaceCut;
  readonly size: number;
  readonly mtime: number;
  readonly mode: number;
};
export interface ReadValue {
  readonly stat: VersionStat;
  readonly range: ByteRange;
  readonly bytes: Uint8Array<ArrayBuffer>;
}
export type ReadResource =
  | "operations"
  | "leases"
  | "result-bytes"
  | "pin-bytes"
  | "retained-storage"
  | "metadata";
export type ReadFailure =
  | { readonly kind: "not-found" }
  | { readonly kind: "not-file" }
  | { readonly kind: "denied" }
  | { readonly kind: "lease-closed" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "stopped" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "version-gone"; readonly requested: FileVersion }
  | {
      readonly kind: "generation-gone";
      readonly requested: NamespaceCut;
      readonly current: NamespaceCut;
    }
  | { readonly kind: "restart"; readonly current: NamespaceCut }
  | { readonly kind: "pressure"; readonly resource: ReadResource }
  | { readonly kind: "invalid"; readonly field: "target" | "range" | "version" | "cut" }
  | { readonly kind: "io"; readonly message: string }
  | { readonly kind: "corrupt"; readonly message: string };
export type ReadOutcome<T> = { readonly kind: "ok"; readonly value: T } | ReadFailure;
export interface VersionLease {
  readonly stat: VersionStat;
  read(range?: ByteRange, signal?: AbortSignal): Promise<ReadOutcome<ReadValue>>;
  close(): Promise<void>;
}
export const WORKSPACE_READ_LIMITS = Object.freeze({
  leases: 16,
  operations: 4,
  result: 1024 * 1024,
  resultBytes: 16 * 1024 * 1024,
  pinBytes: 256 * 1024 * 1024,
  storageBytes: 512 * 1024 * 1024,
  metadata: 2 * 1024 * 1024,
  chunk: 65536,
});
export interface WorkspaceVfs {
  read(
    target: FileTarget,
    range?: ByteRange,
    atVersion?: FileVersion,
    signal?: AbortSignal,
  ): Promise<ReadOutcome<ReadValue>>;
  stat(
    target: FileTarget,
    at?: NamespaceCut,
    signal?: AbortSignal,
  ): Promise<ReadOutcome<VersionStat>>;
  pin(
    target: FileTarget,
    atVersion?: FileVersion,
    signal?: AbortSignal,
  ): Promise<ReadOutcome<VersionLease>>;
  snapshot(options?: SnapshotOptions, signal?: AbortSignal): SnapshotCursor;
  /** Pull after this owner's completed snapshot or previous returned watermark. No notification dependency. */
  changes(after: Watermark, signal?: AbortSignal): Promise<WorkspaceChangePage>;
  /** Close only this projection and its cursors, never the filesystem. */
  close(): Promise<void>;
}
export const WORKSPACE_LIMITS = Object.freeze({
  cursors: 2,
  pageEntries: 128,
  pageBytes: 64 * 1024,
  visitedEdges: 512,
  depth: 128,
  pathUnits: 4096,
  indexEdges: 65536,
  indexBytes: 2 * 1024 * 1024,
  changeBytes: 1024 * 1024,
});
