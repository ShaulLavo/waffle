import type { FileId } from "./file-identity.js";
import type { PublicationEffect, PublicationFile } from "./publication.js";
import type { NamespaceRecord } from "./workspace-protocol.js";
import { WORKSPACE_LIMITS, type WorkspaceChange } from "./workspace-types.js";

const NONE = 65535;
const EMPTY = 0xffffffff;
const DELETED = 0xfffffffe;
const UNLINKED = 0xfffffffd;
const WORD = (1n << 64n) - 1n;
const BOOKKEEPING_BYTES = 8192;

interface Capacity {
  readonly nodes: number;
  readonly edges: number;
  readonly extraLinks: number;
  readonly nameBytes: number;
  readonly scratchSlots: number;
  readonly byteLimit: number;
}
interface Counts {
  readonly nodes: number;
  readonly edges: number;
  readonly extraLinks: number;
  readonly nameBytes: number;
}
interface Budget {
  take(bytes: number): void;
}
type Link = { readonly id: FileId; readonly parent: FileId; readonly name: string };
interface PendingNode {
  readonly id: FileId;
  readonly exists: boolean;
  create: boolean;
  links: number;
}
interface PendingLink {
  readonly link: Link;
  present: boolean;
}
type Component = keyof Counts | "bytes" | "scratch";

export class NamespaceProjectionPressure extends Error {
  constructor(
    readonly resource: "index" | "changes",
    readonly component?: Component,
    readonly required = 0,
    readonly available = 0,
  ) {
    super(resource);
  }
}

function check(required: number, available: number, component: Component): void {
  if (required > available)
    throw new NamespaceProjectionPressure("index", component, required, available);
}

function reserve(used: Counts, growth: Counts, capacity: Capacity): Counts {
  const result = {
    nodes: used.nodes + growth.nodes,
    edges: used.edges + growth.edges,
    extraLinks: used.extraLinks + growth.extraLinks,
    nameBytes: used.nameBytes + growth.nameBytes,
  };
  check(result.nodes, capacity.nodes, "nodes");
  check(result.edges, capacity.edges, "edges");
  check(result.extraLinks, capacity.extraLinks, "extraLinks");
  check(result.nameBytes, capacity.nameBytes, "nameBytes");
  return result;
}

function codePoint(text: string, at: number): number {
  const high = text.charCodeAt(at),
    low = text.charCodeAt(at + 1);
  if (high < 0xd800 || high > 0xdbff || low < 0xdc00 || low > 0xdfff || Number.isNaN(low))
    return high;
  return 0x10000 + ((high - 0xd800) << 10) + low - 0xdc00;
}

function nameSize(text: string): number {
  let bytes = 0;
  for (let at = 0; at < text.length; at++) {
    const point = codePoint(text, at);
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (point >= 0x10000) at++;
  }
  return bytes;
}

function writePoint(bytes: Uint8Array, at: number, point: number): number {
  if (point < 0x80) {
    bytes[at] = point;
    return at + 1;
  }
  const count = point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  bytes[at] = (count === 2 ? 0xc0 : count === 3 ? 0xe0 : 0xf0) | (point >> ((count - 1) * 6));
  for (let unit = 1; unit < count; unit++)
    bytes[at + unit] = 0x80 | ((point >> ((count - 1 - unit) * 6)) & 63);
  return at + count;
}

function encodeName(text: string, bytes: Uint8Array, at: number): void {
  for (let unit = 0; unit < text.length; unit++) {
    const point = codePoint(text, unit);
    at = writePoint(bytes, at, point);
    if (point >= 0x10000) unit++;
  }
}

function decodeName(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  const end = offset + length;
  while (offset < end) {
    const first = bytes[offset++]!;
    const count = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
    let point = first & (count === 1 ? 127 : count === 2 ? 31 : count === 3 ? 15 : 7);
    for (let unit = 1; unit < count; unit++) point = (point << 6) | (bytes[offset++]! & 63);
    text += String.fromCodePoint(point);
  }
  return text;
}

function hash(id: FileId): number {
  let value = 2166136261,
    remaining: bigint = id;
  for (let word = 0; word < 4; word++) {
    value = Math.imul(value ^ Number(remaining & 0xffffffffn), 16777619);
    remaining >>= 32n;
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  return (value ^ (value >>> 13)) >>> 0;
}

function sameLink(left: Link, right: Link): boolean {
  return left.id === right.id && left.parent === right.parent && left.name === right.name;
}

function reference(file: PublicationFile | null) {
  return file ? { id: file.id, version: file.version } : null;
}

/** Derived names only. File bytes, revisions and read permissions stay with the authority. */
export class NamespaceProjectionTable {
  private readonly capacity: Capacity;
  private readonly ids: BigUint64Array;
  private readonly parents: Uint16Array;
  private readonly offsets: Uint32Array;
  private readonly lengths: Uint16Array;
  private readonly directories: Uint8Array;
  private readonly names: Uint8Array;
  private readonly extraNodes: Uint16Array;
  private readonly extraParents: Uint16Array;
  private readonly extraOffsets: Uint32Array;
  private readonly extraLengths: Uint16Array;
  private readonly heap: Uint32Array;
  private readonly backing: ArrayBuffer;
  private root = NONE;
  private nodeCount = 0;
  private edgeCount = 0;
  private extraCount = 0;
  private nameBytes = 0;
  private tail = 0;
  private compactions = 0;
  private compactionPasses = 0;
  private movedBytes = 0;

  constructor(options: Partial<Capacity> = {}) {
    this.capacity = {
      nodes: 65535,
      edges: WORKSPACE_LIMITS.indexEdges,
      extraLinks: 4096,
      nameBytes: 393216,
      scratchSlots: 4096,
      byteLimit: WORKSPACE_LIMITS.indexBytes,
      ...options,
    };
    for (const value of Object.values(this.capacity))
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid table capacity");
    if (
      this.capacity.nodes > NONE ||
      this.capacity.extraLinks > NONE ||
      this.capacity.nameBytes >= UNLINKED
    )
      throw new RangeError("table capacity exceeds column width");
    const { nodes, extraLinks, scratchSlots, nameBytes } = this.capacity;
    const columns = nodes * 24 + extraLinks * 10;
    const heapStart = Math.ceil(columns / 4) * 4;
    const directoryStart = heapStart + scratchSlots * 4;
    const nameStart = directoryStart + Math.ceil(nodes / 8);
    const backingBytes = nameStart + nameBytes;
    check(backingBytes + BOOKKEEPING_BYTES, this.capacity.byteLimit, "bytes");
    this.backing = new ArrayBuffer(backingBytes);
    let at = 0;
    this.ids = new BigUint64Array(this.backing, at, nodes * 2);
    at += nodes * 16;
    this.offsets = new Uint32Array(this.backing, at, nodes);
    at += nodes * 4;
    this.parents = new Uint16Array(this.backing, at, nodes);
    at += nodes * 2;
    this.lengths = new Uint16Array(this.backing, at, nodes);
    at += nodes * 2;
    this.extraOffsets = new Uint32Array(this.backing, at, extraLinks);
    at += extraLinks * 4;
    this.extraNodes = new Uint16Array(this.backing, at, extraLinks);
    at += extraLinks * 2;
    this.extraParents = new Uint16Array(this.backing, at, extraLinks);
    at += extraLinks * 2;
    this.extraLengths = new Uint16Array(this.backing, at, extraLinks);
    this.heap = new Uint32Array(this.backing, heapStart, scratchSlots);
    this.directories = new Uint8Array(this.backing, directoryStart, Math.ceil(nodes / 8));
    this.names = new Uint8Array(this.backing, nameStart, nameBytes);
    this.offsets.fill(EMPTY);
    this.parents.fill(NONE);
    this.extraNodes.fill(NONE);
  }

  allocation() {
    return {
      backingBytes: this.backing.byteLength,
      bookkeepingBytes: BOOKKEEPING_BYTES,
      chargedBytes: this.backing.byteLength + BOOKKEEPING_BYTES,
      scratchBytes: this.heap.byteLength,
      nodes: this.nodeCount,
      edges: this.edgeCount,
      extraLinks: this.extraCount,
      nameBytes: this.nameBytes,
      tailBytes: this.tail,
      compactions: this.compactions,
      compactionPasses: this.compactionPasses,
      movedBytes: this.movedBytes,
    };
  }

  private slot(id: FileId): number {
    const { nodes } = this.capacity;
    if (!nodes) return NONE;
    const high = id >> 64n,
      low = id & WORD;
    const start = hash(id) % nodes;
    let deleted = NONE;
    for (let step = 0; step < nodes; step++) {
      const at = (start + step) % nodes,
        offset = this.offsets[at]!;
      if (offset === EMPTY) return deleted === NONE ? at : deleted;
      if (offset === DELETED && deleted === NONE) deleted = at;
      if (offset !== DELETED && this.ids[at * 2] === high && this.ids[at * 2 + 1] === low)
        return at;
    }
    return deleted;
  }

  private find(id: FileId): number {
    const at = this.slot(id);
    return at === NONE || this.offsets[at]! >= DELETED ? NONE : at;
  }

  private node(id: FileId, directory: boolean): number {
    const at = this.slot(id);
    if (this.offsets[at]! < DELETED) return at;
    this.ids[at * 2] = id >> 64n;
    this.ids[at * 2 + 1] = id & WORD;
    this.offsets[at] = UNLINKED;
    this.lengths[at] = 0;
    this.parents[at] = NONE;
    const mask = 1 << (at & 7),
      byte = at >> 3;
    this.directories[byte] = (this.directories[byte]! & ~mask) | (directory ? mask : 0);
    this.nodeCount++;
    return at;
  }

  private name(ref: number): string {
    return decodeName(this.names, this.offset(ref), this.length(ref));
  }

  private offset(ref: number): number {
    return ref < this.capacity.nodes
      ? this.offsets[ref]!
      : this.extraOffsets[ref - this.capacity.nodes]!;
  }

  private length(ref: number): number {
    return ref < this.capacity.nodes
      ? this.lengths[ref]!
      : this.extraLengths[ref - this.capacity.nodes]!;
  }

  private moveOffset(ref: number, offset: number): void {
    if (ref < this.capacity.nodes) this.offsets[ref] = offset;
    else this.extraOffsets[ref - this.capacity.nodes] = offset;
  }

  private edge(node: number, parent: number, name: string): number {
    if (this.offsets[node]! < UNLINKED && this.parents[node] === parent && this.name(node) === name)
      return node;
    if (!this.extraCount) return -1;
    for (let at = 0; at < this.capacity.extraLinks; at++) {
      if (this.extraNodes[at] !== node || this.extraParents[at] !== parent) continue;
      const ref = this.capacity.nodes + at;
      if (this.name(ref) === name) return ref;
    }
    return -1;
  }

  private hasLink(link: Link): boolean {
    const node = this.find(link.id),
      parent = this.find(link.parent);
    return node !== NONE && parent !== NONE && this.edge(node, parent, link.name) !== -1;
  }

  private admit(growth: Counts): void {
    reserve(this.allocation(), growth, this.capacity);
    if (this.tail + growth.nameBytes > this.capacity.nameBytes && growth.nameBytes > 0)
      check(1, this.capacity.scratchSlots, "scratch");
  }

  private nameRequirement(name: string): number {
    const bytes = nameSize(name);
    check(bytes, 65535, "nameBytes");
    return bytes;
  }

  add(record: NamespaceRecord): void {
    let nodes = Number(this.find(record.id) === NONE);
    if (record.parent !== null && this.find(record.parent) === NONE && record.parent !== record.id)
      nodes++;
    const link =
      record.parent === null ? null : { id: record.id, parent: record.parent, name: record.name };
    const present = link === null || this.hasLink(link);
    const at = this.find(record.id);
    this.admit({
      nodes,
      edges: Number(!present),
      extraLinks: Number(!present && at !== NONE && this.offsets[at]! < UNLINKED),
      nameBytes: present ? 0 : this.nameRequirement(record.name),
    });
    const node = this.node(record.id, record.kind === "directory");
    if (record.parent === null) {
      this.root = node;
      return;
    }
    this.link(node, this.node(record.parent, true), record.name);
  }

  private link(node: number, parent: number, name: string): void {
    if (this.edge(node, parent, name) !== -1) return;
    const size = nameSize(name);
    if (this.tail + size > this.capacity.nameBytes) this.compact();
    const offset = this.tail;
    encodeName(name, this.names, offset);
    this.tail += size;
    this.nameBytes += size;
    this.edgeCount++;
    if (this.offsets[node] === UNLINKED) {
      this.parents[node] = parent;
      this.offsets[node] = offset;
      this.lengths[node] = size;
      return;
    }
    const at = this.extraNodes.indexOf(NONE);
    this.extraNodes[at] = node;
    this.extraParents[at] = parent;
    this.extraOffsets[at] = offset;
    this.extraLengths[at] = size;
    this.extraCount++;
  }

  private unlink(id: FileId, parentId: FileId, name: string): void {
    const node = this.find(id),
      parent = this.find(parentId);
    if (node === NONE || parent === NONE) return;
    const ref = this.edge(node, parent, name);
    if (ref === -1) return;
    this.nameBytes -= this.length(ref);
    this.edgeCount--;
    if (ref >= this.capacity.nodes) {
      this.extraNodes[ref - this.capacity.nodes] = NONE;
      this.extraCount--;
      return;
    }
    const next = this.extraNodes.indexOf(node);
    this.offsets[node] = UNLINKED;
    this.parents[node] = NONE;
    if (next === -1) return;
    this.parents[node] = this.extraParents[next]!;
    this.offsets[node] = this.extraOffsets[next]!;
    this.lengths[node] = this.extraLengths[next]!;
    this.extraNodes[next] = NONE;
    this.extraCount--;
  }

  private collect(id: FileId): void {
    const at = this.find(id);
    if (at === NONE || at === this.root || this.offsets[at] !== UNLINKED) return;
    this.offsets[at] = DELETED;
    this.nodeCount--;
    this.trimDeleted(at);
  }

  private trimDeleted(at: number): void {
    const count = this.capacity.nodes;
    if (this.offsets[(at + 1) % count] !== EMPTY) return;
    while (this.offsets[at] === DELETED) {
      this.offsets[at] = EMPTY;
      at = (at + count - 1) % count;
    }
  }

  private sift(size: number, at: number): void {
    for (;;) {
      let child = at * 2 + 1;
      if (child >= size) return;
      if (child + 1 < size && this.offset(this.heap[child + 1]!) > this.offset(this.heap[child]!))
        child++;
      if (this.offset(this.heap[at]!) >= this.offset(this.heap[child]!)) return;
      const value = this.heap[at]!;
      this.heap[at] = this.heap[child]!;
      this.heap[child] = value;
      at = child;
    }
  }

  private select(size: number, ref: number): number {
    if (size === this.heap.length) {
      if (this.offset(ref) < this.offset(this.heap[0]!)) {
        this.heap[0] = ref;
        this.sift(size, 0);
      }
      return size;
    }
    let at = size;
    this.heap[at] = ref;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (this.offset(this.heap[parent]!) >= this.offset(ref)) break;
      this.heap[at] = this.heap[parent]!;
      this.heap[parent] = ref;
      at = parent;
    }
    return size + 1;
  }

  private selectNames(floor: number): number {
    let count = 0;
    for (let at = 0; at < this.capacity.nodes; at++) {
      if (this.offsets[at]! >= UNLINKED || !this.lengths[at] || this.offsets[at]! < floor) continue;
      count = this.select(count, at);
    }
    for (let at = 0; at < this.capacity.extraLinks; at++) {
      if (this.extraNodes[at] === NONE || !this.extraLengths[at] || this.extraOffsets[at]! < floor)
        continue;
      count = this.select(count, this.capacity.nodes + at);
    }
    return count;
  }

  private compact(): void {
    let floor = 0,
      destination = 0;
    for (;;) {
      const count = this.selectNames(floor);
      if (!count) break;
      floor = this.offset(this.heap[0]!) + 1;
      for (let end = count - 1; end > 0; end--) {
        const value = this.heap[0]!;
        this.heap[0] = this.heap[end]!;
        this.heap[end] = value;
        this.sift(end, 0);
      }
      destination = this.packSelected(count, destination);
      this.compactionPasses++;
    }
    this.tail = destination;
    this.compactions++;
  }

  private packSelected(count: number, destination: number): number {
    for (let at = 0; at < count; at++) {
      const ref = this.heap[at]!,
        offset = this.offset(ref),
        length = this.length(ref);
      if (destination !== offset) {
        this.names.copyWithin(destination, offset, offset + length);
        this.movedBytes += length;
      }
      this.moveOffset(ref, destination);
      destination += length;
    }
    return destination;
  }

  private directoryPath(at: number): string | null {
    if (this.root === NONE) return null;
    let path = "",
      depth = 0;
    while (at !== this.root) {
      if (++depth > WORKSPACE_LIMITS.depth) throw new NamespaceProjectionPressure("changes");
      if (at === NONE || this.offsets[at]! >= UNLINKED) return null;
      path = `/${this.name(at)}${path}`;
      if (path.length > WORKSPACE_LIMITS.pathUnits)
        throw new NamespaceProjectionPressure("changes");
      at = this.parents[at]!;
    }
    return path || "/";
  }

  private entryPath(parent: FileId, name: string, budget: Budget): string | null {
    const directory = this.directoryPath(this.find(parent));
    if (directory === null) return null;
    const path = directory === "/" ? `/${name}` : `${directory}/${name}`;
    if (path.length > WORKSPACE_LIMITS.pathUnits) throw new NamespaceProjectionPressure("changes");
    budget.take(path.length * 2 + 32);
    return path;
  }

  private paths(id: FileId, budget: Budget): readonly string[] {
    const node = this.find(id);
    if (node === NONE) return [];
    if (node === this.root) {
      budget.take(34);
      return ["/"];
    }
    const result: string[] = [];
    if (this.offsets[node]! < UNLINKED) this.appendPath(result, node, this.parents[node]!, budget);
    if (!this.extraCount) return result;
    for (let at = 0; at < this.capacity.extraLinks; at++)
      if (this.extraNodes[at] === node)
        this.appendPath(result, this.capacity.nodes + at, this.extraParents[at]!, budget);
    result.sort();
    return result;
  }

  private appendPath(paths: string[], ref: number, parent: number, budget: Budget): void {
    const directory = this.directoryPath(parent);
    if (directory === null) return;
    const path = directory === "/" ? `/${this.name(ref)}` : `${directory}/${this.name(ref)}`;
    if (path.length > WORKSPACE_LIMITS.pathUnits) throw new NamespaceProjectionPressure("changes");
    budget.take(path.length * 2 + 32);
    paths.push(path);
  }

  private prepare(effects: readonly PublicationEffect[], budget: Budget): void {
    const nodes: PendingNode[] = [],
      links: PendingLink[] = [];
    let edges = 0,
      extraLinks = 0,
      nameBytes = 0;
    for (const effect of effects) {
      budget.take(256);
      if (effect.kind === "inode") this.pendingNode(nodes, effect.file.id).create = true;
      if (effect.kind !== "entry") continue;
      this.pendingNode(nodes, effect.parent.id).create = true;
      if (effect.before?.id === effect.after?.id) continue;
      this.stageUnlink(effect, nodes, links);
      if (!effect.after) continue;
      const node = this.pendingNode(nodes, effect.after.id);
      node.create = true;
      const state = this.pendingLink(links, {
        id: effect.after.id,
        parent: effect.parent.id,
        name: effect.name,
      });
      if (state.present) continue;
      state.present = true;
      extraLinks += Number(node.links++ > 0);
      edges++;
      nameBytes += this.nameRequirement(effect.name);
    }
    this.admit({
      nodes: nodes.filter((node) => node.create && !node.exists).length,
      edges,
      extraLinks,
      nameBytes,
    });
  }

  private pendingNode(nodes: PendingNode[], id: FileId): PendingNode {
    const previous = nodes.find((node) => node.id === id);
    if (previous) return previous;
    const at = this.find(id);
    let links = Number(at !== NONE && this.offsets[at]! < UNLINKED);
    if (at !== NONE && this.extraCount)
      for (const node of this.extraNodes) links += Number(node === at);
    const node = { id, exists: at !== NONE, create: false, links };
    nodes.push(node);
    return node;
  }

  private pendingLink(links: PendingLink[], link: Link): PendingLink {
    const previous = links.find((state) => sameLink(state.link, link));
    if (previous) return previous;
    const state = { link, present: this.hasLink(link) };
    links.push(state);
    return state;
  }

  private stageUnlink(
    effect: Extract<PublicationEffect, { kind: "entry" }>,
    nodes: PendingNode[],
    links: PendingLink[],
  ): void {
    if (!effect.before) return;
    const state = this.pendingLink(links, {
      id: effect.before.id,
      parent: effect.parent.id,
      name: effect.name,
    });
    if (!state.present) return;
    state.present = false;
    this.pendingNode(nodes, effect.before.id).links--;
  }

  project(effects: readonly PublicationEffect[], budget: Budget): readonly WorkspaceChange[] {
    this.prepare(effects, budget);
    const oldPaths = effects.map((effect) =>
      effect.kind === "entry" && effect.before
        ? this.entryPath(effect.parent.id, effect.name, budget)
        : null,
    );
    for (const effect of effects)
      if (effect.kind === "inode") this.node(effect.file.id, effect.nodeKind === "directory");
    for (const effect of effects) this.apply(effect);
    const changes = effects.map((effect, at) => this.change(effect, oldPaths[at] ?? null, budget));
    for (const effect of effects)
      if (effect.kind === "entry" && effect.before) this.collect(effect.before.id);
    return changes;
  }

  private apply(effect: PublicationEffect): void {
    if (effect.kind !== "entry") return;
    const parent = this.node(effect.parent.id, true);
    if (effect.before?.id === effect.after?.id) return;
    if (effect.before) this.unlink(effect.before.id, effect.parent.id, effect.name);
    if (effect.after) this.link(this.node(effect.after.id, false), parent, effect.name);
  }

  private change(
    effect: PublicationEffect,
    beforePath: string | null,
    budget: Budget,
  ): WorkspaceChange {
    if (effect.kind === "entry")
      return {
        kind: "entry",
        parent: { id: effect.parent.id, version: effect.parent.version },
        name: effect.name,
        before: reference(effect.before),
        after: reference(effect.after),
        beforePath,
        afterPath: effect.after ? this.entryPath(effect.parent.id, effect.name, budget) : null,
      };
    const file = {
      id: effect.file.id,
      version: effect.file.version,
      paths: this.paths(effect.file.id, budget),
    };
    switch (effect.kind) {
      case "bytes":
        return {
          ...file,
          kind: "write",
          range: { offset: effect.offset, length: effect.bytes.length },
          size: effect.size,
        };
      case "resize":
        return { ...file, kind: "resize", size: effect.size };
      case "metadata":
        return { ...file, kind: "metadata", mode: effect.mode, mtime: effect.mtime };
      case "inode":
        return {
          ...file,
          kind: "inode",
          nodeKind: effect.nodeKind,
          mode: effect.mode,
          mtime: effect.mtime,
        };
      default: {
        const exhaustive: never = effect;
        return exhaustive;
      }
    }
  }
}
