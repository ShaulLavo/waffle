import { MemoryBackend } from "./backend.js";
import type { Node, DirNode } from "./memory.js";
import { ReaderPagePressure, type SharedPageVersion } from "./shared-version-pages.js";
import {
  PayloadRetentionPressure,
  PayloadMetadataPressure,
  PayloadCorruption,
  type StorageBackend,
  type PayloadRetention,
} from "./storage.js";
import { FilesystemError, PAGE } from "./protocol.js";
import {
  namespaceCut,
  ReadRefusal,
  ReaderLifetime,
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
  if (error instanceof ReaderPagePressure) return { kind: "pressure", resource: "pin-bytes" };
  if (error instanceof PayloadCorruption) return { kind: "corrupt", message: error.message };
  if (error instanceof PayloadMetadataPressure) return { kind: "pressure", resource: "metadata" };
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
export class WorkspaceReadBudget {
  operations = 0;
  tickets = 0;
  leases = 0;
  outputs = 0;
  outputPeak = 0;
  metadata: number;
  metadataPeak: number;
  constructor(lifetimeBytes = 0) {
    this.metadata = 65536 + lifetimeBytes;
    this.metadataPeak = this.metadata;
  }
  readonly seeds = new Map<ArrayBufferLike, number>();
  seedBytes = 0;
  takeMetadata(bytes: number): void {
    if (bytes > LIMIT.metadata - this.metadata) pressure("metadata");
    this.metadata += bytes;
    this.metadataPeak = Math.max(this.metadataPeak, this.metadata);
  }
  releaseMetadata(bytes: number): void {
    this.metadata -= bytes;
  }
  resources(backend: MemoryBackend): Record<string, number> {
    return {
      readerOperations: this.operations,
      readerTickets: this.tickets,
      readerLeases: this.leases,
      readerResultBytes: this.outputs,
      readerResultPeak: this.outputPeak,
      readerMetadataBytes: this.metadata,
      readerMetadataPeak: this.metadataPeak,
      readerSeedBytes: this.seedBytes,
      readerPinBytes: this.seedBytes + backend.shared.readerPinBytes(),
    };
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
  private readonly closed: [number, number][] = [];
  private serialsExhausted = false;
  private stopping = false;
  private closing?: Promise<void>;
  constructor(
    private readonly backend: MemoryBackend,
    private readonly budget: WorkspaceReadBudget,
    readonly lifetime: ReaderLifetime,
  ) {
    this.budget.takeMetadata(1280);
    this.lifetime.begin();
  }
  private isClosed(id: number): boolean {
    return this.closed.some(([first, last]) => id >= first && id <= last);
  }
  private rememberClosed(id: number): void {
    if (this.serialsExhausted) return;
    let first = id,
      last = id,
      index = 0;
    while (index < this.closed.length && this.closed[index]![1] < first - 1) index++;
    while (index < this.closed.length && this.closed[index]![0] <= last + 1) {
      const previous = this.closed.splice(index, 1)[0]!;
      first = Math.min(first, previous[0]);
      last = Math.max(last, previous[1]);
    }
    if (this.closed.length === 64) {
      this.serialsExhausted = true;
      this.closed.length = 0;
      return;
    }
    this.closed.splice(index, 0, [first, last]);
  }
  private current(): NamespaceCut {
    return namespaceCut(this.backend.workspaceId, this.backend.shared.publication!.cut());
  }
  private lock<T>(run: () => T): T {
    return this.backend.shared.mutate(undefined, undefined, run);
  }
  invoke(operation: string, args: unknown[], request: number): Promise<unknown> {
    if (operation === "publicationReadClose") return this.close(args[1]);
    if (
      ![
        "publicationReadOpen",
        "publicationReadStat",
        "publicationReadPin",
        "publicationReadLeaseOpen",
        "publicationReadChunk",
      ].includes(operation)
    )
      return Promise.resolve({ kind: "invalid", field: "target" });
    if (this.stopping) return Promise.resolve({ kind: "stopped" });
    if (this.budget.operations >= LIMIT.operations)
      return Promise.resolve({ kind: "pressure", resource: "operations" });
    const controller = new AbortController(),
      id = serial(args[1]);
    const active: { controller: AbortController; serial: number; work?: Promise<unknown> } = {
      controller,
      serial: id,
    };
    this.operations.set(request, active);
    this.budget.operations++;
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
        this.budget.operations--;
      });
    active.work = work;
    return work;
  }
  cancel(request: number): void {
    const active = this.operations.get(request);
    if (active) {
      active.controller.abort();
      void this.close(active.serial).catch(() => {});
    }
  }
  private async run(operation: string, args: unknown[], signal: AbortSignal): Promise<unknown> {
    const id = serial(args[1]);
    if (operation === "publicationReadChunk") return this.chunk(id, args[2], signal);
    if (this.serialsExhausted) return { kind: "unavailable" };
    if (this.isClosed(id)) return { kind: "cancelled" };
    if (this.tickets.has(id) || this.leases.has(id)) throw new FilesystemError(28);
    if (operation === "publicationReadLeaseOpen")
      return this.openLease(id, serial(args[2]), readRange(args[3]));
    const target = readTarget(args[2]),
      requested = readRange(args[3]),
      version = readVersion(args[4]),
      at = readCut(args[5]);
    const scanBytes =
      256 + WORKSPACE_LIMITS.depth * 64 + (typeof target === "string" ? target.length * 2 : 0);
    this.takeMetadata(scanBytes);
    try {
      return await this.resolve(target, signal, (node) => {
        signal.throwIfAborted();
        if (this.stopping || this.isClosed(id))
          return { kind: this.stopping ? "stopped" : "cancelled" };
        return this.select(operation, id, target, node, requested, version, at);
      });
    } finally {
      this.budget.metadata -= scanBytes;
      if (operation === "publicationReadStat") this.rememberClosed(id);
    }
  }
  private async resolve<T>(
    target: FileTarget,
    signal: AbortSignal,
    select: (node: Node | undefined) => T,
  ): Promise<T> {
    if (typeof target === "string") return this.lock(() => select(this.path(target)));
    const initial = this.lock(() => this.current());
    const frames: ScanFrame[] = [
      { node: this.backend.fs.root, iterator: this.backend.fs.root.children.values() },
    ];
    const found = this.lock(() => {
      const node = this.detached(target);
      if (!node && !(this.backend.readMetadata(this.backend.fs.root).mode! & 0o100))
        throw new FilesystemError(2);
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
  private path(path: string): Node | undefined {
    const parents: DirNode[] = [];
    let node: Node = this.backend.fs.root;
    for (const part of path.split("/")) {
      if (!part) continue;
      if (node.kind !== "dir") throw new FilesystemError(54);
      if (!(this.backend.readMetadata(node).mode! & 0o100)) throw new FilesystemError(2);
      if (part === ".") continue;
      if (part === "..") {
        node = parents.pop() ?? this.backend.fs.root;
        continue;
      }
      if (parents.length >= WORKSPACE_LIMITS.depth) pressure("metadata");
      parents.push(node);
      const child = node.children.get(part);
      if (!child) return undefined;
      node = child;
    }
    if (path.endsWith("/") && node.kind !== "dir") throw new FilesystemError(54);
    return node;
  }
  private detached(target: FileTarget): Node | undefined {
    if (this.backend.ensureIdentity(this.backend.fs.root).id === target)
      return this.backend.fs.root;
    for (const handle of this.backend.shared.registeredHandles()) {
      if (this.backend.shared.identity(handle)?.id !== target) continue;
      const node = this.backend.fs.nodeForHandle(handle);
      if (!this.backend.fs.hasNode(node)) return node;
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
      if (node.kind !== "dir" || !(this.backend.readMetadata(node).mode! & 0o100)) continue;
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
    if (typeof target === "string" && !node) return { kind: "not-found" };
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
    return this.capture(operation, id, node, stat, requested);
  }
  private capture(
    operation: string,
    id: number,
    node: Extract<Node, { kind: "file" }>,
    stat: VersionStat,
    requested?: ByteRange,
  ): ReadOutcome<unknown> {
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
        this.budget,
      );
    } catch (error) {
      this.budget.metadata -= charge;
      throw error;
    }
    const keyBytes = backing.kind === "cold" ? backing.key.length * 2 : 0;
    try {
      this.takeMetadata(keyBytes);
    } catch (error) {
      if (backing.kind === "cold") backing.retention.release();
      if (backing.kind === "resident") backing.pages.release();
      this.budget.metadata -= charge;
      throw error;
    }
    const selected: Selected = { stat, backing, refs: 0, metadata: charge + keyBytes };
    try {
      this.retainSeed(backing);
      if (this.backend.shared.readerPinBytes() + this.budget.seedBytes > LIMIT.pinBytes)
        pressure("pin-bytes");
      return this.fromSelected(operation, id, selected, requested);
    } catch (error) {
      this.releaseSelected(selected);
      throw error;
    }
  }
  private admit(operation: string, range: ByteRange): void {
    if (operation === "publicationReadPin") {
      if (this.budget.leases >= LIMIT.leases) pressure("leases");
      return;
    }
    if (range.length > LIMIT.result) pressure("result-bytes");
    if (this.budget.tickets >= LIMIT.operations) pressure("operations");
    if (this.outputCost(range.length) > LIMIT.resultBytes - this.budget.outputs)
      pressure("result-bytes");
  }
  private outputCost(length: number): number {
    return 8 * length + 8 * PAGE + 4 * LIMIT.chunk + 8192;
  }
  private takeMetadata(bytes: number): void {
    this.budget.takeMetadata(bytes);
  }
  private retainSeed(backing: ReadBacking): void {
    if (backing.kind !== "seed") return;
    const buffer = backing.bytes.buffer,
      refs = this.budget.seeds.get(buffer) ?? 0;
    if (!refs && buffer.byteLength > LIMIT.pinBytes - this.budget.seedBytes) pressure("pin-bytes");
    this.budget.seeds.set(buffer, refs + 1);
    if (!refs) this.budget.seedBytes += buffer.byteLength;
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
      this.budget.leases++;
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
    this.budget.outputs += output;
    this.budget.outputPeak = Math.max(this.budget.outputPeak, this.budget.outputs);
    this.budget.tickets++;
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
    this.budget.metadata -= selected.metadata;
  }
  private releaseSeed(backing: Extract<ReadBacking, { kind: "seed" }>): void {
    const buffer = backing.bytes.buffer,
      refs = this.budget.seeds.get(buffer);
    if (refs === undefined) return;
    if (refs > 1) this.budget.seeds.set(buffer, refs - 1);
    else {
      this.budget.seeds.delete(buffer);
      this.budget.seedBytes -= buffer.byteLength;
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
        this.budget.tickets--;
        this.budget.outputs -= ticket.output;
        this.budget.metadata -= 256;
      });
    return ticket.closing;
  }
  private closeLease(id: number, lease: Lease): Promise<void> {
    if (lease.closing) return lease.closing;
    const borrows = Array.from(this.tickets)
      .filter(([, ticket]) => ticket.lease === id)
      .map(([id, ticket]) => this.closeTicket(id, ticket));
    lease.closing = joinReaders(borrows).then(() => {
      this.releaseSelected(lease.selected);
      this.leases.delete(id);
      this.budget.leases--;
      this.budget.metadata -= 256;
    });
    return lease.closing;
  }
  close(value?: unknown): Promise<void> {
    if (value === undefined) return this.stop();
    const id = serial(value);
    this.rememberClosed(id);
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
    const closing = Array.from(this.leases, ([id, lease]) => this.closeLease(id, lease)).concat(
      Array.from(this.tickets)
        .filter(([, ticket]) => ticket.lease === undefined)
        .map(([id, ticket]) => this.closeTicket(id, ticket)),
    );
    const operations = Array.from(this.operations.values(), (operation) => operation.work);
    return (this.closing = joinReaders(operations.concat(closing)).then(
      () => {
        this.budget.metadata -= 1280;
        this.lifetime.finish(false);
      },
      (error: unknown) => {
        this.lifetime.finish(true);
        throw error;
      },
    ));
  }
}

async function joinReaders(work: readonly (Promise<unknown> | undefined)[]): Promise<void> {
  const failures = (await Promise.allSettled(work)).flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Reader cleanup failed");
}
