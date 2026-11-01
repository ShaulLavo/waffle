import {
  CONTROL_GRANT_BYTES,
  CONTROL_GRANT_STATE_BYTES,
  consumedControlBytes,
  type SharedControlGrant,
} from "./control.js";
import { ProcessError, ProcessErrno } from "../proc/errors.js";
import type { ProcessExit } from "../proc/types.js";
import type { MemoryDeclaration } from "./declarations.js";

import {
  bytes,
  pages,
  validatePlatform,
  type ReservedBytes,
  type WasmPages,
  type SharedMemoryPlatform,
} from "./platform.js";
export { bytes, pages, declareSharedMemoryPlatform } from "./platform.js";
export type {
  ReservedBytes,
  WasmPages,
  CountedKinds,
  SharedMemoryPlatform,
  SharedMemoryDeclaration,
} from "./platform.js";
export const PAGE_BYTES = 65_536;
export const UNBOUNDED_ARENA_BYTES = 2_147_479_552;
export const BOUNDED_ARENA_BYTES = 67_108_864;
export const UNBOUNDED_GROUP_MAXIMUM_PAGES = 65_536;
export const BOUNDED_GROUP_MAXIMUM_PAGES = 16_384;
export type BufferShape =
  | { readonly kind: "fixed-buffer"; readonly length: ReservedBytes }
  | { readonly kind: "growable-buffer"; readonly initial: number; readonly maximum: ReservedBytes };
export type GroupMemoryShape =
  | { readonly kind: "growable"; readonly maximumPages: WasmPages }
  | { readonly kind: "fixed"; readonly pages: WasmPages };
export interface SharedGuestMemoryPlan {
  readonly initialPages: WasmPages;
  readonly actualMaximumPages: WasmPages;
  readonly sourceMaximumPages: WasmPages;
}
type SharedGuestMemoryShape = SharedGuestMemoryPlan & { readonly kind: "shared-guest" };
type AllocationShape = BufferShape | GroupMemoryShape | SharedGuestMemoryShape;
export type ReservationShape =
  | SharedGuestMemoryShape
  | BufferShape
  | GroupMemoryShape
  | { readonly kind: "guest"; readonly memories: readonly MemoryDeclaration[] };
export type RuntimeBufferLabel =
  | "filesystem-root"
  | "filesystem-segment"
  | "owner-states"
  | "workspace-publication"
  | "pipe-registry"
  | "control";
type HolderLabel =
  | RuntimeBufferLabel
  | "request-arena"
  | "memory-group"
  | "guest-memory"
  | "headroom"
  | "guest-control";
type HolderState = "live" | "draining" | "idle" | "awaiting-collection" | "debt";
interface Holder {
  readonly id: number;
  readonly runtime: symbol;
  readonly label: HolderLabel;
  readonly shape: ReservationShape;
  scope: "runtime" | "pooled" | "worker" | "ticket" | "shared-guest";
  readonly declaredBytes: number;
  readonly chargedBytes: number;
  readonly value?: WeakRef<SharedArrayBuffer>;
  readonly memory?: WeakRef<WebAssembly.Memory>;
  receipts: number;
  state: HolderState;
}
export interface SharedMemorySnapshot {
  readonly platform: SharedMemoryPlatform;
  readonly budgetBytes: number | null;
  readonly reservedBytes: number;
  readonly availableBytes: number | null;
  readonly awaitingReleaseBytes: number;
  readonly debtBytes: number;
  readonly effectiveBudgetBytes: number | null;
  readonly contradictions: readonly SharedMemoryContradiction[];
  readonly sharedGuests: readonly SharedGuestSnapshot[];
  readonly holders: readonly {
    readonly label: HolderLabel;
    readonly shape: ReservationShape;
    readonly scope: Holder["scope"];
    readonly state: HolderState;
    readonly declaredBytes: number;
    readonly grownBytes: number | null;
  }[];
}
export type BackingOwner = Readonly<{ directory: string; pid: number }>;
export type SharedGuestThreadKey = BackingOwner & Readonly<{ tid: number }>;
export type SharedGuestCallKey = Readonly<{ thread: SharedGuestThreadKey; sequence: number }>;
export type SharedGuestAliasRole =
  | Readonly<{ kind: "service"; incarnation: number }>
  | Readonly<{ kind: "guest"; thread: SharedGuestThreadKey }>;
export interface SharedGuestSnapshot extends SharedGuestMemoryPlan {
  readonly id: symbol;
  readonly owner: BackingOwner;
  readonly phase: "live" | "draining" | "awaiting-collection" | "debt";
  readonly aliases: Readonly<{ reserved: number; transferred: number; retained: number }>;
  readonly continuations: Readonly<{ active: number; retained: number }>;
  readonly fence: "pending" | "passed" | "failed";
  readonly chargedBytes: number;
}
/** Trusted page hooks, bound to the actual Worker before invoking stop. */
export interface SharedGuestStop {
  idle(): void | Promise<void>;
  terminate(): unknown;
  cleanup(): void | Promise<void>;
}
export interface SharedGuestStopReceipt {
  readonly alias: symbol;
}
export type SharedGuestFence =
  | Readonly<{ kind: "no-agent" }>
  | Readonly<{
      kind: "service";
      alias: SharedGuestAlias;
      drain(): void | Promise<void>;
      filesystem(): void | Promise<void>;
      dispose(): void | Promise<void>;
    }>;
export interface SharedGuestSafetyReceipt {
  readonly backing: symbol;
  readonly kind: "fenced" | "no-agent";
}
export interface SharedGuestSource {
  create(input: SharedGuestMemoryPlan & Readonly<{ owner: BackingOwner }>): SharedGuestBacking;
}
export interface SharedGuestBacking {
  readonly id: symbol;
  readonly owner: BackingOwner;
  alias(role: SharedGuestAliasRole): SharedGuestAlias;
  continuation(call: SharedGuestCallKey): BackingContinuation;
  seal(winner: ProcessExit): void;
  fence(input: SharedGuestFence): Promise<SharedGuestSafetyReceipt>;
  fail(cause: unknown): void;
  retire(): Readonly<{ kind: "pending" | "awaiting-collection" | "debt" }>;
}
export interface SharedGuestAlias {
  readonly id: symbol;
  transfer(): Readonly<{ memory: WebAssembly.Memory; alias: symbol }>;
  abortBeforeTransfer(): void;
  stop(lifecycle: SharedGuestStop): Promise<SharedGuestStopReceipt>;
  failed(cause: unknown): void;
}
export interface BackingContinuation {
  readonly id: symbol;
  /** Retain captured wait SABs and queued control deliveries under this admitted call. */
  retain(buffer: SharedArrayBuffer): () => void;
  settle(close: () => void | Promise<void>): Promise<void>;
  failed(cause: unknown): void;
}
interface SharedGuestRecord {
  readonly id: symbol;
  readonly runtime: symbol;
  readonly owner: BackingOwner;
  readonly plan: SharedGuestMemoryPlan;
  readonly holder: Holder;
  readonly aliases: Map<number | "service", SharedGuestAliasRecord>;
  readonly calls: Map<string, SharedGuestContinuationRecord>;
  readonly sequences: Map<number, number>;
  readonly buffers: WeakSet<SharedArrayBuffer>;
  memory: WebAssembly.Memory | undefined;
  phase: SharedGuestSnapshot["phase"];
  fence: SharedGuestSnapshot["fence"];
  safety: Promise<SharedGuestSafetyReceipt> | undefined;
}
interface SharedGuestAliasRecord {
  readonly backing: SharedGuestRecord;
  readonly role: SharedGuestAliasRole;
  phase: "reserved" | "transferred" | "stopped" | "aborted" | "retained";
  admission: "unclaimed" | "admitted" | "launched" | "settled";
  ticket: LaunchedTicket | undefined;
  physicalStop: boolean;
  exposure: "local" | "escaped";
  stop: Promise<SharedGuestStopReceipt> | undefined;
}
interface SharedGuestContinuationRecord {
  phase: "active" | "closing" | "settled" | "retained";
  readonly retained: Map<symbol, SharedArrayBuffer>;
  settlement: Promise<void> | undefined;
}
function backingOwner(owner: BackingOwner): BackingOwner {
  if (
    typeof owner.directory !== "string" ||
    !owner.directory ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0
  )
    throw new TypeError("Invalid shared guest owner");
  return Object.freeze({ directory: owner.directory, pid: owner.pid });
}
function sameBackingOwner(a: BackingOwner, b: BackingOwner): boolean {
  return a.directory === b.directory && a.pid === b.pid;
}
function nativeSharedGuestMemory(plan: SharedGuestMemoryPlan): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: plan.initialPages,
    maximum: plan.actualMaximumPages,
    shared: true,
  });
}
interface SharedMemoryContradiction {
  readonly label: string;
  readonly requestedBytes: number;
  readonly totalChargedBytesAfterRefund: number;
}
export type SharedMemoryRefusal =
  | {
      readonly kind: "budget";
      readonly requested: ReservedBytes;
      readonly available: ReservedBytes;
      readonly budget: ReservedBytes;
      readonly awaitingRelease: ReservedBytes;
    }
  | {
      readonly kind: "configuration";
      readonly configuration: "undeclared-module-memory" | "memory64-module";
    }
  | { readonly kind: "platform"; readonly label: string; readonly cause: RangeError }
  | {
      readonly kind: "uncounted-platform";
      readonly label: string;
      readonly requestedBytes: ReservedBytes;
      readonly cause: RangeError;
    };
export class SharedMemoryAdmissionError extends ProcessError {
  readonly code = "ENOMEM";
  constructor(readonly refusal: SharedMemoryRefusal) {
    super(ProcessErrno.NOMEM, describeRefusal(refusal));
    this.name = "SharedMemoryAdmissionError";
  }
}
function describeRefusal(refusal: SharedMemoryRefusal): string {
  if (refusal.kind === "configuration")
    return `Shared memory admission requires ${refusal.configuration}`;
  if (refusal.kind === "platform" || refusal.kind === "uncounted-platform")
    return `Shared memory platform refused ${refusal.label}: ${refusal.cause.message}`;
  return `Shared memory budget refused ${refusal.requested} bytes: ${refusal.available} available of ${refusal.budget}; ${refusal.awaitingRelease} awaiting release`;
}
export interface Headroom {
  readonly bytes: ReservedBytes;
}
export interface ArenaSource {
  create(headroom: Headroom | null): SharedArrayBuffer;
  strand(arena: SharedArrayBuffer): void;
}
export type GroupBacking =
  | {
      readonly kind: "growable";
      readonly memory: WebAssembly.Memory;
      readonly maximumPages: WasmPages;
      exposed: boolean;
    }
  | {
      readonly kind: "fixed";
      readonly memory: WebAssembly.Memory;
      readonly pages: WasmPages;
      exposed: boolean;
    };
export interface GroupMemorySource {
  control(length: number): SharedArrayBuffer;
  create(shape: GroupMemoryShape, headroom: Headroom | null): GroupBacking;
  retire(backing: GroupBacking): void;
  failed(backing: GroupBacking): void;
}
export interface ReservationSizing {
  readonly arena: { readonly bytes: ReservedBytes; readonly fallback: ReservedBytes | null };
  groupShape(maximumPages?: number): GroupMemoryShape;
}
export type ProcessGuestPlan =
  | { readonly kind: "declared"; readonly memories: readonly MemoryDeclaration[] }
  | { readonly kind: "undeclared" }
  | { readonly kind: "group" }
  | {
      readonly kind: "shared-alias";
      readonly alias: SharedGuestAlias;
      readonly owner: BackingOwner;
    };
export interface ProcessPlan {
  readonly pid: number;
  readonly executable: string;
  readonly guest: ProcessGuestPlan;
  readonly group: "none" | "join" | { readonly create: GroupMemoryShape };
  /** Adopted roots already own their filesystem connection. */
  readonly connection: boolean;
  readonly controls: boolean;
}
export interface Ticket {
  readonly control: SharedControlGrant;
  readonly arena: Headroom | null;
  readonly group: Headroom | null;
  abort(): void;
  launched(): LaunchedTicket;
}
export interface LaunchedTicket {
  controlAllocated(buffer: SharedArrayBuffer): void;
  stopped(): void;
  failed(errors: readonly unknown[]): void;
}
export interface RuntimeReservations {
  readonly sizing: ReservationSizing;
  readonly arenas: ArenaSource;
  readonly groups: GroupMemorySource;
  readonly sharedGuests: SharedGuestSource;
  buffer(label: RuntimeBufferLabel, shape: BufferShape): SharedArrayBuffer;
  ownsBuffer(label: RuntimeBufferLabel, buffer: SharedArrayBuffer): boolean;
  admit(plan: ProcessPlan): Ticket;
  snapshot(): SharedMemorySnapshot;
  check(
    plan: ProcessPlan,
  ):
    | { readonly kind: "admitted" }
    | { readonly kind: "refused"; readonly error: SharedMemoryAdmissionError };
  dispose(): void;
}
export interface ReservationAllocator {
  buffer(shape: BufferShape): SharedArrayBuffer;
  memory(shape: GroupMemoryShape): WebAssembly.Memory;
}
const allocator: ReservationAllocator = {
  buffer(shape) {
    if (shape.kind === "fixed-buffer") return new SharedArrayBuffer(shape.length);
    const value: unknown = Reflect.construct(SharedArrayBuffer, [
      shape.initial,
      { maxByteLength: shape.maximum },
    ]);
    if (!(value instanceof SharedArrayBuffer)) throw new TypeError("invalid shared buffer");
    return value;
  },
  memory(shape) {
    const maximum = shape.kind === "fixed" ? shape.pages : shape.maximumPages;
    return new WebAssembly.Memory({
      initial: shape.kind === "fixed" ? maximum : 1,
      maximum,
      shared: true,
    });
  },
};
function shapeBytes(shape: AllocationShape): number {
  if (shape.kind === "fixed-buffer") return shape.length;
  if (shape.kind === "growable-buffer") return shape.maximum;
  if (shape.kind === "shared-guest") return shape.actualMaximumPages * PAGE_BYTES;
  return (shape.kind === "fixed" ? shape.pages : shape.maximumPages) * PAGE_BYTES;
}
function chargeBytes(platform: SharedMemoryPlatform, shape: AllocationShape): number {
  if (platform.kind === "unbounded" || shape.kind === "growable-buffer") return shapeBytes(shape);
  const counts =
    shape.kind === "fixed-buffer" ? platform.counts.fixedBuffer : platform.counts.sharedMemory;
  return counts ? shapeBytes(shape) : 0;
}
function declaredGuestBytes(guest: Extract<ProcessGuestPlan, { kind: "declared" }>): number {
  let total = 0;
  for (const memory of guest.memories) total += memory.maximumPages * PAGE_BYTES;
  return total;
}
function guestBytes(platform: SharedMemoryPlatform, guest: ProcessGuestPlan): number {
  if (guest.kind !== "declared") return 0;
  let total = 0;
  for (const memory of guest.memories) {
    const counted =
      platform.kind === "unbounded" || memory.kind === "shared" || platform.counts.privateMemory;
    if (counted) total += memory.maximumPages * PAGE_BYTES;
  }
  return total;
}
function shapeKey(shape: GroupMemoryShape): string {
  return shape.kind === "fixed" ? `fixed:${shape.pages}` : `growable:${shape.maximumPages}`;
}

export class SharedMemoryLedger {
  private next = 1;
  private readonly holders = new Map<number, Holder>();
  private readonly sharedGuests = new Map<symbol, SharedGuestRecord>();
  private readonly aliases = new WeakMap<SharedGuestAlias, SharedGuestAliasRecord>();
  private readonly runtimes = new Set<symbol>();
  private readonly weakReceipts = new Map<number, Holder>();
  private readonly values = new WeakMap<object, Holder>();
  private readonly headrooms = new WeakMap<Headroom, Holder>();
  private readonly finalizer: { register(target: object, id: number): void };
  private ceiling: number | null = null;
  private readonly contradictions: SharedMemoryContradiction[] = [];
  constructor(
    private platform: SharedMemoryPlatform,
    private readonly allocations = allocator,
    finalizer: (receive: (id: number) => void) => { register(target: object, id: number): void } = (
      receive,
    ) => new FinalizationRegistry(receive),
    private readonly allocateSharedGuest = nativeSharedGuestMemory,
  ) {
    validatePlatform(platform);
    this.finalizer = finalizer((id) => this.collectReceipt(id));
  }
  private collectReceipt(id: number): void {
    const holder = this.weakReceipts.get(id);
    if (!holder) return;
    this.weakReceipts.delete(id);
    holder.receipts--;
    if (holder.receipts || holder.state === "debt") return;
    if (holder.scope === "shared-guest" && holder.state !== "awaiting-collection") return;
    this.holders.delete(holder.id);
    for (const record of this.sharedGuests.values())
      if (record.holder === holder) this.sharedGuests.delete(record.id);
  }

  openRuntime(platform: SharedMemoryPlatform): RuntimeReservations {
    validatePlatform(platform);
    // A later explicit override cannot erase debt or existing reservations.
    this.platform = platform;
    const runtime = Symbol("waffle.runtime.reservations");
    this.runtimes.add(runtime);
    const idle = new Map<string, GroupBacking[]>();
    const sizing: ReservationSizing = {
      arena:
        platform.kind === "bounded"
          ? { bytes: bytes(BOUNDED_ARENA_BYTES), fallback: null }
          : { bytes: bytes(UNBOUNDED_ARENA_BYTES), fallback: bytes(BOUNDED_ARENA_BYTES) },
      groupShape: (maximum) =>
        platform.kind === "bounded"
          ? { kind: "fixed", pages: pages(maximum ?? BOUNDED_GROUP_MAXIMUM_PAGES) }
          : { kind: "growable", maximumPages: pages(maximum ?? UNBOUNDED_GROUP_MAXIMUM_PAGES) },
    };
    return {
      sizing,
      arenas: {
        create: (headroom) => this.arena(runtime, sizing, headroom),
        strand: (value) => this.debt(value),
      },
      groups: {
        control: (length) =>
          this.construct(
            runtime,
            "control",
            { kind: "fixed-buffer", length: bytes(length) },
            null,
            () => this.allocations.buffer({ kind: "fixed-buffer", length: bytes(length) }),
          ),
        create: (shape, headroom) => this.group(runtime, idle, shape, headroom),
        retire: (backing) => this.retireGroup(idle, backing),
        failed: (backing) => this.debt(backing.memory),
      },
      sharedGuests: { create: (input) => this.createSharedGuest(runtime, input) },
      buffer: (label, shape) =>
        this.construct(runtime, label, shape, null, () => this.allocations.buffer(shape)),
      ownsBuffer: (label, buffer) => {
        const holder = this.values.get(buffer);
        return holder?.runtime === runtime && holder.label === label && holder.state === "live";
      },
      admit: (plan) => this.admit(runtime, sizing, plan),
      snapshot: () => this.snapshot(),
      check: (plan) => {
        try {
          this.validateSharedAlias(runtime, plan);
          this.validatePlan(sizing, plan);
          return { kind: "admitted" };
        } catch (error) {
          if (!(error instanceof SharedMemoryAdmissionError)) throw error;
          return { kind: "refused", error };
        }
      },
      dispose: () => {
        idle.clear();
        this.disposeRuntime(runtime);
      },
    };
  }
  snapshot(): SharedMemorySnapshot {
    const reserved = this.total();
    const budget = this.platform.kind === "bounded" ? this.platform.budgetBytes : null;
    const effective = this.effectiveBudget();
    return {
      platform: this.platform,
      budgetBytes: budget,
      reservedBytes: reserved,
      availableBytes: effective === null ? null : Math.max(0, effective - reserved),
      awaitingReleaseBytes: this.total("awaiting-collection"),
      debtBytes: this.total("debt"),
      effectiveBudgetBytes: effective,
      contradictions: this.contradictions.slice(),
      sharedGuests: Array.from(this.sharedGuests.values(), (record) =>
        this.sharedGuestSnapshot(record),
      ),
      holders: Array.from(this.holders.values(), (holder) => ({
        label: holder.label,
        shape: holder.shape,
        scope: holder.scope,
        state: holder.state,
        declaredBytes: holder.declaredBytes,
        grownBytes:
          holder.memory?.deref()?.buffer.byteLength ?? holder.value?.deref()?.byteLength ?? null,
      })),
    };
  }
  private total(state?: HolderState): number {
    let total = 0;
    for (const holder of this.holders.values())
      if (!state || holder.state === state) total += holder.chargedBytes;
    return total;
  }
  private effectiveBudget(): number | null {
    if (this.platform.kind === "unbounded") return this.ceiling;
    return Math.min(this.platform.budgetBytes, this.ceiling ?? Infinity);
  }
  private capacity(requested: number): void {
    const budget = this.effectiveBudget();
    if (budget === null) return;
    const available = Math.max(0, budget - this.total());
    if (requested <= available) return;
    throw new SharedMemoryAdmissionError({
      kind: "budget",
      requested: bytes(requested),
      available: bytes(available),
      budget: bytes(budget),
      awaitingRelease: bytes(this.total("awaiting-collection")),
    });
  }
  private record(
    runtime: symbol,
    label: HolderLabel,
    shape: ReservationShape,
    declaredBytes: number,
    chargedBytes: number,
    scope: Holder["scope"],
    value?: SharedArrayBuffer,
    memory?: WebAssembly.Memory,
  ): Holder {
    const holder: Holder = {
      id: this.next++,
      runtime,
      label,
      shape,
      scope,
      declaredBytes,
      chargedBytes,
      state: "live",
      receipts: 0,
      ...(memory ? { memory: new WeakRef(memory) } : {}),
      ...(value ? { value: new WeakRef(value) } : {}),
    };
    this.holders.set(holder.id, holder);
    if (value) {
      this.values.set(value, holder);
      this.registerReceipt(holder, memory ?? value);
      if (memory) this.values.set(memory, holder);
    }
    return holder;
  }
  private headroom(runtime: symbol, shape: BufferShape | GroupMemoryShape): Headroom {
    const charged = chargeBytes(this.platform, shape);
    const value = Object.freeze({ bytes: bytes(charged) });
    this.headrooms.set(
      value,
      this.record(runtime, "headroom", shape, shapeBytes(shape), charged, "ticket"),
    );
    return value;
  }
  private release(headroom: Headroom | null): void {
    if (!headroom) return;
    const holder = this.headrooms.get(headroom);
    if (!holder) return;
    this.holders.delete(holder.id);
    this.headrooms.delete(headroom);
  }
  private construct<T extends SharedArrayBuffer | WebAssembly.Memory>(
    runtime: symbol,
    label: HolderLabel,
    shape: AllocationShape,
    headroom: Headroom | null,
    create: () => T,
  ): T {
    this.release(headroom);
    const charged = chargeBytes(this.platform, shape);
    this.capacity(charged);
    const provisional = this.record(
      runtime,
      label,
      shape,
      shapeBytes(shape),
      charged,
      label === "request-arena" || label === "memory-group" ? "pooled" : "runtime",
    );
    let constructed = false;
    try {
      const value = create();
      constructed = true;
      const buffer = value instanceof WebAssembly.Memory ? value.buffer : value;
      if (!(buffer instanceof SharedArrayBuffer)) throw new TypeError("shared backing required");
      this.holders.delete(provisional.id);
      this.record(
        runtime,
        label,
        shape,
        shapeBytes(shape),
        charged,
        provisional.scope,
        buffer,
        value instanceof WebAssembly.Memory ? value : undefined,
      );
      return value;
    } catch (error) {
      if (constructed) {
        if (this.holders.has(provisional.id)) provisional.state = "debt";
        throw error;
      }
      this.holders.delete(provisional.id);
      if (!(error instanceof RangeError)) throw error;
      if (charged === 0)
        throw new SharedMemoryAdmissionError({
          kind: "uncounted-platform",
          label,
          requestedBytes: bytes(shapeBytes(shape)),
          cause: error,
        });
      this.contradiction(label, shapeBytes(shape));
      throw new SharedMemoryAdmissionError({ kind: "platform", label, cause: error });
    }
  }
  private arena(
    runtime: symbol,
    sizing: ReservationSizing,
    headroom: Headroom | null,
  ): SharedArrayBuffer {
    const shape: BufferShape = { kind: "growable-buffer", initial: 0, maximum: sizing.arena.bytes };
    try {
      return this.construct(runtime, "request-arena", shape, headroom, () =>
        this.allocations.buffer(shape),
      );
    } catch (error) {
      if (
        !sizing.arena.fallback ||
        !(error instanceof SharedMemoryAdmissionError) ||
        error.refusal.kind !== "platform"
      )
        throw error;
      const fallback: BufferShape = {
        kind: "growable-buffer",
        initial: 0,
        maximum: sizing.arena.fallback,
      };
      return this.construct(runtime, "request-arena", fallback, null, () =>
        this.allocations.buffer(fallback),
      );
    }
  }
  private group(
    runtime: symbol,
    idle: Map<string, GroupBacking[]>,
    shape: GroupMemoryShape,
    headroom: Headroom | null,
  ): GroupBacking {
    const previous = idle.get(shapeKey(shape))?.pop();
    if (previous) {
      this.release(headroom);
      // Fixed initial memory is fully guest-addressable, including ungranted pages.
      new Uint8Array(previous.memory.buffer).fill(0);
      const holder = this.values.get(previous.memory);
      if (holder) holder.state = "live";
      return previous;
    }
    const memory = this.construct(runtime, "memory-group", shape, headroom, () =>
      this.allocations.memory(shape),
    );
    return shape.kind === "fixed"
      ? { kind: "fixed", memory, pages: shape.pages, exposed: false }
      : { kind: "growable", memory, maximumPages: shape.maximumPages, exposed: false };
  }
  private retireGroup(idle: Map<string, GroupBacking[]>, backing: GroupBacking): void {
    const holder = this.values.get(backing.memory);
    if (!holder || holder.state !== "live") return;
    if (backing.kind !== "fixed" || backing.exposed) {
      if (backing.exposed) {
        this.registerReceipt(holder, backing.memory.buffer);
      }
      holder.state = "awaiting-collection";
      return;
    }
    holder.state = "idle";
    const key = shapeKey(backing);
    const pool = idle.get(key) ?? [];
    pool.push(backing);
    idle.set(key, pool);
  }
  private debt(value: object): void {
    const holder = this.values.get(value);
    if (holder) holder.state = "debt";
  }
  private validatePlan(sizing: ReservationSizing, plan: ProcessPlan): void {
    if (plan.guest.kind === "undeclared" && this.effectiveBudget() !== null)
      throw new SharedMemoryAdmissionError({
        kind: "configuration",
        configuration: "undeclared-module-memory",
      });
    const arena: BufferShape = { kind: "growable-buffer", initial: 0, maximum: sizing.arena.bytes };
    const group =
      typeof plan.group === "object" ? chargeBytes(this.platform, plan.group.create) : 0;
    this.capacity(
      guestBytes(this.platform, plan.guest) +
        (plan.connection ? chargeBytes(this.platform, arena) : 0) +
        group +
        (plan.controls ? this.controlCharge(CONTROL_GRANT_BYTES + CONTROL_GRANT_STATE_BYTES) : 0),
    );
  }
  private admit(runtime: symbol, sizing: ReservationSizing, plan: ProcessPlan): Ticket {
    const alias = this.validateSharedAlias(runtime, plan);
    this.validatePlan(sizing, plan);
    const amount = guestBytes(this.platform, plan.guest);
    const guest =
      plan.guest.kind === "declared"
        ? this.record(
            runtime,
            "guest-memory",
            { kind: "guest", memories: plan.guest.memories },
            declaredGuestBytes(plan.guest),
            amount,
            "worker",
          )
        : undefined;
    const arena = plan.connection
      ? this.headroom(runtime, { kind: "growable-buffer", initial: 0, maximum: sizing.arena.bytes })
      : null;
    const group = typeof plan.group === "object" ? this.headroom(runtime, plan.group.create) : null;
    let control: ReturnType<SharedMemoryLedger["controlGrant"]>;
    try {
      control = this.controlGrant(runtime, plan.controls);
    } catch (error) {
      this.release(arena);
      this.release(group);
      if (guest) this.holders.delete(guest.id);
      throw error;
    }
    let phase: "admitted" | "launched" | "settled" = "admitted";
    const release = () => {
      this.release(arena);
      this.release(group);
    };
    const launched: LaunchedTicket = {
      controlAllocated: (buffer) => control.receipt(buffer),
      stopped: () => {
        if (phase !== "launched") return;
        if (alias && !alias.physicalStop) throw new Error("Shared alias requires physical stop");
        phase = "settled";
        release();
        if (guest) this.holders.delete(guest.id);
        control.stopped();
      },
      failed: () => {
        if (phase !== "launched") return;
        phase = "settled";
        release();
        if (alias) this.failSharedGuest(alias.backing);
        if (guest) guest.state = "debt";
        control.failed();
      },
    };
    if (alias) alias.admission = "admitted";
    return {
      control: control.grant,
      arena,
      group,
      abort: () => {
        if (phase !== "admitted") return;
        phase = "settled";
        release();
        if (guest) this.holders.delete(guest.id);
        control.stopped();
        if (alias) {
          alias.admission = "settled";
          alias.phase = "aborted";
        }
      },
      launched: () => {
        if (phase === "admitted") {
          phase = "launched";
          this.bindSharedGuestTicket(alias, launched);
          release();
        }
        return launched;
      },
    };
  }
  private bindSharedGuestTicket(
    alias: SharedGuestAliasRecord | undefined,
    ticket: LaunchedTicket,
  ): void {
    if (!alias) return;
    alias.admission = "launched";
    alias.ticket = ticket;
  }
  private controlCharge(length: number): number {
    return this.platform.kind === "bounded" &&
      !this.platform.counts.fixedBuffer &&
      !this.platform.counts.privateMemory
      ? 0
      : length;
  }
  private controlGrant(runtime: symbol, enabled: boolean) {
    if (!enabled || this.effectiveBudget() === null)
      return {
        grant: { kind: "unbounded" as const },
        stopped() {},
        failed() {},
        receipt: (buffer: SharedArrayBuffer) => {
          if (!enabled) return;
          if (this.values.has(buffer)) return;
          this.record(
            runtime,
            "guest-control",
            { kind: "fixed-buffer", length: bytes(buffer.byteLength) },
            buffer.byteLength,
            this.controlCharge(buffer.byteLength),
            "runtime",
            buffer,
          );
        },
      };
    const shape: BufferShape = { kind: "fixed-buffer", length: bytes(CONTROL_GRANT_BYTES) };
    const stateShape: BufferShape = {
      kind: "fixed-buffer",
      length: bytes(CONTROL_GRANT_STATE_BYTES),
    };
    const holder = this.record(
      runtime,
      "guest-control",
      shape,
      CONTROL_GRANT_BYTES,
      this.controlCharge(CONTROL_GRANT_BYTES),
      "worker",
    );
    let state: SharedArrayBuffer;
    try {
      state = this.construct(runtime, "control", stateShape, null, () =>
        this.allocations.buffer(stateShape),
      );
    } catch (error) {
      this.holders.delete(holder.id);
      throw error;
    }
    const grant: SharedControlGrant = { kind: "bounded", state, limit: CONTROL_GRANT_BYTES };
    const seen = new WeakSet<SharedArrayBuffer>();
    let settled = false;
    let received = 0;
    return {
      grant,
      receipt: (buffer: SharedArrayBuffer) => {
        if (seen.has(buffer)) return;
        seen.add(buffer);
        received += buffer.byteLength;
        if (received > consumedControlBytes(grant))
          throw new TypeError("Control receipt exceeds charged allocations");
      },
      stopped: () => {
        if (settled) return;
        settled = true;
        this.holders.delete(holder.id);
        const consumed = consumedControlBytes(grant);
        if (!consumed) return;
        const debt = this.record(
          runtime,
          "guest-control",
          { kind: "fixed-buffer", length: bytes(consumed) },
          consumed,
          this.controlCharge(consumed),
          "worker",
        );
        debt.state = "debt";
      },
      failed: () => {
        settled = true;
        holder.state = "debt";
      },
    };
  }
  private registerReceipt(holder: Holder, target: object): void {
    if (!Number.isSafeInteger(this.next)) throw new RangeError("Reservation identity exhausted");
    const id = this.next++;
    holder.receipts++;
    this.weakReceipts.set(id, holder);
    try {
      this.finalizer.register(target, id);
    } catch (error) {
      holder.state = "debt";
      throw error;
    }
  }
  private createSharedGuest(
    runtime: symbol,
    input: SharedGuestMemoryPlan & Readonly<{ owner: BackingOwner }>,
  ): SharedGuestBacking {
    if (!this.runtimes.has(runtime)) throw new Error("Reservation runtime is disposed");
    const owner = backingOwner(input.owner);
    const plan = Object.freeze({
      initialPages: pages(input.initialPages),
      actualMaximumPages: pages(input.actualMaximumPages),
      sourceMaximumPages: pages(input.sourceMaximumPages),
    });
    if (
      plan.initialPages > plan.actualMaximumPages ||
      plan.actualMaximumPages > plan.sourceMaximumPages
    )
      throw new RangeError("Incompatible shared guest memory limits");
    for (const existing of this.sharedGuests.values())
      if (existing.runtime === runtime && sameBackingOwner(existing.owner, owner))
        throw new Error("Shared guest process incarnation already owns a backing");
    const shape: SharedGuestMemoryShape = { kind: "shared-guest", ...plan };
    const memory = this.construct(runtime, "guest-memory", shape, null, () =>
      this.allocateSharedGuest(plan),
    );
    const holder = this.values.get(memory);
    if (!holder) throw new Error("Missing shared guest holder");
    holder.scope = "shared-guest";
    const record: SharedGuestRecord = {
      id: Symbol("waffle.shared-guest"),
      runtime,
      owner,
      plan,
      holder,
      aliases: new Map(),
      calls: new Map(),
      sequences: new Map(),
      buffers: new WeakSet(),
      memory,
      phase: "live",
      fence: "pending",
      safety: undefined,
    };
    this.sharedGuests.set(record.id, record);
    this.trackSharedGuestBuffer(record, memory.buffer);
    return this.sharedGuestLease(record);
  }
  private sharedGuestLease(record: SharedGuestRecord): SharedGuestBacking {
    return Object.freeze({
      id: record.id,
      owner: record.owner,
      alias: (role: SharedGuestAliasRole) => this.sharedGuestAlias(record, role),
      continuation: (call: SharedGuestCallKey) => this.sharedGuestContinuation(record, call),
      seal: (_winner: ProcessExit) => {
        if (record.phase !== "live") return;
        record.phase = "draining";
        record.holder.state = "draining";
      },
      fence: (input: SharedGuestFence) => this.sharedGuestFence(record, input),
      fail: (_cause: unknown) => this.failSharedGuest(record),
      retire: () => this.retireSharedGuest(record),
    });
  }
  private assertSharedGuestAdmission(record: SharedGuestRecord): void {
    if (!this.runtimes.has(record.runtime) || record.phase !== "live")
      throw new Error("Shared guest backing admission is sealed");
  }
  private sharedGuestAlias(
    record: SharedGuestRecord,
    input: SharedGuestAliasRole,
  ): SharedGuestAlias {
    this.assertSharedGuestAdmission(record);
    const role = this.sharedGuestRole(record, input);
    const item: SharedGuestAliasRecord = {
      backing: record,
      role,
      phase: "reserved",
      admission: "unclaimed",
      ticket: undefined,
      physicalStop: false,
      exposure: "local",
      stop: undefined,
    };
    const alias: SharedGuestAlias = Object.freeze({
      id: Symbol("waffle.shared-guest.alias"),
      transfer: () => this.transferSharedGuest(item, alias.id),
      abortBeforeTransfer: () => this.abortSharedGuestAlias(item),
      stop: (lifecycle: SharedGuestStop) => this.stopSharedGuestAlias(item, alias.id, lifecycle),
      failed: (_cause: unknown) => {
        if (item.phase === "stopped" || item.phase === "aborted") return;
        item.phase = "retained";
        this.failSharedGuest(record);
      },
    });
    record.aliases.set(role.kind === "service" ? "service" : role.thread.tid, item);
    this.aliases.set(alias, item);
    return alias;
  }
  private sharedGuestRole(
    record: SharedGuestRecord,
    input: SharedGuestAliasRole,
  ): SharedGuestAliasRole {
    if (input.kind === "service") {
      if (!Number.isSafeInteger(input.incarnation) || input.incarnation < 0)
        throw new TypeError("Invalid shared guest service incarnation");
      if (record.aliases.has("service")) throw new Error("Shared guest service already reserved");
      return Object.freeze({ kind: "service", incarnation: input.incarnation });
    }
    if (
      !sameBackingOwner(record.owner, input.thread) ||
      !Number.isSafeInteger(input.thread.tid) ||
      input.thread.tid < 0
    )
      throw new TypeError("Invalid shared guest thread incarnation");
    if (record.aliases.has(input.thread.tid))
      throw new Error("Shared guest thread already reserved");
    return Object.freeze({
      kind: "guest",
      thread: Object.freeze({ ...record.owner, tid: input.thread.tid }),
    });
  }
  private validateSharedAlias(
    runtime: symbol,
    plan: ProcessPlan,
  ): SharedGuestAliasRecord | undefined {
    if (!this.runtimes.has(runtime)) throw new Error("Reservation runtime is disposed");
    if (plan.guest.kind !== "shared-alias") return;
    const alias = this.aliases.get(plan.guest.alias);
    if (
      !alias ||
      alias.backing.runtime !== runtime ||
      !sameBackingOwner(alias.backing.owner, plan.guest.owner) ||
      plan.pid !== alias.backing.owner.pid
    )
      throw new TypeError("Shared guest alias scope mismatch");
    this.assertSharedGuestAdmission(alias.backing);
    if (alias.phase !== "reserved" || alias.admission !== "unclaimed")
      throw new Error("Shared guest alias already admitted");
    if (
      !plan.controls ||
      plan.group !== "none" ||
      plan.connection !== (alias.role.kind === "service")
    )
      throw new TypeError(
        "Shared guest Workers require independent controls and service-only connections",
      );
    return alias;
  }
  private transferSharedGuest(
    alias: SharedGuestAliasRecord,
    id: symbol,
  ): Readonly<{ memory: WebAssembly.Memory; alias: symbol }> {
    this.assertSharedGuestAdmission(alias.backing);
    if (alias.phase !== "reserved" || alias.admission !== "launched")
      throw new Error("Shared guest alias must launch before transfer");
    const memory = alias.backing.memory;
    if (!memory) throw new Error("Shared guest backing is retired");
    this.trackSharedGuestBuffer(alias.backing, memory.buffer);
    alias.phase = "transferred";
    alias.exposure = "escaped";
    return Object.freeze({ memory, alias: id });
  }
  private abortSharedGuestAlias(alias: SharedGuestAliasRecord): void {
    if (alias.phase === "aborted") return;
    if (
      alias.phase !== "reserved" ||
      (alias.admission !== "unclaimed" && alias.admission !== "settled")
    )
      throw new Error("Shared guest alias cannot abort after Worker launch");
    alias.phase = "aborted";
  }
  private stopSharedGuestAlias(
    alias: SharedGuestAliasRecord,
    id: symbol,
    lifecycle: SharedGuestStop,
  ): Promise<SharedGuestStopReceipt> {
    if (alias.stop) return alias.stop;
    if (
      alias.admission !== "launched" ||
      (alias.phase !== "transferred" && alias.phase !== "reserved" && alias.phase !== "retained")
    )
      throw new Error("Shared guest stop requires its launched Worker");
    if (
      alias.role.kind === "service" &&
      alias.exposure === "escaped" &&
      alias.backing.fence !== "passed" &&
      alias.backing.phase !== "debt"
    )
      throw new Error("Shared guest service stop requires its safety fence");
    alias.stop = Promise.resolve().then(() => this.finishSharedGuestStop(alias, id, lifecycle));
    return alias.stop;
  }
  private async finishSharedGuestStop(
    alias: SharedGuestAliasRecord,
    id: symbol,
    lifecycle: SharedGuestStop,
  ): Promise<SharedGuestStopReceipt> {
    const errors: unknown[] = [];
    // An idle failure still requires an attempt to stop and clean this Worker.
    for (const step of [lifecycle.idle, lifecycle.terminate, lifecycle.cleanup]) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      alias.phase = "retained";
      this.failSharedGuest(alias.backing);
      alias.ticket?.failed(errors);
      alias.ticket = undefined;
      throw new AggregateError(errors, "Shared guest Worker stop failed");
    }
    alias.physicalStop = true;
    if (alias.phase !== "retained") alias.phase = "stopped";
    try {
      alias.ticket?.stopped();
      alias.ticket = undefined;
    } catch (error) {
      alias.phase = "retained";
      this.failSharedGuest(alias.backing);
      throw error;
    }
    return Object.freeze({ alias: id });
  }
  private sharedGuestContinuation(
    record: SharedGuestRecord,
    call: SharedGuestCallKey,
  ): BackingContinuation {
    this.assertSharedGuestAdmission(record);
    if (
      !sameBackingOwner(record.owner, call.thread) ||
      !Number.isSafeInteger(call.thread.tid) ||
      call.thread.tid < 0 ||
      !Number.isSafeInteger(call.sequence) ||
      call.sequence < 0
    )
      throw new TypeError("Invalid shared guest call incarnation");
    const key = `${call.thread.tid}:${call.sequence}`;
    const last = record.sequences.get(call.thread.tid) ?? -1;
    if (call.sequence <= last) throw new Error("Shared guest call already admitted");
    const source = record.aliases.get(call.thread.tid);
    if (!source || (source.phase !== "reserved" && source.phase !== "transferred"))
      throw new Error("Shared guest call requires its live thread alias");
    record.sequences.set(call.thread.tid, call.sequence);
    const item: SharedGuestContinuationRecord = {
      phase: "active",
      retained: new Map(),
      settlement: undefined,
    };
    record.calls.set(key, item);
    return Object.freeze({
      id: Symbol("waffle.shared-guest.continuation"),
      retain: (buffer: SharedArrayBuffer) => this.retainSharedGuestBuffer(record, item, buffer),
      settle: (close: () => void | Promise<void>) => {
        if (item.settlement) return item.settlement;
        if (item.phase !== "active") throw new Error("Shared guest continuation is retained");
        item.phase = "closing";
        item.settlement = Promise.resolve().then(() =>
          this.settleSharedGuestContinuation(record, key, item, close),
        );
        return item.settlement;
      },
      failed: (_cause: unknown) => {
        if (item.phase === "settled") return;
        item.phase = "retained";
        this.failSharedGuest(record);
      },
    });
  }
  private async settleSharedGuestContinuation(
    record: SharedGuestRecord,
    key: string,
    item: SharedGuestContinuationRecord,
    close: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await close();
      if (item.retained.size)
        throw new Error("Shared guest continuation still owns captured buffers");
      if (item.phase === "retained")
        throw new Error("Shared guest continuation failed during retirement");
      item.phase = "settled";
      record.calls.delete(key);
    } catch (error) {
      item.phase = "retained";
      this.failSharedGuest(record);
      throw error;
    }
  }
  private trackSharedGuestBuffer(record: SharedGuestRecord, buffer: ArrayBufferLike): void {
    try {
      if (
        !(buffer instanceof SharedArrayBuffer) ||
        buffer.byteLength > record.plan.actualMaximumPages * PAGE_BYTES
      )
        throw new TypeError("Invalid shared guest backing buffer");
      if (record.buffers.has(buffer)) return;
      record.buffers.add(buffer);
      this.registerReceipt(record.holder, buffer);
    } catch (error) {
      this.failSharedGuest(record);
      throw error;
    }
  }
  private retainSharedGuestBuffer(
    record: SharedGuestRecord,
    item: SharedGuestContinuationRecord,
    buffer: SharedArrayBuffer,
  ): () => void {
    if (item.phase !== "active" && item.phase !== "closing")
      throw new Error("Shared guest continuation is closed");
    try {
      this.trackSharedGuestBuffer(record, buffer);
    } catch (error) {
      item.phase = "retained";
      this.failSharedGuest(record);
      throw error;
    }
    const id = Symbol("waffle.shared-guest.buffer");
    item.retained.set(id, buffer);
    return () => {
      item.retained.delete(id);
    };
  }
  private sharedGuestFence(
    record: SharedGuestRecord,
    input: SharedGuestFence,
  ): Promise<SharedGuestSafetyReceipt> {
    if (record.safety) return record.safety;
    if (record.phase !== "draining")
      throw new Error("Shared guest safety requires sealed admission");
    record.safety = Promise.resolve().then(() => this.finishSharedGuestFence(record, input));
    return record.safety;
  }
  private async finishSharedGuestFence(
    record: SharedGuestRecord,
    input: SharedGuestFence,
  ): Promise<SharedGuestSafetyReceipt> {
    try {
      if (input.kind === "no-agent") this.assertSharedGuestRollback(record);
      else await this.drainSharedGuestService(record, input);
      if (record.phase === "debt") throw new Error("Shared guest backing is retained as debt");
      record.fence = "passed";
      return Object.freeze({
        backing: record.id,
        kind: input.kind === "service" ? "fenced" : "no-agent",
      });
    } catch (error) {
      record.fence = "failed";
      this.failSharedGuest(record);
      throw error;
    }
  }
  private assertSharedGuestRollback(record: SharedGuestRecord): void {
    if (record.sequences.size) throw new Error("Shared guest rollback has admitted calls");
    for (const alias of record.aliases.values())
      if (alias.exposure !== "local" || (alias.phase !== "aborted" && alias.phase !== "stopped"))
        throw new Error("Shared guest rollback has possible agents");
  }
  private async drainSharedGuestService(
    record: SharedGuestRecord,
    input: Extract<SharedGuestFence, { kind: "service" }>,
  ): Promise<void> {
    const service = this.aliases.get(input.alias);
    if (
      !service ||
      service.backing !== record ||
      service.role.kind !== "service" ||
      service.phase !== "transferred"
    )
      throw new TypeError("Shared guest safety service incarnation mismatch");
    await input.drain();
    for (const item of record.calls.values())
      if (item.phase !== "settled")
        throw new Error("Shared guest service still owns continuations");
    this.assertSharedGuestSafety(record);
    await input.filesystem();
    this.assertSharedGuestSafety(record);
    await input.dispose();
  }
  private assertSharedGuestSafety(record: SharedGuestRecord): void {
    if (record.phase === "debt") throw new Error("Shared guest safety failed");
  }
  private failSharedGuest(record: SharedGuestRecord): void {
    if (record.phase === "awaiting-collection" || record.phase === "debt") return;
    record.phase = "debt";
    record.holder.state = "debt";
  }
  private retireSharedGuest(
    record: SharedGuestRecord,
  ): Readonly<{ kind: "pending" | "awaiting-collection" | "debt" }> {
    if (record.phase === "debt" || record.phase === "awaiting-collection")
      return { kind: record.phase };
    if (record.phase !== "draining" || record.fence !== "passed") return { kind: "pending" };
    for (const alias of record.aliases.values())
      if (alias.phase !== "stopped" && alias.phase !== "aborted") return { kind: "pending" };
    for (const item of record.calls.values())
      if (item.phase !== "settled") return { kind: "pending" };
    if (record.memory) this.trackSharedGuestBuffer(record, record.memory.buffer);
    record.memory = undefined;
    record.phase = "awaiting-collection";
    record.holder.state = "awaiting-collection";
    return { kind: "awaiting-collection" };
  }
  private sharedGuestSnapshot(record: SharedGuestRecord): SharedGuestSnapshot {
    const aliases = { reserved: 0, transferred: 0, retained: 0 };
    for (const alias of record.aliases.values())
      if (alias.phase === "reserved" || alias.phase === "transferred" || alias.phase === "retained")
        aliases[alias.phase]++;
    const continuations = { active: 0, retained: 0 };
    for (const item of record.calls.values()) {
      if (item.phase === "active" || item.phase === "closing") continuations.active++;
      if (item.phase === "retained") continuations.retained++;
    }
    return {
      id: record.id,
      owner: record.owner,
      ...record.plan,
      phase: record.phase,
      aliases,
      continuations,
      fence: record.fence,
      chargedBytes: record.holder.chargedBytes,
    };
  }
  private disposeRuntime(runtime: symbol): void {
    this.runtimes.delete(runtime);
    for (const record of this.sharedGuests.values())
      if (record.runtime === runtime && record.phase !== "awaiting-collection")
        this.failSharedGuest(record);
    for (const holder of this.holders.values()) {
      if (holder.runtime !== runtime || holder.state === "debt" || holder.scope === "shared-guest")
        continue;
      holder.state = holder.scope === "worker" ? "debt" : "awaiting-collection";
    }
  }
  private contradiction(label: HolderLabel, requestedBytes: number): void {
    const budget = this.effectiveBudget();
    // Preserve the unbounded arena ladder until a bounded contradiction set a page cap.
    if (budget === null) return;
    const totalChargedBytesAfterRefund = this.total();
    this.ceiling = Math.min(budget, totalChargedBytesAfterRefund);
    this.contradictions.push(
      Object.freeze({ label, requestedBytes, totalChargedBytesAfterRefund }),
    );
  }
}
const pageLedgerKey = Symbol.for("waffle.shared-memory.ledger");
const host = globalThis as typeof globalThis & { [pageLedgerKey]?: SharedMemoryLedger };
export function pageSharedMemoryLedger(platform: SharedMemoryPlatform): SharedMemoryLedger {
  validatePlatform(platform);
  return (host[pageLedgerKey] ??= new SharedMemoryLedger(platform));
}
