import { BigIntConstructor } from "../proc/intrinsics.js";
import { FilesystemError } from "../core/filesystem.js";
import type { PublicationConfiguration, PublicationConnection } from "./publication-internal.js";
import { decodeEffects, publicationCut, type PublicationCut } from "./publication.js";
import { MAX_IDENTITY_PART, type FileId, type FileVersion } from "./file-identity.js";
import {
  WORKSPACE_LIMITS,
  type NamespaceCut,
  type NamespaceEntry,
  type SnapshotPage,
  type Watermark,
  type Generation,
  type ChangeSeq,
} from "./workspace-types.js";

export interface WorkspaceConfiguration {
  readonly workspace: true;
}
export const workspacePublication: PublicationConfiguration = {
  observe: true,
  limits: {
    sessions: 64,
    operations: 256,
    operationsPerSession: 4,
    inputBytes: 65536,
    argumentBytes: 8192,
    effectBytes: 524288,
    effects: 512,
    resultBytes: 1024,
    logRecords: 32,
    logBytes: 16777216,
    pins: 1,
    pinBytes: 65536,
  },
};
export interface NamespaceRecord extends NamespaceEntry {
  readonly parent: FileId | null;
  readonly selected: boolean;
  readonly name: string;
}
export type NamespacePage =
  | Exclude<SnapshotPage, { kind: "entries" }>
  | {
      readonly kind: "entries";
      readonly entries: readonly NamespaceRecord[];
    };
export function namespaceCut(workspace: string, cut: PublicationCut): NamespaceCut {
  return {
    workspace,
    generation: BigIntConstructor(cut.generation) as Generation,
    watermark: { history: cut.history, seq: BigIntConstructor(cut.generation) as ChangeSeq },
  };
}
export function watermark(value: Watermark): PublicationCut {
  if (
    !value ||
    typeof value.history !== "string" ||
    typeof value.seq !== "bigint" ||
    value.seq < 0n ||
    value.seq > BigIntConstructor(Number.MAX_SAFE_INTEGER)
  )
    throw new FilesystemError(28, "invalid workspace watermark");
  return { history: value.history, generation: Number(value.seq) };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FilesystemError(29, "invalid namespace response");
  return Object.fromEntries(Object.entries(value));
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new FilesystemError(29);
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new FilesystemError(29);
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new FilesystemError(29);
  return value;
}
function identity(value: unknown): bigint {
  if (
    typeof value !== "bigint" ||
    value <= 0n ||
    value >= 1n << 128n ||
    value >> 64n === 0n ||
    (value & MAX_IDENTITY_PART) === 0n
  )
    throw new FilesystemError(29);
  return value;
}
function cut(value: unknown): NamespaceCut {
  const data = record(value),
    mark = record(data.watermark);
  if (
    typeof data.generation !== "bigint" ||
    data.generation < 0n ||
    data.generation > BigIntConstructor(Number.MAX_SAFE_INTEGER) ||
    typeof mark.seq !== "bigint" ||
    mark.seq !== data.generation
  )
    throw new FilesystemError(29);
  return {
    workspace: text(data.workspace),
    generation: data.generation as Generation,
    watermark: { history: text(mark.history), seq: mark.seq as ChangeSeq },
  };
}
function entry(value: unknown): NamespaceRecord {
  const data = record(value);
  if (typeof data.selected !== "boolean" || (data.kind !== "file" && data.kind !== "directory"))
    throw new FilesystemError(29);
  const id = identity(data.id),
    version = identity(data.version);
  if (version < id) throw new FilesystemError(29);
  return {
    id: id as FileId,
    version: version as FileVersion,
    path: text(data.path),
    name: text(data.name),
    parent: data.parent === null ? null : (identity(data.parent) as FileId),
    selected: data.selected,
    kind: data.kind,
    size: integer(data.size),
    mtime: timestamp(data.mtime),
    mode: integer(data.mode),
  };
}
export function namespacePage(value: unknown): NamespacePage {
  const data = record(value);
  switch (data.kind) {
    case "entries":
      if (!Array.isArray(data.entries) || data.entries.length > WORKSPACE_LIMITS.pageEntries)
        throw new FilesystemError(29);
      return { kind: "entries", entries: data.entries.map(entry) };
    case "complete":
      return { kind: "complete", cut: cut(data.cut) };
    case "restart":
      return { kind: "restart", current: cut(data.current) };
    case "stopped":
    case "cancelled":
      return { kind: data.kind };
    case "pressure": {
      const resource = data.resource;
      if (
        resource !== "cursor" &&
        resource !== "pull" &&
        resource !== "depth" &&
        resource !== "path" &&
        resource !== "page" &&
        resource !== "index" &&
        resource !== "changes"
      )
        throw new FilesystemError(29);
      return { kind: "pressure", resource };
    }
    default:
      throw new FilesystemError(29);
  }
}

export function workspaceChanges(value: unknown) {
  const data = record(value);
  if ((data.kind !== "changes" && data.kind !== "gap") || !Array.isArray(data.publications))
    throw new FilesystemError(29);
  const workspace = text(data.workspace);
  const current = publicationCut(data.current),
    oldestAvailable = publicationCut(data.oldestAvailable),
    next = publicationCut(data.next);
  const publications = data.publications.map((bytes: unknown) => {
    if (!(bytes instanceof Uint8Array)) throw new FilesystemError(29);
    return decodeEffects(bytes);
  });
  return {
    kind: data.kind,
    current: namespaceCut(workspace, current),
    oldestAvailable: namespaceCut(workspace, oldestAvailable).watermark,
    next: namespaceCut(workspace, next).watermark,
    publications,
  };
}

export class ReadRefusal extends Error {
  constructor(readonly failure: import("./workspace-types.js").ReadFailure) {
    super(failure.kind);
  }
}
export function readTarget(value: unknown): import("./workspace-types.js").FileTarget {
  if (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.includes("\0") &&
    value.length <= WORKSPACE_LIMITS.pathUnits
  )
    return value;
  try {
    return identity(value) as FileId;
  } catch {
    throw new ReadRefusal({ kind: "invalid", field: "target" });
  }
}
export function readVersion(value: unknown): FileVersion | undefined {
  if (value === undefined) return;
  try {
    return identity(value) as FileVersion;
  } catch {
    throw new ReadRefusal({ kind: "invalid", field: "version" });
  }
}
export function readRange(value: unknown): import("./workspace-types.js").ByteRange | undefined {
  if (value === undefined) return;
  try {
    const data = record(value),
      offset = integer(data.offset),
      length = integer(data.length);
    if (offset > Number.MAX_SAFE_INTEGER - length) throw new Error();
    return { offset, length };
  } catch {
    throw new ReadRefusal({ kind: "invalid", field: "range" });
  }
}
export function readCut(value: unknown): NamespaceCut | undefined {
  if (value === undefined) return;
  try {
    return cut(value);
  } catch {
    throw new ReadRefusal({ kind: "invalid", field: "cut" });
  }
}
export function versionStat(value: unknown): import("./workspace-types.js").VersionStat {
  const data = record(value);
  if (data.kind !== "file" && data.kind !== "directory") throw new FilesystemError(29);
  const selected = cut(data.cut);
  Object.freeze(selected.watermark);
  Object.freeze(selected);
  const id = identity(data.id),
    version = identity(data.version);
  if (version < id) throw new FilesystemError(29);
  return Object.freeze({
    id: id as FileId,
    version: version as FileVersion,
    cut: selected,
    kind: data.kind,
    size: integer(data.size),
    mtime: timestamp(data.mtime),
    mode: integer(data.mode),
  });
}
export function readFailure(value: unknown): import("./workspace-types.js").ReadFailure {
  const data = record(value);
  switch (data.kind) {
    case "not-found":
    case "not-file":
    case "denied":
    case "lease-closed":
    case "cancelled":
    case "stopped":
    case "unavailable":
      return { kind: data.kind };
    case "version-gone":
      return { kind: "version-gone", requested: identity(data.requested) as FileVersion };
    case "generation-gone":
      return {
        kind: "generation-gone",
        requested: cut(data.requested),
        current: cut(data.current),
      };
    case "restart":
      return { kind: "restart", current: cut(data.current) };
    case "pressure": {
      const resource = data.resource;
      if (
        resource !== "operations" &&
        resource !== "leases" &&
        resource !== "result-bytes" &&
        resource !== "pin-bytes" &&
        resource !== "retained-storage" &&
        resource !== "metadata"
      )
        throw new FilesystemError(29);
      return { kind: "pressure", resource };
    }
    case "invalid": {
      const field = data.field;
      if (field !== "target" && field !== "range" && field !== "version" && field !== "cut")
        throw new FilesystemError(29);
      return { kind: "invalid", field };
    }
    case "io":
    case "corrupt":
      return { kind: data.kind, message: text(data.message) };
    default:
      throw new FilesystemError(29);
  }
}
export function readReply(value: unknown): import("./workspace-types.js").ReadOutcome<unknown> {
  const data = record(value);
  return data.kind === "ok" ? { kind: "ok", value: data.value } : readFailure(value);
}
export function readOpenReply(value: unknown) {
  const data = record(value),
    extent = readRange(data.range);
  if (!extent) throw new FilesystemError(29);
  const serial = integer(data.serial),
    stat = versionStat(data.stat);
  if (!serial || extent.offset + extent.length > Math.max(stat.size, extent.offset))
    throw new FilesystemError(29);
  return { serial, stat, range: extent };
}


/** A slot cannot be reused before the service joins its serial-qualified reader owner. */
export class ReaderLifetime {
  private readonly cells: Int32Array;
  private readonly index: number;
  constructor(private readonly connection: PublicationConnection) {
    if (!connection.buffers.readerLifetimes) throw new FilesystemError(58);
    this.cells = new Int32Array(connection.buffers.readerLifetimes);
    this.index = connection.session.slot * 2;
  }
  begin(): void {
    if (this.cells[this.index] !== this.connection.session.serial && this.cells[this.index + 1] === 1)
      throw new FilesystemError(6);
    Atomics.store(this.cells, this.index, this.connection.session.serial);
    Atomics.store(this.cells, this.index + 1, 1);
  }
  finish(failed: boolean): void {
    Atomics.store(this.cells, this.index + 1, failed ? 3 : 2);
    Atomics.notify(this.cells, this.index + 1);
  }
  get drained(): boolean {
    return this.cells[this.index] === this.connection.session.serial && this.cells[this.index + 1] === 2;
  }
  async join(): Promise<void> {
    const atomics = Atomics as typeof Atomics & {
      waitAsync(array: Int32Array, index: number, value: number): { async: boolean; value: string | Promise<string> };
    };
    while (Atomics.load(this.cells, this.index) === this.connection.session.serial) {
      const state = Atomics.load(this.cells, this.index + 1);
      if (state === 3) throw new FilesystemError(29, "Reader cleanup failed");
      if (state !== 1) return;
      await atomics.waitAsync(this.cells, this.index + 1, state).value;
    }
  }
}
