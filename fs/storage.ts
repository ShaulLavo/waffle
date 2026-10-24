import {
  snapshotPublicationCheckpoint,
  type PublicationCut,
  type PublicationReceipt,
} from "./publication.js";
import type { PublicationLimits } from "./publication-internal.js";
import {
  parseStoredIdentity,
  type StoredIdentity,
  type IdentityReservation,
} from "./file-identity.js";
import { permissionsFor } from "../core/filesystem.js";
/** Durable inode metadata. Payload keys are immutable, including across snapshots. */
export interface PersistedNode {
  identity?: StoredIdentity;
  ino: number;
  kind: "file" | "dir";
  mtime: number;
  /** Absent only in saved metadata predating permission adoption. */
  mode?: number;
  size: number;
  children?: [string, number][];
  data?: string;
}

export interface CheckpointPublication {
  readonly kind: "settled-publication-v1";
  readonly cut: PublicationCut;
  readonly sessionSerial: number;
  readonly limits: PublicationLimits;
  readonly receipts: readonly PublicationReceipt[];
  readonly changes: readonly Uint8Array[];
  readonly contentVersions: readonly { readonly ino: number; readonly version: number }[];
}

export interface PersistedIndex {
  publication?: CheckpointPublication;
  version: 1;
  generation: number;
  root: number;
  nodes: PersistedNode[];
}

/** One logical generation. Unchanged inode and immutable payload identities are preserved. */
export interface PersistenceBatch {
  publication?: CheckpointPublication;
  generation: number;
  root: number;
  upserts: PersistedNode[];
  removes: number[];
  data: Map<string, Uint8Array>;
  /** Runtime-only pins, for example cold open-but-unlinked files. Never restored on reload. */
  retainedData?: string[];
}

/** Snapshot before enqueueing so caller mutation cannot change pending persistence. */
export function snapshotBatch(batch: PersistenceBatch): PersistenceBatch {
  return {
    ...structuredClone({
      generation: batch.generation,
      root: batch.root,
      upserts: batch.upserts,
      removes: batch.removes,
      retainedData: batch.retainedData,
    }),
    ...(batch.publication ? { publication: snapshotPublicationCheckpoint(batch.publication) } : {}),
    data: new Map(Array.from(batch.data, ([key, bytes]) => [key, new Uint8Array(bytes)])),
  };
}

export interface StorageBackend {
  reserveIdentity(workspace?: string): Promise<IdentityReservation>;
  load(): Promise<PersistedIndex | undefined>;
  read(key: string): Promise<Uint8Array>;
  readRange(
    key: string,
    range: { offset: number; length: number; signal?: AbortSignal },
  ): Promise<Uint8Array>;
  retainPayload(
    key: string,
    expectedSize: number,
    metadata?: ReaderMetadataBudget,
  ): PayloadRetention;
  persist(batch: PersistenceBatch): Promise<void>;
  /** Make the selected immutable payloads durable; omitted means all outstanding payloads. */
  flush(keys?: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export interface ChecksummedRecord {
  json: string;
  checksum: string;
}

function invalid(): never {
  throw new Error("Invalid persisted filesystem metadata");
}
export function validInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateMode(node: PersistedNode): void {
  if (node.mode === undefined) return;
  const mask = permissionsFor(node.kind === "dir" ? "directory" : "file", 0).modeSupported;
  if (!validInteger(node.mode) || node.mode > mask || (node.mode & ~mask) !== 0) invalid();
}

export function validatePersistedNode(value: unknown): asserts value is PersistedNode {
  if (!value || typeof value !== "object") invalid();
  const node = value as PersistedNode;
  if (!validInteger(node.ino) || !validInteger(node.size) || !Number.isFinite(node.mtime))
    invalid();
  validateMode(node);
  if (node.identity !== undefined) parseStoredIdentity(node.identity);
  if (node.kind === "file") {
    if (
      node.children !== undefined ||
      (node.data !== undefined && (typeof node.data !== "string" || !node.data)) ||
      (node.size > 0 && node.data === undefined)
    )
      invalid();
  } else if (node.kind === "dir") {
    if (node.data !== undefined || !Array.isArray(node.children)) invalid();
    const names = new Set<string>();
    for (const entry of node.children) {
      if (!Array.isArray(entry) || entry.length !== 2) invalid();
      const [name, ino] = entry;
      if (
        typeof name !== "string" ||
        !name ||
        name === "." ||
        name === ".." ||
        /[/\0]/.test(name) ||
        !validInteger(ino) ||
        names.has(name)
      )
        invalid();
      names.add(name);
    }
  } else invalid();
}

export function validatePersistedIndex(value: unknown): asserts value is PersistedIndex {
  if (!value || typeof value !== "object") invalid();
  const index = value as PersistedIndex;
  if (
    index.version !== 1 ||
    !validInteger(index.generation) ||
    !validInteger(index.root) ||
    !Array.isArray(index.nodes)
  )
    invalid();
  if (index.publication !== undefined) snapshotPublicationCheckpoint(index.publication);
  const nodes = new Map<number, PersistedNode>();
  for (const node of index.nodes) {
    validatePersistedNode(node);
    if (nodes.has(node.ino)) invalid();
    nodes.set(node.ino, node);
  }
  if (nodes.get(index.root)?.kind !== "dir") invalid();
  const identity = nodes.get(index.root)?.identity;
  const ids = new Set<string>();
  for (const node of nodes.values()) {
    if (!!node.identity !== !!identity) invalid();
    if (!node.identity) continue;
    if (node.identity.workspace !== identity?.workspace || ids.has(node.identity.id)) invalid();
    ids.add(node.identity.id);
  }
  const seen = new Set<number>();
  const pending = [index.root];
  while (pending.length) {
    const ino = pending.pop()!;
    const node = nodes.get(ino);
    if (!node) invalid();
    if (seen.has(ino)) {
      if (node.kind === "dir") invalid();
      continue;
    }
    seen.add(ino);
    if (node.kind === "dir") for (const [, child] of node.children!) pending.push(child);
  }
  if (seen.size !== nodes.size) invalid();
}

async function checksum(json: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function encodeRecord(value: unknown): Promise<ChecksummedRecord> {
  const json = JSON.stringify(value);
  return { json, checksum: await checksum(json) };
}

export async function decodeRecord(value: unknown): Promise<unknown> {
  if (!value || typeof value !== "object") return undefined;
  const record = value as ChecksummedRecord;
  if (
    typeof record.json !== "string" ||
    typeof record.checksum !== "string" ||
    (await checksum(record.json)) !== record.checksum
  )
    return undefined;
  try {
    return JSON.parse(record.json);
  } catch {
    return undefined;
  }
}

type PublicationWire = Omit<CheckpointPublication, "changes"> & {
  changes: number[][];
};
type PersistedIndexWire = Omit<PersistedIndex, "publication"> & {
  publication?: PublicationWire;
};

function encodeSnapshotWire(index: PersistedIndex): PersistedIndexWire {
  const { publication, ...snapshot } = index;
  if (!publication) return snapshot;
  return {
    ...snapshot,
    publication: {
      ...publication,
      changes: publication.changes.map((change) => Array.from(change)),
    },
  };
}

function decodeChangeBytes(value: unknown): Uint8Array {
  if (!Array.isArray(value) || !value.every((byte) => validInteger(byte) && byte <= 255)) invalid();
  return Uint8Array.from(value);
}

function decodeSnapshotWire(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("publication" in value)) return value;
  const publication = value.publication;
  if (publication === undefined) return value;
  if (!publication || typeof publication !== "object" || !("changes" in publication)) invalid();
  if (!Array.isArray(publication.changes)) invalid();
  return {
    ...value,
    publication: {
      ...publication,
      changes: publication.changes.map(decodeChangeBytes),
    },
  };
}

export async function encodeSnapshot(index: PersistedIndex): Promise<ChecksummedRecord> {
  validatePersistedIndex(index);
  return encodeRecord(encodeSnapshotWire(index));
}

export async function decodeSnapshot(value: unknown): Promise<PersistedIndex | undefined> {
  const record = await decodeRecord(value);
  try {
    const index = decodeSnapshotWire(record);
    validatePersistedIndex(index);
    return index;
  } catch {
    return undefined;
  }
}

export interface ReaderMetadataBudget {
  takeMetadata(bytes: number): void;
  releaseMetadata(bytes: number): void;
}
export interface PayloadRetention {
  release(): void;
}
export class PayloadRetentionPressure extends Error {}
export class PayloadMetadataPressure extends Error {}
export class PayloadCorruption extends Error {}

/** Runtime references, never recovery metadata. Released reader-only keys stay charged until deletion. */
export class PayloadRetentions {
  private readonly entries = new Map<
    string,
    {
      size: number;
      refs: number;
      metadata: number;
      budget?: ReaderMetadataBudget;
    }
  >();
  private metadata = 0;
  private metadataPeak = 0;
  private roots: ReadonlySet<string> = new Set();
  private bytes = 0;
  private peak = 0;
  size(key: string): number | undefined {
    return this.entries.get(key)?.size;
  }
  has(key: string): boolean {
    return (this.entries.get(key)?.refs ?? 0) > 0;
  }
  retain(key: string, size: number, budget?: ReaderMetadataBudget): PayloadRetention {
    const entry = this.entry(key, size, budget);
    if (budget && entry.budget !== budget) {
      if (entry.budget) throw new PayloadMetadataPressure();
      budget.takeMetadata(entry.metadata);
      entry.budget = budget;
    }
    entry.refs++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        entry.refs--;
        if (!entry.refs && this.roots.has(key)) this.deleted(key);
      },
    };
  }
  private entry(key: string, size: number, budget?: ReaderMetadataBudget) {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.size !== size) throw new Error("Retained payload size mismatch");
      return existing;
    }
    if (size > 512 * 1024 * 1024 - this.bytes) throw new PayloadRetentionPressure();
    const metadata = 256 + key.length * 2;
    if (metadata > 2 * 1024 * 1024 - this.metadata) throw new PayloadMetadataPressure();
    budget?.takeMetadata(metadata);
    const entry: { size: number; refs: number; metadata: number; budget?: ReaderMetadataBudget } = {
      size,
      refs: 0,
      metadata,
      budget,
    };
    this.entries.set(key, entry);
    this.bytes += size;
    this.peak = Math.max(this.peak, this.bytes);
    this.metadata += metadata;
    this.metadataPeak = Math.max(this.metadataPeak, this.metadata);
    return entry;
  }
  recovery(roots: ReadonlySet<string>): void {
    this.roots = roots;
    for (const [key, entry] of this.entries) {
      if (!entry.refs && roots.has(key)) this.deleted(key);
    }
  }
  deleted(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.refs) throw new Error("Deleting retained payload");
    this.bytes -= entry.size;
    this.metadata -= entry.metadata;
    entry.budget?.releaseMetadata(entry.metadata);
    this.entries.delete(key);
  }
  resources(): Record<string, number> {
    let debt = 0;
    for (const [key, entry] of this.entries)
      if (!entry.refs && !this.roots.has(key)) debt += entry.size;
    return {
      readerStorageMetadataBytes: this.metadata,
      readerStorageMetadataPeak: this.metadataPeak,
      readerStorageBytes: this.bytes,
      readerStorageDebt: debt,
      readerStoragePeak: this.peak,
    };
  }
}
