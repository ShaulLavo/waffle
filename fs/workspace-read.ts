import { MemoryBackend } from "./backend.js";
import type { Node, DirNode } from "./memory.js";
import type { SharedPageVersion } from "./shared-version-pages.js";
import { PayloadRetentionPressure, type StorageBackend, type PayloadRetention } from "./storage.js";
import { FilesystemError, PAGE } from "./protocol.js";
import {
  namespaceCut,
  ReadRefusal,
  readCut,
  readRange,
  readTarget,
  readVersion,
} from "./workspace-protocol.js";
import {
  WORKSPACE_LIMITS,
  WORKSPACE_READ_LIMITS as LIMIT,
  type ByteRange,
  type FileTarget,
  type FileVersion,
  type NamespaceCut,
  type VersionStat,
  type ReadFailure,
  type ReadOutcome,
  type ReadResource,
} from "./workspace-types.js";

export type ReadBacking =
  | { readonly kind: "empty" }
  | { readonly kind: "resident"; readonly pages: SharedPageVersion }
  | {
      readonly kind: "seed";
      readonly bytes: Uint8Array;
      readonly offset: number;
      readonly length: number;
    }
  | {
      readonly kind: "cold";
      readonly key: string;
      readonly size: number;
      readonly storage: StorageBackend;
      readonly retention: PayloadRetention;
    };
interface Selected {
  readonly backing: ReadBacking;
  readonly stat: VersionStat;
  readonly metadata: number;
  refs: number;
}
interface Ticket {
  readonly selected: Selected;
  readonly range: ByteRange;
  readonly output: number;
  readonly controller: AbortController;
  readonly lease?: number;
  next: number;
  work?: Promise<Uint8Array>;
  closing?: Promise<void>;
}
interface Lease {
  readonly selected: Selected;
  closing?: Promise<void>;
}
interface ScanFrame {
  readonly node: DirNode;
  readonly iterator: MapIterator<Node>;
}
const refuse = (failure: ReadFailure): never => {
  throw new ReadRefusal(failure);
};
const pressure = (resource: ReadResource): never => refuse({ kind: "pressure", resource });
function sameCut(a: NamespaceCut, b: NamespaceCut): boolean {
  return (
    a.workspace === b.workspace &&
    a.generation === b.generation &&
    a.watermark.history === b.watermark.history &&
    a.watermark.seq === b.watermark.seq
  );
}
function serial(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new FilesystemError(28);
  return value;
}
function failure(error: unknown, signal?: AbortSignal): ReadFailure {
  if (signal?.aborted) return { kind: "cancelled" };
  if (error instanceof ReadRefusal) return error.failure;
  if (error instanceof PayloadRetentionPressure)
    return { kind: "pressure", resource: "retained-storage" };
  if (error instanceof FilesystemError) {
    if (error.errno === 2) return { kind: "denied" };
    if (error.errno === 6) return { kind: "unavailable" };
    if (error.errno === 11) return { kind: "stopped" };
    if (error.errno === 44 || error.errno === 8) return { kind: "not-found" };
    if (error.errno === 31 || error.errno === 54) return { kind: "not-file" };
  }
  return { kind: "io", message: error instanceof Error ? error.message : "Filesystem read failed" };
}
function extent(size: number, requested?: ByteRange): ByteRange {
  const offset = requested?.offset ?? 0;
  return { offset, length: Math.min(requested?.length ?? size, Math.max(0, size - offset)) };
}
async function readBacking(
  backing: ReadBacking,
  range: ByteRange,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  switch (backing.kind) {
    case "empty":
      return new Uint8Array();
    case "resident":
      return backing.pages.read(range.offset, range.length);
    case "seed":
      return new Uint8Array(
        backing.bytes.subarray(
          range.offset - backing.offset,
          range.offset - backing.offset + range.length,
        ),
      );
    case "cold": {
      const bytes = await backing.storage.readRange(backing.key, { ...range, signal });
      if (bytes.length !== range.length) throw new Error("Short retained payload range");
      return bytes;
    }
  }
}
/** Holds actual backend references. It cannot create namespace entries or publish a version. */
export class WorkspaceReadAuthority {
  private readonly tickets = new Map<number, Ticket>();
  private readonly leases = new Map<number, Lease>();
  private readonly operations = new Map<
    number,
    { controller: AbortController; serial: number; work?: Promise<unknown> }
  >();
  private readonly closed = new Set<number>();
  private floor = 0;
  private stopping = false;
  private closing?: Promise<void>;
  private outputs = 0;
  private outputPeak = 0;
  private metadata = 65536;
  private metadataPeak = 65536;
  private readonly seeds = new Map<ArrayBufferLike, number>();
  private seedBytes = 0;
  constructor(private readonly backend: MemoryBackend) {}
  private current(): NamespaceCut {
    return namespaceCut(this.backend.workspaceId, this.backend.shared.publication!.cut());
  }
  private lock<T>(run: () => T): T {
    return this.backend.shared.mutate(undefined, undefined, run);
  }
  invoke(operation: string, args: unknown[], request: number): Promise<unknown> {
    if (operation === "publicationReadClose") return this.close(args[1]);
    if (this.stopping) return Promise.resolve({ kind: "stopped" });
    if (this.operations.size >= LIMIT.operations)
      return Promise.resolve({ kind: "pressure", resource: "operations" });
    const controller = new AbortController(),
      id = serial(args[1]);
    const active: { controller: AbortController; serial: number; work?: Promise<unknown> } = {
      controller,
      serial: id,
    };
    this.operations.set(request, active);
    const work = this.run(operation, args, controller.signal)
      .then(
        async (value) => {
          if (!controller.signal.aborted && !this.stopping) return value;
          await this.close(id);
          return { kind: this.stopping ? "stopped" : "cancelled" };
        },
        (error: unknown) => failure(error, controller.signal),
      )
      .finally(() => {
        this.operations.delete(request);
      });
    active.work = work;
    return work;
  }
  cancel(request: number): void {
    const active = this.operations.get(request);
    if (active) {
      active.controller.abort();
      void this.close(active.serial);
    }
  }
  private async run(operation: string, args: unknown[], signal: AbortSignal): Promise<unknown> {
    const id = serial(args[1]);
    if (operation === "publicationReadChunk") return this.chunk(id, args[2], signal);
    if (this.closed.has(id) || id <= this.floor) return { kind: "cancelled" };
    if (this.tickets.has(id) || this.leases.has(id)) throw new FilesystemError(28);
    if (operation === "publicationReadLeaseOpen")
      return this.openLease(id, serial(args[2]), readRange(args[3]));
    const target = readTarget(args[2]),
      requested = readRange(args[3]),
      version = readVersion(args[4]),
      at = readCut(args[5]);
    return this.resolve(target, signal, (node) => {
      signal.throwIfAborted();
      if (this.stopping || this.closed.has(id) || id <= this.floor)
        return { kind: this.stopping ? "stopped" : "cancelled" };
      return this.select(operation, id, target, node, requested, version, at);
    });
  }
  private async resolve<T>(
    target: FileTarget,
    signal: AbortSignal,
    select: (node: Node | undefined) => T,
  ): Promise<T> {
    if (typeof target === "string")
      return this.lock(() => {
        const value = this.backend.fs.resolveAbsolute(target);
        if (typeof value === "number") throw new FilesystemError(value);
        return select(
          value.node === undefined ? undefined : this.backend.fs.nodeForHandle(value.node),
        );
      });
    const initial = this.lock(() => this.current());
    const frames: ScanFrame[] = [
      { node: this.backend.fs.root, iterator: this.backend.fs.root.children.values() },
    ];
    const found = this.lock(() => {
      const node = this.detached(target);
      return node ? { value: select(node) } : undefined;
    });
    if (found) return found.value;
    while (frames.length) {
      signal.throwIfAborted();
      const selected = this.lock(() => {
        const current = this.current();
        if (!sameCut(initial, current)) refuse({ kind: "restart", current });
        const node = this.scanSlice(target, frames);
        return node || !frames.length ? { value: select(node) } : undefined;
      });
      if (selected) return selected.value;
      if (frames.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return this.lock(() => select(undefined));
  }
  private detached(target: FileTarget): Node | undefined {
    if (this.backend.ensureIdentity(this.backend.fs.root).id === target)
      return this.backend.fs.root;
    for (const handle of this.backend.shared.registeredHandles()) {
      if (this.backend.shared.identity(handle)?.id === target)
        return this.backend.fs.nodeForHandle(handle);
    }
    return undefined;
  }
  private scanSlice(target: FileTarget, frames: ScanFrame[]): Node | undefined {
    for (let visited = 0; visited < WORKSPACE_LIMITS.visitedEdges && frames.length; visited++) {
      const frame = frames[frames.length - 1]!;
      const item = frame.iterator.next();
      if (item.done) {
        frames.pop();
        continue;
      }
      const node = item.value;
      if (this.backend.ensureIdentity(node).id === target) return node;
      if (node.kind !== "dir" || !(node.mode & 0o100)) continue;
      if (frames.length >= WORKSPACE_LIMITS.depth) pressure("metadata");
      frames.push({ node, iterator: node.children.values() });
    }
    return undefined;
  }
  private retained(
    target: FileTarget,
    version?: FileVersion,
    at?: NamespaceCut,
  ): Selected | undefined {
    for (const lease of this.leases.values()) {
      const stat = lease.selected.stat;
      if (
        lease.closing ||
        stat.id !== target ||
        (version !== undefined && stat.version !== version)
      )
        continue;
      if (at && !sameCut(stat.cut, at)) continue;
      return lease.selected;
    }
    return undefined;
  }
  private select(
    operation: string,
    id: number,
    target: FileTarget,
    node: Node | undefined,
    requested: ByteRange | undefined,
    version: FileVersion | undefined,
    at: NamespaceCut | undefined,
  ): ReadOutcome<unknown> {
    const current = this.current();
    const historical = at && !sameCut(at, current);
    const metadata = node && this.backend.readMetadata(node);
    const retained = this.retained(
      typeof target === "string" ? (metadata?.id ?? target) : target,
      version,
      historical ? at : undefined,
    );
    if (historical) {
      if (operation === "publicationReadStat" && typeof target !== "string" && retained)
        return { kind: "ok", value: retained.stat };
      return { kind: "generation-gone", requested: at, current };
    }
    if (version !== undefined && (!metadata || metadata.version !== version)) {
      if (retained) return this.fromSelected(operation, id, retained, requested);
      return { kind: "version-gone", requested: version };
    }
    if (!node || !metadata) return { kind: "not-found" };
    if (!(metadata.mode! & 0o400)) return { kind: "denied" };
    const stat: VersionStat = {
      id: metadata.id,
      version: metadata.version,
      cut: current,
      kind: metadata.kind,
      size: metadata.size,
      mtime: metadata.mtime,
      mode: metadata.mode!,
    };
    if (operation === "publicationReadStat") return { kind: "ok", value: stat };
    if (node.kind !== "file") return { kind: "not-file" };
    const range =
      operation === "publicationReadPin"
        ? { offset: 0, length: stat.size }
        : extent(stat.size, requested);
    this.admit(operation, range);
    const descriptors = range.length
      ? Math.ceil((range.offset + range.length) / PAGE) - Math.floor(range.offset / PAGE)
      : 0;
    const charge = 256 + descriptors * 64;
    this.takeMetadata(charge);
    let backing: ReadBacking;
    try {
      backing = this.backend.selectReadBacking(
        node,
        range.offset,
        range.length,
        operation === "publicationReadPin",
      );
    } catch (error) {
      this.metadata -= charge;
      throw error;
    }
    const selected: Selected = { stat, backing, refs: 0, metadata: charge };
    try {
      this.retainSeed(backing);
      if (this.backend.shared.readerPinBytes() + this.seedBytes > LIMIT.pinBytes)
        pressure("pin-bytes");
      return this.fromSelected(operation, id, selected, requested);
    } catch (error) {
      this.releaseSelected(selected);
      throw error;
    }
  }
  private admit(operation: string, range: ByteRange): void {
    if (operation === "publicationReadPin") {
      if (this.leases.size >= LIMIT.leases) pressure("leases");
      return;
    }
    if (range.length > LIMIT.result) pressure("result-bytes");
    if (this.tickets.size >= LIMIT.operations) pressure("operations");
    if (this.outputCost(range.length) > LIMIT.resultBytes - this.outputs) pressure("result-bytes");
  }
  private outputCost(length: number): number {
    return 8 * length + 8 * PAGE + 4 * LIMIT.chunk + 8192;
  }
  private takeMetadata(bytes: number): void {
    if (bytes > LIMIT.metadata - this.metadata) pressure("metadata");
    this.metadata += bytes;
    this.metadataPeak = Math.max(this.metadataPeak, this.metadata);
  }
  private retainSeed(backing: ReadBacking): void {
    if (backing.kind !== "seed") return;
    const buffer = backing.bytes.buffer,
      refs = this.seeds.get(buffer) ?? 0;
    if (!refs && buffer.byteLength > LIMIT.pinBytes - this.seedBytes) pressure("pin-bytes");
    this.seeds.set(buffer, refs + 1);
    if (!refs) this.seedBytes += buffer.byteLength;
  }
  private fromSelected(
    operation: string,
    id: number,
    selected: Selected,
    requested?: ByteRange,
    lease?: number,
  ): ReadOutcome<unknown> {
    const range = extent(selected.stat.size, requested);
    this.admit(operation, range);
    this.takeMetadata(256);
    selected.refs++;
    if (operation === "publicationReadPin") {
      this.leases.set(id, { selected });
      return {
        kind: "ok",
        value: {
          serial: id,
          stat: selected.stat,
          range: { offset: 0, length: selected.stat.size },
        },
      };
    }
    const output = this.outputCost(range.length);
    this.outputs += output;
    this.outputPeak = Math.max(this.outputPeak, this.outputs);
    this.tickets.set(id, {
      selected,
      range,
      output,
      controller: new AbortController(),
      lease,
      next: 0,
    });
    return { kind: "ok", value: { serial: id, stat: selected.stat, range } };
  }
  private openLease(id: number, leaseId: number, requested?: ByteRange): ReadOutcome<unknown> {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.closing) return { kind: "lease-closed" };
    return this.fromSelected("publicationReadOpen", id, lease.selected, requested, leaseId);
  }
  private async chunk(id: number, offset: unknown, signal: AbortSignal): Promise<unknown> {
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.closing) return { kind: "lease-closed" };
    if (offset !== ticket.next || ticket.work) throw new FilesystemError(28);
    const length = Math.min(LIMIT.chunk, ticket.range.length - ticket.next);
    const work = readBacking(
      ticket.selected.backing,
      { offset: ticket.range.offset + ticket.next, length },
      AbortSignal.any([signal, ticket.controller.signal]),
    );
    ticket.work = work;
    try {
      const bytes = await work;
      signal.throwIfAborted();
      ticket.controller.signal.throwIfAborted();
      if (bytes.length !== length) throw new Error("Invalid retained chunk length");
      ticket.next += length;
      return bytes;
    } finally {
      ticket.work = undefined;
    }
  }
  private releaseSelected(selected: Selected): void {
    if (selected.refs > 0 && --selected.refs) return;
    const backing = selected.backing;
    if (backing.kind === "resident") backing.pages.release();
    if (backing.kind === "cold") backing.retention.release();
    if (backing.kind === "seed") this.releaseSeed(backing);
    this.metadata -= selected.metadata;
  }
  private releaseSeed(backing: Extract<ReadBacking, { kind: "seed" }>): void {
    const buffer = backing.bytes.buffer,
      refs = this.seeds.get(buffer);
    if (refs === undefined) return;
    if (refs > 1) this.seeds.set(buffer, refs - 1);
    else {
      this.seeds.delete(buffer);
      this.seedBytes -= buffer.byteLength;
    }
  }
  private closeTicket(id: number, ticket: Ticket): Promise<void> {
    if (ticket.closing) return ticket.closing;
    ticket.controller.abort();
    ticket.closing = Promise.resolve(ticket.work)
      .catch(() => {})
      .then(() => {
        this.releaseSelected(ticket.selected);
        this.tickets.delete(id);
        this.outputs -= ticket.output;
        this.metadata -= 256;
      });
    return ticket.closing;
  }
  private closeLease(id: number, lease: Lease): Promise<void> {
    if (lease.closing) return lease.closing;
    const borrows = Array.from(this.tickets)
      .filter(([, ticket]) => ticket.lease === id)
      .map(([id, ticket]) => this.closeTicket(id, ticket));
    lease.closing = Promise.all(borrows).then(() => {
      this.releaseSelected(lease.selected);
      this.leases.delete(id);
      this.metadata -= 256;
    });
    return lease.closing;
  }
  close(value?: unknown): Promise<void> {
    if (value === undefined) return this.stop();
    const id = serial(value);
    this.closed.add(id);
    if (this.closed.size > 64) {
      const first = this.closed.values().next().value!;
      this.closed.delete(first);
      this.floor = Math.max(this.floor, first);
    }
    const ticket = this.tickets.get(id),
      lease = this.leases.get(id);
    if (ticket) return this.closeTicket(id, ticket);
    if (lease) return this.closeLease(id, lease);
    for (const operation of this.operations.values())
      if (operation.serial === id) operation.controller.abort();
    return Promise.resolve();
  }
  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    for (const operation of this.operations.values()) operation.controller.abort();
    const closing = Array.from(this.tickets, ([id, ticket]) => this.closeTicket(id, ticket)).concat(
      Array.from(this.leases, ([id, lease]) => this.closeLease(id, lease)),
    );
    const operations = Array.from(this.operations.values(), (operation) => operation.work);
    return (this.closing = Promise.all(operations.concat(closing)).then(() => undefined));
  }
  resources(): Record<string, number> {
    return {
      readerOperations: this.operations.size,
      readerTickets: this.tickets.size,
      readerLeases: this.leases.size,
      readerResultBytes: this.outputs,
      readerResultPeak: this.outputPeak,
      readerMetadataBytes: this.metadata,
      readerMetadataPeak: this.metadataPeak,
      readerSeedBytes: this.seedBytes,
      readerPinBytes: this.seedBytes + this.backend.shared.readerPinBytes(),
    };
  }
}
