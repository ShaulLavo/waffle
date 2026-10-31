import {
  CONTROL_GRANT_BYTES,
  CONTROL_GRANT_STATE_BYTES,
  consumedControlBytes,
  type SharedControlGrant,
} from "./control.js";
import { ProcessError, ProcessErrno } from "../proc/errors.js";
import type { MemoryDeclaration } from "./declarations.js";

const reservedBytesBrand: unique symbol = Symbol("waffle.reserved-bytes");
const wasmPagesBrand: unique symbol = Symbol("waffle.wasm-pages");
export type ReservedBytes = number & { readonly [reservedBytesBrand]: true };
export type WasmPages = number & { readonly [wasmPagesBrand]: true };
export const PAGE_BYTES = 65_536;
export const DESKTOP_ARENA_BYTES = 2_147_479_552;
export const BOUNDED_ARENA_BYTES = 67_108_864;
export const DESKTOP_GROUP_MAXIMUM_PAGES = 65_536;
export const BOUNDED_GROUP_MAXIMUM_PAGES = 16_384;
export const PROBE_CEILING_BYTES = 16 * 1024 ** 3;
export const PROBE_SAFETY_MARGIN_BYTES = 256 * 1024 ** 2;

function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}
export function bytes(value: number): ReservedBytes {
  return integer(value, "bytes") as ReservedBytes;
}
export function pages(value: number): WasmPages {
  if (value > 65_536) throw new RangeError("pages exceed wasm32 memory");
  return integer(value, "pages") as WasmPages;
}
export interface CountedKinds {
  readonly fixedBuffer: boolean;
  readonly sharedMemory: boolean;
  readonly privateMemory: boolean;
}
type PlatformInput =
  | { readonly kind: "unbounded" }
  | {
      readonly kind: "bounded";
      readonly budgetBytes: ReservedBytes;
      readonly counts: CountedKinds;
    };
export type SharedMemoryPlatform =
  | {
      readonly kind: "unbounded";
      readonly source: "measured" | "declared";
      readonly probedBytes: ReservedBytes;
    }
  | {
      readonly kind: "bounded";
      readonly source: "measured" | "declared";
      readonly budgetBytes: ReservedBytes;
      readonly counts: CountedKinds;
    };
export type BufferShape =
  | { readonly kind: "fixed-buffer"; readonly length: ReservedBytes }
  | { readonly kind: "growable-buffer"; readonly initial: number; readonly maximum: ReservedBytes };
export type GroupMemoryShape =
  | { readonly kind: "growable"; readonly maximumPages: WasmPages }
  | { readonly kind: "fixed"; readonly pages: WasmPages };
export type ReservationShape =
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
type HolderState = "live" | "idle" | "awaiting-collection" | "debt";
interface Holder {
  readonly id: number;
  readonly runtime: symbol;
  readonly label: HolderLabel;
  readonly shape: ReservationShape;
  readonly scope: "runtime" | "pooled" | "worker" | "ticket";
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
  readonly measurementError: string | null;
  readonly holders: readonly {
    readonly label: HolderLabel;
    readonly shape: ReservationShape;
    readonly scope: Holder["scope"];
    readonly state: HolderState;
    readonly declaredBytes: number;
    readonly grownBytes: number | null;
  }[];
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
  | { readonly kind: "platform"; readonly label: string; readonly cause: RangeError };
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
  if (refusal.kind === "platform")
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
  | { readonly kind: "group" };
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
  buffer(label: RuntimeBufferLabel, shape: BufferShape): SharedArrayBuffer;
  admit(plan: ProcessPlan): Ticket;
  settled(): Promise<void>;
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
function shapeBytes(shape: BufferShape | GroupMemoryShape): number {
  if (shape.kind === "fixed-buffer") return shape.length;
  if (shape.kind === "growable-buffer") return shape.maximum;
  return (shape.kind === "fixed" ? shape.pages : shape.maximumPages) * PAGE_BYTES;
}
function chargeBytes(
  platform: SharedMemoryPlatform,
  shape: BufferShape | GroupMemoryShape,
): number {
  if (platform.kind === "unbounded" || shape.kind === "growable-buffer") return shapeBytes(shape);
  const counts =
    shape.kind === "fixed-buffer" ? platform.counts.fixedBuffer : platform.counts.sharedMemory;
  return counts ? shapeBytes(shape) : 0;
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
  private readonly values = new WeakMap<object, Holder>();
  private readonly headrooms = new WeakMap<Headroom, Holder>();
  private readonly finalizer: { register(target: object, id: number): void };
  private pending?: Promise<void>;
  private measurementError: string | null = null;
  constructor(
    private platform: SharedMemoryPlatform,
    private readonly allocations = allocator,
    private readonly remeasure = () => measureSharedMemory({ remeasure: true }),
    finalizer: (receive: (id: number) => void) => { register(target: object, id: number): void } = (
      receive,
    ) => new FinalizationRegistry(receive),
  ) {
    this.finalizer = finalizer((id) => {
      const holder = this.holders.get(id);
      if (!holder) return;
      holder.receipts--;
      if (holder.receipts === 0 && holder.state !== "debt") this.holders.delete(id);
    });
  }

  openRuntime(platform: SharedMemoryPlatform): RuntimeReservations {
    validatePlatform(platform);
    // A later explicit override cannot erase debt or existing reservations.
    this.platform = platform;
    const runtime = Symbol("waffle.runtime.reservations");
    const idle = new Map<string, GroupBacking[]>();
    const sizing: ReservationSizing = {
      arena:
        platform.kind === "bounded"
          ? { bytes: bytes(BOUNDED_ARENA_BYTES), fallback: null }
          : { bytes: bytes(DESKTOP_ARENA_BYTES), fallback: bytes(BOUNDED_ARENA_BYTES) },
      groupShape: (maximum) =>
        platform.kind === "bounded"
          ? { kind: "fixed", pages: pages(maximum ?? BOUNDED_GROUP_MAXIMUM_PAGES) }
          : { kind: "growable", maximumPages: pages(maximum ?? DESKTOP_GROUP_MAXIMUM_PAGES) },
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
      buffer: (label, shape) =>
        this.construct(runtime, label, shape, null, () => this.allocations.buffer(shape)),
      admit: (plan) => this.admit(runtime, sizing, plan),
      settled: () => this.pending ?? Promise.resolve(),
      snapshot: () => this.snapshot(),
      check: (plan) => {
        try {
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
    return {
      platform: this.platform,
      budgetBytes: budget,
      reservedBytes: reserved,
      availableBytes: budget === null ? null : Math.max(0, budget - reserved),
      awaitingReleaseBytes: this.total("awaiting-collection"),
      debtBytes: this.total("debt"),
      measurementError: this.measurementError,
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
  private capacity(requested: number): void {
    if (this.platform.kind !== "bounded") return;
    if (this.pending)
      throw new SharedMemoryAdmissionError({
        kind: "platform",
        label: "measurement pending",
        cause: new RangeError("await reservations.settled()"),
      });
    const available = Math.max(0, this.platform.budgetBytes - this.total());
    if (requested <= available) return;
    throw new SharedMemoryAdmissionError({
      kind: "budget",
      requested: bytes(requested),
      available: bytes(available),
      budget: this.platform.budgetBytes,
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
      receipts: value ? 1 : 0,
      ...(memory ? { memory: new WeakRef(memory) } : {}),
      ...(value ? { value: new WeakRef(value) } : {}),
    };
    this.holders.set(holder.id, holder);
    if (value) {
      this.values.set(value, holder);
      this.finalizer.register(memory ?? value, holder.id);
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
    shape: BufferShape | GroupMemoryShape,
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
    try {
      const value = create();
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
      this.holders.delete(provisional.id);
      if (!(error instanceof RangeError)) throw error;
      this.scheduleRemeasure();
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
        holder.receipts++;
        this.finalizer.register(backing.memory.buffer, holder.id);
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
    if (plan.guest.kind === "undeclared" && this.platform.kind === "bounded")
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
    this.validatePlan(sizing, plan);
    const amount = guestBytes(this.platform, plan.guest);
    const guest =
      plan.guest.kind === "declared"
        ? this.record(
            runtime,
            "guest-memory",
            { kind: "guest", memories: plan.guest.memories },
            amount,
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
        phase = "settled";
        release();
        if (guest) this.holders.delete(guest.id);
        control.stopped();
      },
      failed: () => {
        if (phase !== "launched") return;
        phase = "settled";
        release();
        if (guest) guest.state = "debt";
        control.failed();
      },
    };
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
      },
      launched: () => {
        if (phase === "admitted") {
          phase = "launched";
          release();
        }
        return launched;
      },
    };
  }
  private controlCharge(length: number): number {
    return this.platform.kind === "bounded" &&
      !this.platform.counts.fixedBuffer &&
      !this.platform.counts.privateMemory
      ? 0
      : length;
  }
  private controlGrant(runtime: symbol, enabled: boolean) {
    if (!enabled || this.platform.kind === "unbounded")
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
  private disposeRuntime(runtime: symbol): void {
    for (const holder of this.holders.values()) {
      if (holder.runtime !== runtime || holder.state === "debt") continue;
      holder.state = holder.scope === "worker" ? "debt" : "awaiting-collection";
    }
  }
  private scheduleRemeasure(): void {
    if (this.platform.kind !== "bounded" || this.pending) return;
    const previous = this.platform;
    // The probe sees remaining capacity, not page-owned backing already constructed.
    // Do not add unconstructed headroom or speculative guest declarations to that receipt.
    let constructed = 0;
    for (const holder of this.holders.values()) {
      if (holder.value?.deref() || holder.memory?.deref()) constructed += holder.chargedBytes;
    }
    this.pending = Promise.resolve()
      .then(this.remeasure)
      .then(
        (platform) => {
          this.platform =
            platform.kind === "bounded"
              ? {
                  ...platform,
                  budgetBytes: bytes(
                    Math.min(previous.budgetBytes, platform.budgetBytes + constructed),
                  ),
                }
              : previous;
          this.measurementError = null;
        },
        (error: unknown) => {
          this.measurementError = error instanceof Error ? error.message : String(error);
        },
      )
      .finally(() => {
        this.pending = undefined;
      });
  }
}
function validatePlatform(platform: SharedMemoryPlatform): void {
  if (!platform || (platform.source !== "declared" && platform.source !== "measured"))
    throw new TypeError("Measure or explicitly declare shared memory before creating a runtime");
  if (platform.kind === "unbounded") {
    bytes(platform.probedBytes);
    return;
  }
  bytes(platform.budgetBytes);
  if (
    typeof platform.counts.fixedBuffer !== "boolean" ||
    typeof platform.counts.sharedMemory !== "boolean" ||
    typeof platform.counts.privateMemory !== "boolean"
  )
    throw new TypeError("Invalid shared-memory counted kinds");
}
export function declareSharedMemoryPlatform(input: PlatformInput): SharedMemoryPlatform {
  const platform: SharedMemoryPlatform =
    input.kind === "unbounded"
      ? { kind: "unbounded", source: "declared", probedBytes: bytes(PROBE_CEILING_BYTES) }
      : { ...input, source: "declared", counts: Object.freeze({ ...input.counts }) };
  validatePlatform(platform);
  return Object.freeze(platform);
}
const pageLedgerKey = Symbol.for("waffle.shared-memory.ledger");
const host = globalThis as typeof globalThis & { [pageLedgerKey]?: SharedMemoryLedger };
export function pageSharedMemoryLedger(platform: SharedMemoryPlatform): SharedMemoryLedger {
  validatePlatform(platform);
  return (host[pageLedgerKey] ??= new SharedMemoryLedger(platform));
}
export interface ProbeResult {
  readonly growableBytes: number;
  readonly ceilingReached: boolean;
  readonly counts: {
    readonly "fixed-buffer": boolean;
    readonly "shared-memory": boolean;
    readonly "private-memory": boolean;
  };
}
export interface SharedMemoryMeasureOptions {
  readonly workerURL?: string | URL;
  readonly remeasure?: true;
}
let measurement: Promise<SharedMemoryPlatform> | undefined;
export function measureSharedMemory(
  options: SharedMemoryMeasureOptions = {},
): Promise<SharedMemoryPlatform> {
  if (!options.remeasure && measurement) return measurement;
  const pending = runProbeWorker(options.workerURL).then((result): SharedMemoryPlatform => {
    if (result.ceilingReached)
      return { kind: "unbounded", source: "measured", probedBytes: bytes(result.growableBytes) };
    return {
      kind: "bounded",
      source: "measured",
      budgetBytes: bytes(Math.max(0, result.growableBytes - PROBE_SAFETY_MARGIN_BYTES)),
      counts: {
        fixedBuffer: result.counts["fixed-buffer"],
        sharedMemory: result.counts["shared-memory"],
        privateMemory: result.counts["private-memory"],
      },
    };
  });
  if (!options.remeasure) measurement = pending;
  return pending;
}
function parseProbeResult(value: unknown): ProbeResult {
  if (
    !value ||
    typeof value !== "object" ||
    !("growableBytes" in value) ||
    !("ceilingReached" in value) ||
    !("counts" in value)
  )
    throw new TypeError("Invalid shared-memory measurement");
  const counts = value.counts;
  if (
    typeof value.growableBytes !== "number" ||
    !Number.isSafeInteger(value.growableBytes) ||
    value.growableBytes < 0 ||
    typeof value.ceilingReached !== "boolean"
  )
    throw new TypeError("Invalid shared-memory probe capacity");
  if (
    !counts ||
    typeof counts !== "object" ||
    !("fixed-buffer" in counts) ||
    !("shared-memory" in counts) ||
    !("private-memory" in counts)
  )
    throw new TypeError("Unknown shared-memory counted kinds");
  if (
    typeof counts["fixed-buffer"] !== "boolean" ||
    typeof counts["shared-memory"] !== "boolean" ||
    typeof counts["private-memory"] !== "boolean"
  )
    throw new TypeError("Unknown shared-memory counted kinds");
  return {
    growableBytes: value.growableBytes,
    ceilingReached: value.ceilingReached,
    counts: {
      "fixed-buffer": counts["fixed-buffer"],
      "shared-memory": counts["shared-memory"],
      "private-memory": counts["private-memory"],
    },
  };
}
async function runProbeWorker(workerURL?: string | URL): Promise<ProbeResult> {
  if (typeof Worker !== "function") throw new Error("Shared memory measurement requires Worker");
  const worker = new Worker(workerURL ?? new URL("./probe-worker.js", import.meta.url), {
    type: "module",
  });
  try {
    return await new Promise<ProbeResult>((resolve, reject) => {
      worker.onmessage = (event) => {
        try {
          resolve(parseProbeResult(event.data));
        } catch (error) {
          reject(error);
        }
      };
      worker.onerror = (event) => reject(new Error(event.message || "Shared memory probe failed"));
      worker.postMessage({ ceilingBytes: PROBE_CEILING_BYTES });
    });
  } finally {
    await worker.terminate();
  }
}
