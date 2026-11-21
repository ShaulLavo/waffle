import { CHUNK_SIZE, chunkChecksum, chunkError, parseChunk } from "./indexeddb-chunks.js";
import type { CaptureDelta } from "./checkpoint-mutations.js";

export const FORMAT = "waffle-checkpoint-experiment-v1";
export const WORKSPACE = "waffle-vfs-checkpoint-incremental";
const FANOUT = 32;
const MAX_LEVEL = 2;

type ChunkRef = { kind: "chunk"; id: string; size: number; checksum: string; count: 1 };
type NodeRef = { kind: "node"; id: string; count: number; level: number };
type Ref = ChunkRef | NodeRef;
type MapNode = { children: [number, Ref][] };
type Manifest = { size: number; root?: Ref };
type ReadRecord = (key: IDBValidKey, signal?: AbortSignal) => Promise<unknown>;

export interface ExperimentReceipt {
  id: string;
  parent: string | undefined;
  generation: number;
  epoch: number;
  journal: string | undefined;
  base: string | undefined;
}

export class ExperimentUnconfirmed extends Error {
  readonly resolution = Promise.withResolvers<void>();
  constructor(readonly receipt: ExperimentReceipt) {
    super("Checkpoint committed but acknowledgement was lost");
  }
}

export function sameReceipt(left: ExperimentReceipt, right: ExperimentReceipt): boolean {
  return (
    left.id === right.id &&
    left.parent === right.parent &&
    left.generation === right.generation &&
    left.epoch === right.epoch &&
    left.journal === right.journal &&
    left.base === right.base
  );
}

export function isReceipt(value: unknown): value is ExperimentReceipt {
  return (
    !!value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string" &&
    "parent" in value &&
    (typeof value.parent === "string" || value.parent === undefined) &&
    "generation" in value &&
    typeof value.generation === "number" &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    "epoch" in value &&
    typeof value.epoch === "number" &&
    Number.isSafeInteger(value.epoch) &&
    value.epoch > 0 &&
    "journal" in value &&
    (typeof value.journal === "string" || value.journal === undefined) &&
    "base" in value &&
    (typeof value.base === "string" || value.base === undefined) &&
    (typeof value.journal === "string" || typeof value.base === "string")
  );
}

function recordKey(ref: Ref): [string, string] {
  return [ref.kind, ref.id];
}

function isRef(value: unknown): value is Ref {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string")
    return false;
  if (
    !("count" in value) ||
    typeof value.count !== "number" ||
    !Number.isSafeInteger(value.count) ||
    value.count < 1
  )
    return false;
  if (!("kind" in value)) return false;
  if (value.kind === "node")
    return (
      "level" in value &&
      typeof value.level === "number" &&
      Number.isInteger(value.level) &&
      value.level >= 0 &&
      value.level <= MAX_LEVEL
    );
  return (
    value.kind === "chunk" &&
    value.count === 1 &&
    "size" in value &&
    typeof value.size === "number" &&
    Number.isInteger(value.size) &&
    value.size > 0 &&
    value.size <= CHUNK_SIZE &&
    "checksum" in value &&
    typeof value.checksum === "string" &&
    /^[a-f0-9]{64}$/.test(value.checksum)
  );
}

function isChild(value: unknown): value is [number, Ref] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isInteger(value[0]) &&
    value[0] >= 0 &&
    value[0] < FANOUT &&
    isRef(value[1])
  );
}

function isNode(value: unknown): value is MapNode {
  return (
    !!value &&
    typeof value === "object" &&
    "children" in value &&
    Array.isArray(value.children) &&
    value.children.length > 0 &&
    value.children.every(isChild)
  );
}

function isManifest(value: unknown): value is Manifest {
  return (
    !!value &&
    typeof value === "object" &&
    "size" in value &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    value.size <= CHUNK_SIZE * FANOUT ** (MAX_LEVEL + 1) &&
    (!("root" in value) || value.root === undefined || isRef(value.root))
  );
}

function capacity(level: number): number {
  return FANOUT ** (level + 1);
}

function levelFor(count: number): number {
  if (count <= 1) return -1;
  if (count <= FANOUT) return 0;
  return count <= FANOUT ** 2 ? 1 : 2;
}

interface TreeEdit {
  before: number;
  changes: ReadonlyMap<number, ChunkRef>;
  nodes: Map<string, MapNode>;
}

export interface PreparedMap {
  manifest: Manifest;
  nodes: Map<string, MapNode>;
  chunks: Map<string, { bytes: Uint8Array<ArrayBuffer>; checksum: string }>;
  metrics: {
    copied: number;
    discoveryMs: number;
    copyMs: number;
    hashMs: number;
    mapMs: number;
    reused: number;
    payloadReads: number;
  };
}

export class CheckpointMap {
  readonly manifests = new Map<string, Manifest>();
  readonly nodes = new Map<string, MapNode>();
  payloadReads = 0;

  private children(ref: NodeRef, extra?: Map<string, MapNode>): [number, Ref][] {
    const node = extra?.get(ref.id) ?? this.nodes.get(ref.id);
    if (!node) chunkError(ref.id);
    return node.children;
  }

  private editNode(
    old: Ref | undefined,
    level: number,
    start: number,
    edit: TreeEdit,
  ): Ref | undefined {
    if (level === -1) return edit.changes.get(start) ?? (start < edit.before ? old : undefined);
    if (old && start + capacity(level) <= edit.before && !edit.changes.size) return old;
    if (start >= edit.before && !edit.changes.size) return undefined;
    const oldChildren =
      old?.kind === "node" && old.level === level
        ? this.children(old, edit.nodes)
        : old
          ? [[0, old] satisfies [number, Ref]]
          : [];
    const stripe = capacity(level - 1);
    const children = new Map(oldChildren);
    const edits = new Map<number, Map<number, ChunkRef>>();
    for (const [index, change] of edit.changes) {
      const digit = Math.floor((index - start) / stripe);
      const group = edits.get(digit) ?? new Map<number, ChunkRef>();
      group.set(index, change);
      edits.set(digit, group);
    }
    const empty = new Map<number, ChunkRef>();
    for (const digit of new Set(Array.from(children.keys()).concat(Array.from(edits.keys())))) {
      const child = this.editNode(children.get(digit), level - 1, start + digit * stripe, {
        ...edit,
        changes: edits.get(digit) ?? empty,
      });
      if (child) children.set(digit, child);
      else children.delete(digit);
    }
    if (!children.size) return undefined;
    if (
      old?.kind === "node" &&
      old.level === level &&
      children.size === oldChildren.length &&
      oldChildren.every(([digit, child]) => children.get(digit) === child)
    )
      return old;
    const id = crypto.randomUUID();
    edit.nodes.set(id, { children: Array.from(children) });
    const count = Array.from(children.values()).reduce((sum, child) => sum + child.count, 0);
    return { kind: "node", id, count, level };
  }

  private at(ref: Ref | undefined, index: number): ChunkRef | undefined {
    if (!ref) return;
    if (ref.kind === "chunk") return index === 0 ? ref : undefined;
    const stripe = capacity(ref.level - 1);
    const child = this.children(ref).find(([digit]) => digit === Math.floor(index / stripe))?.[1];
    return this.at(child, index % stripe);
  }

  chunkKey(key: string, index: number): IDBValidKey | undefined {
    const ref = this.at(this.manifests.get(key)?.root, index);
    return ref && recordKey(ref);
  }

  difference(before: string, after: string): { reused: number; newNodes: number } {
    const from = this.manifests.get(before);
    const to = this.manifests.get(after);
    if (!from?.root || !to?.root || from.size !== to.size) chunkError(after);
    const beforeNodes = new Set<string>();
    const afterNodes = new Set<string>();
    this.mark(from.root, beforeNodes, new Set());
    this.mark(to.root, afterNodes, new Set());
    let reused = 0;
    for (let index = 0; index * CHUNK_SIZE < to.size; index++) {
      const old = this.at(from.root, index);
      const next = this.at(to.root, index);
      if (old && next?.id === old.id) reused++;
    }
    return { reused, newNodes: Array.from(afterNodes).filter((id) => !beforeNodes.has(id)).length };
  }

  async prepare(delta: CaptureDelta): Promise<PreparedMap> {
    const chunks = new Map<string, { bytes: Uint8Array<ArrayBuffer>; checksum: string }>();
    const changes = new Map<number, ChunkRef>();
    const hashStart = performance.now();
    let copied = 0;
    for (const [index, bytes] of delta.chunks) {
      const checksum = await chunkChecksum(bytes);
      const id = crypto.randomUUID();
      chunks.set(id, { bytes, checksum });
      changes.set(index, { kind: "chunk", id, size: bytes.length, checksum, count: 1 });
      copied += bytes.length;
    }
    const mapStart = performance.now();
    const before = Math.floor(Math.min(delta.inheritedEnd, delta.size) / CHUNK_SIZE);
    let old = delta.parent === undefined ? undefined : this.manifests.get(delta.parent);
    if (delta.parent !== undefined && !old) chunkError(delta.parent);
    const level = levelFor(Math.ceil(delta.size / CHUNK_SIZE));
    let inherited = old?.root;
    while (inherited?.kind === "node" && inherited.level > level)
      inherited = this.children(inherited).find(([digit]) => digit === 0)?.[1];
    const nodes = new Map<string, MapNode>();
    const cut =
      delta.inheritedEnd >= (old?.size ?? 0) && delta.size >= (old?.size ?? 0)
        ? Math.ceil((old?.size ?? 0) / CHUNK_SIZE)
        : before;
    const root = delta.size
      ? this.editNode(inherited, level, 0, { before: cut, changes, nodes })
      : undefined;
    return {
      manifest: { size: delta.size, root },
      nodes,
      chunks,
      metrics: {
        copied,
        discoveryMs: delta.discoveryMs,
        copyMs: delta.copyMs,
        hashMs: mapStart - hashStart,
        mapMs: performance.now() - mapStart,
        reused: (root?.count ?? 0) - chunks.size,
        payloadReads: 0,
      },
    };
  }

  put(store: IDBObjectStore, key: string, prepared: PreparedMap): void {
    for (const [id, chunk] of prepared.chunks) store.add(chunk, ["chunk", id]);
    for (const [id, node] of prepared.nodes) store.add(node, ["node", id]);
    store.add(prepared.manifest, key);
  }

  install(key: string, prepared: PreparedMap): void {
    this.manifests.set(key, prepared.manifest);
    for (const [id, node] of prepared.nodes) this.nodes.set(id, node);
  }

  private mark(ref: Ref, nodes: Set<string>, chunks: Set<string>): void {
    if (ref.kind === "chunk") {
      chunks.add(ref.id);
      return;
    }
    if (nodes.has(ref.id)) return;
    nodes.add(ref.id);
    for (const [, child] of this.children(ref)) this.mark(child, nodes, chunks);
  }

  deletions(keys: readonly IDBValidKey[], roots: ReadonlySet<string>): IDBValidKey[] {
    const nodes = new Set<string>();
    const chunks = new Set<string>();
    for (const key of roots) {
      const manifest = this.manifests.get(key);
      if (!manifest) chunkError(key);
      if (manifest.root) this.mark(manifest.root, nodes, chunks);
    }
    return keys.filter((key) => {
      if (typeof key === "string") return !roots.has(key);
      if (!Array.isArray(key) || typeof key[1] !== "string") chunkError(String(key));
      return !(key[0] === "node" ? nodes : chunks).has(key[1]);
    });
  }

  deleted(keys: readonly IDBValidKey[]): void {
    for (const key of keys) {
      if (typeof key === "string") this.manifests.delete(key);
      else if (Array.isArray(key) && key[0] === "node" && typeof key[1] === "string")
        this.nodes.delete(key[1]);
    }
  }

  async recover(keys: readonly IDBValidKey[], read: ReadRecord): Promise<Map<string, number>> {
    const chunks = new Set<string>();
    const manifests = new Map<string, Manifest>();
    for (const key of keys) {
      if (typeof key === "string") {
        const value = await read(key);
        if (isManifest(value)) manifests.set(key, value);
        continue;
      }
      if (!Array.isArray(key) || key.length !== 2 || typeof key[1] !== "string")
        chunkError(String(key));
      if (key[0] === "chunk") chunks.add(key[1]);
      else if (key[0] === "node") {
        const value = await read(key);
        if (isNode(value)) this.nodes.set(key[1], value);
      } else chunkError(String(key));
    }
    for (const [key, manifest] of manifests) {
      const size = manifest.size;
      const level = levelFor(Math.ceil(size / CHUNK_SIZE));
      if (!manifest.root || this.complete(manifest.root, level, 0, size, chunks))
        this.manifests.set(key, manifest);
    }
    return new Map(Array.from(this.manifests, ([key, manifest]) => [key, manifest.size]));
  }

  private complete(
    ref: Ref,
    level: number,
    start: number,
    size: number,
    chunks: Set<string>,
  ): boolean {
    if (start * CHUNK_SIZE >= size) return false;
    if (ref.kind === "chunk")
      return level === -1 && ref.size <= size - start * CHUNK_SIZE && chunks.has(ref.id);
    const node = this.nodes.get(ref.id);
    if (!node || ref.level !== level) return false;
    const slots = new Set<number>();
    let count = 0;
    for (const [digit, child] of node.children) {
      if (
        slots.has(digit) ||
        !this.complete(child, level - 1, start + digit * capacity(level - 1), size, chunks)
      )
        return false;
      slots.add(digit);
      count += child.count;
    }
    return count === ref.count;
  }

  async read(
    key: string,
    offset: number,
    length: number,
    read: ReadRecord,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const manifest = this.manifests.get(key);
    if (!manifest) chunkError(key);
    const end = Math.min(offset + length, manifest.size);
    const bytes = new Uint8Array(Math.max(0, end - offset));
    for (let index = Math.floor(offset / CHUNK_SIZE); index * CHUNK_SIZE < end; index++) {
      signal?.throwIfAborted();
      const start = index * CHUNK_SIZE;
      const ref = this.at(manifest.root, index);
      if (!ref || start + ref.size <= offset) continue;
      this.payloadReads++;
      const record = parseChunk(await read(recordKey(ref), signal), ref.size, key);
      if (record.checksum !== ref.checksum || (await chunkChecksum(record.bytes)) !== ref.checksum)
        chunkError(key);
      const from = Math.max(start, offset);
      bytes.set(
        record.bytes.subarray(from - start, Math.min(end - start, ref.size)),
        from - offset,
      );
    }
    return bytes;
  }
}
