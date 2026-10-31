import { ProcessErrno } from "../proc/types";

const reservedBytesBrand: unique symbol = Symbol("waffle.reserved-bytes");
const wasmPagesBrand: unique symbol = Symbol("waffle.wasm-pages");
const runtimeTokenBrand: unique symbol = Symbol("waffle.runtime-token");

/** Bytes reserved by an engine at construction, not bytes currently touched. */
export type ReservedBytes = number & { readonly [reservedBytesBrand]: true };
/** WebAssembly pages used to describe a declared memory reservation. */
export type WasmPages = number & { readonly [wasmPagesBrand]: true };

export const PAGE_BYTES = 64 * 1024;
export const DESKTOP_ARENA_BYTES = 2_147_479_552;
export const BOUNDED_ARENA_BYTES = 64 * 1024 * 1024;
export const DESKTOP_PIPE_REGISTRY_CELLS = 1 << 24;
export const BOUNDED_PIPE_REGISTRY_CELLS = 1 << 20;
export const DESKTOP_GROUP_MAXIMUM_PAGES = 65_536;
export const BOUNDED_GROUP_MAXIMUM_PAGES = 16_384;
export const PROBE_CEILING_BYTES = 16 * 1024 * 1024 * 1024;
export const PROBE_SAFETY_MARGIN_BYTES = 256 * 1024 * 1024;

function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

export function bytes(value: number): ReservedBytes {
  return integer(value, "bytes") as ReservedBytes;
}

export function pages(value: number): WasmPages {
  return integer(value, "pages") as WasmPages;
}

export type ReservationKind = "growable-buffer" | "fixed-buffer" | "shared-memory" | "private-memory";

export type SharedMemoryPlatform =
  | { readonly kind: "unbounded"; readonly probedBytes: ReservedBytes }
  | {
      readonly kind: "bounded";
      readonly budgetBytes: ReservedBytes;
      readonly counts: Readonly<Record<Exclude<ReservationKind, "growable-buffer">, boolean>>;
    };

type LedgerPlatform = { readonly kind: "measuring"; settled?: Promise<SharedMemoryPlatform> } | SharedMemoryPlatform;

export type ReservationShape =
  | { readonly kind: "growable-buffer"; readonly maximum: ReservedBytes }
  | { readonly kind: "fixed-buffer"; readonly length: ReservedBytes }
  | { readonly kind: "shared-memory"; readonly growth: "fixed"; readonly pages: WasmPages }
  | { readonly kind: "shared-memory"; readonly growth: "growable"; readonly maximumPages: WasmPages }
  | { readonly kind: "private-memory"; readonly maximumPages: WasmPages };

export interface MemoryGroupHandle {
  readonly kind: "memory-group";
  readonly id: symbol;
}

export type AgentCount = 1 | "many";

export type GuestReservation =
  | { readonly memory: "none" }
  | { readonly memory: "private"; readonly maximumPages: WasmPages }
  | { readonly memory: "shared"; readonly growth: "fixed"; readonly pages: WasmPages; readonly agents: AgentCount }
  | { readonly memory: "shared"; readonly growth: "growable"; readonly maximumPages: WasmPages; readonly agents: AgentCount }
  | { readonly memory: "group"; readonly join: "new" | "inherit" | MemoryGroupHandle };

export type GroupMemoryPlan =
  | { readonly kind: "growable"; readonly maximumPages: WasmPages }
  | { readonly kind: "fixed"; readonly pages: WasmPages };

export type RuntimeToken = { readonly [runtimeTokenBrand]: true; readonly id: symbol };

export type HolderLabel =
  | "filesystem-root"
  | "filesystem-segment"
  | "fs-worker-root"
  | "request-arena"
  | "pipe-registry"
  | "workspace-publication"
  | "memory-group"
  | "guest-memory";

type HolderScope =
  | { readonly kind: "runtime"; readonly runtime: RuntimeToken }
  | { readonly kind: "pooled"; readonly pool: "request-arena" | "group-memory" }
  | { readonly kind: "worker"; readonly pid: number; readonly incarnation: symbol };

type HolderState =
  | { readonly kind: "live" }
  | { readonly kind: "idle" }
  | { readonly kind: "awaiting-collection" }
  | { readonly kind: "debt"; readonly error: unknown };

interface HolderRecord {
  readonly id: number;
  readonly label: HolderLabel;
  readonly shape: ReservationShape;
  readonly scope: HolderScope;
  state: HolderState;
  readonly declaredBytes: number;
  readonly chargedBytes: number;
  readonly value?: SharedArrayBuffer | WebAssembly.Memory;
}

export interface SharedMemorySnapshot {
  readonly platform: SharedMemoryPlatform | { readonly kind: "measuring" };
  readonly budgetBytes: number | null;
  readonly reservedBytes: number;
  readonly availableBytes: number | null;
  readonly awaitingReleaseBytes: number;
  readonly holders: readonly {
    readonly label: HolderLabel;
    readonly shape: ReservationShape;
    readonly scope: HolderScope["kind"];
    readonly state: HolderState["kind"];
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
  | { readonly kind: "configuration"; readonly configuration: "growable-shared-memory-with-many-agents" }
  | { readonly kind: "platform"; readonly shape: ReservationShape; readonly cause: RangeError };

export class SharedMemoryAdmissionError extends Error {
  readonly name = "SharedMemoryAdmissionError";
  readonly errno = ProcessErrno.NOMEM;
  readonly code = "ENOMEM";
  constructor(readonly refusal: SharedMemoryRefusal) {
    super(describeRefusal(refusal));
  }
}

function describeRefusal(refusal: SharedMemoryRefusal): string {
  if (refusal.kind === "configuration") return "Growable shared memory with many agents is not supported on this bounded platform";
  if (refusal.kind === "platform") return `Shared memory platform refused ${refusal.shape.kind}: ${refusal.cause.message}`;
  return `Shared memory budget refused ${refusal.requested} bytes: ${refusal.available} available of ${refusal.budget}; ${refusal.awaitingRelease} awaiting release`;
}

export interface ReservationAllocator {
  createBuffer(shape: ReservationShape): SharedArrayBuffer;
  createMemory(shape: Extract<ReservationShape, { readonly kind: "shared-memory" | "private-memory" }>): WebAssembly.Memory;
}

const defaultAllocator: ReservationAllocator = {
  createBuffer(shape) {
    if (shape.kind === "fixed-buffer") return new SharedArrayBuffer(shape.length);
    if (shape.kind !== "growable-buffer") throw new TypeError(`buffer allocator cannot create ${shape.kind}`);
    const value = Reflect.construct(SharedArrayBuffer, [0, { maxByteLength: shape.maximum }]);
    if (!(value instanceof SharedArrayBuffer)) throw new TypeError("shared buffer constructor returned an invalid value");
    return value;
  },
  createMemory(shape) {
    if (shape.kind === "private-memory") return new WebAssembly.Memory({ initial: 0, maximum: shape.maximumPages });
    const maximum = shape.growth === "fixed" ? shape.pages : shape.maximumPages;
    const initial = shape.growth === "fixed" ? shape.pages : 0;
    return new WebAssembly.Memory({ initial, maximum, shared: true });
  },
};

export interface ProcessPlan {
  readonly pid: number;
  readonly executable: string;
  readonly guest: GuestReservation;
  /** Current extracted Waffle has no request-arena connection allocator; callers use zero. */
  readonly connections: number;
}

export interface PreLaunchAdmission {
  readonly arena: SharedArrayBuffer | undefined;
  readonly groupMemory: WebAssembly.Memory | undefined;
  abort(): void;
  launched(): LaunchedAdmission;
}

export interface LaunchedAdmission {
  stopped(): void;
  failed(error: unknown): void;
}

export interface SharedMemoryLedger {
  runtimeToken(): RuntimeToken;
  reserveBuffer(label: HolderLabel, shape: ReservationShape, runtime: RuntimeToken): SharedArrayBuffer;
  reserveMemory(label: "memory-group", shape: Extract<ReservationShape, { readonly kind: "shared-memory" | "private-memory" }>, runtime?: RuntimeToken): WebAssembly.Memory;
  releaseGroupMemory(memory: WebAssembly.Memory, error?: unknown): void;
  arena(runtime: RuntimeToken): SharedArrayBuffer;
  releaseArena(arena: SharedArrayBuffer, error?: unknown): void;
  groupMemory(maximumPages?: WasmPages): GroupMemoryPlan;
  pipeRegistryCells(): number;
  check(reservation: GuestReservation): { readonly kind: "admitted" } | { readonly kind: "refused"; readonly error: SharedMemoryAdmissionError };
  admit(plan: ProcessPlan): PreLaunchAdmission;
  measured(): Promise<SharedMemoryPlatform>;
  disposeRuntime(runtime: RuntimeToken): void;
  collectRuntime(runtime: RuntimeToken): void;
  snapshot(): SharedMemorySnapshot;
}

interface LedgerOptions {
  readonly platform?: SharedMemoryPlatform;
  readonly measure?: () => Promise<SharedMemoryPlatform>;
  readonly allocator?: ReservationAllocator;
}

function shapeBytes(shape: ReservationShape): number {
  switch (shape.kind) {
    case "growable-buffer": return shape.maximum;
    case "fixed-buffer": return shape.length;
    case "shared-memory": return (shape.growth === "fixed" ? shape.pages : shape.maximumPages) * PAGE_BYTES;
    case "private-memory": return shape.maximumPages * PAGE_BYTES;
  }
}

function shapeKind(shape: ReservationShape): ReservationKind {
  return shape.kind;
}

function shapeForGuest(reservation: GuestReservation, group: GroupMemoryPlan): ReservationShape | undefined {
  switch (reservation.memory) {
    case "none": return undefined;
    case "private": return { kind: "private-memory", maximumPages: reservation.maximumPages };
    case "shared":
      return reservation.growth === "fixed"
        ? { kind: "shared-memory", growth: "fixed", pages: reservation.pages }
        : { kind: "shared-memory", growth: "growable", maximumPages: reservation.maximumPages };
    case "group":
      return group.kind === "fixed"
        ? { kind: "shared-memory", growth: "fixed", pages: group.pages }
        : { kind: "shared-memory", growth: "growable", maximumPages: group.maximumPages };
  }
}

function countsKind(platform: SharedMemoryPlatform | undefined, kind: ReservationKind): boolean {
  if (!platform || platform.kind === "unbounded") return true;
  if (kind === "growable-buffer") return true;
  return platform.counts[kind];
}

function isBounded(platform: LedgerPlatform): platform is Extract<SharedMemoryPlatform, { readonly kind: "bounded" }> {
  return platform.kind === "bounded";
}

function isGrowableSharedWithManyAgents(reservation: GuestReservation): boolean {
  return reservation.memory === "shared" && reservation.growth === "growable" && reservation.agents === "many";
}

function initialPlatform(): LedgerPlatform {
  return { kind: "measuring" };
}

class Ledger implements SharedMemoryLedger {
  private platform: LedgerPlatform;
  private nextHolder = 1;
  private readonly holders = new Map<number, HolderRecord>();
  private readonly idleArenas = new Map<number, HolderRecord[]>();
  private readonly idleGroups = new Map<number, HolderRecord[]>();
  private readonly allocator: ReservationAllocator;
  private readonly measure: () => Promise<SharedMemoryPlatform>;
  private remeasure?: Promise<SharedMemoryPlatform>;

  constructor(options: LedgerOptions = {}) {
    this.allocator = options.allocator ?? defaultAllocator;
    this.measure = options.measure ?? measureSharedMemory;
    this.platform = options.platform ?? initialPlatform();
  }

  runtimeToken(): RuntimeToken {
    return { [runtimeTokenBrand]: true, id: Symbol("waffle.runtime") };
  }

  reserveBuffer(label: HolderLabel, shape: ReservationShape, runtime: RuntimeToken): SharedArrayBuffer {
    const record = this.reserveValue(label, shape, { kind: "runtime", runtime }, () => this.allocator.createBuffer(shape));
    if (!(record.value instanceof SharedArrayBuffer)) throw new TypeError("buffer allocator returned an invalid value");
    return record.value;
  }

  reserveMemory(label: "memory-group", shape: Extract<ReservationShape, { readonly kind: "shared-memory" | "private-memory" }>, runtime?: RuntimeToken): WebAssembly.Memory {
    if (!runtime) {
      const reusable = this.idleGroups.get(shapeBytes(shape))?.pop();
      if (reusable) {
        reusable.state = { kind: "live" };
        if (!(reusable.value instanceof WebAssembly.Memory)) throw new TypeError("group pool contains a non-memory value");
        return reusable.value;
      }
    }
    const scope = runtime ? { kind: "runtime" as const, runtime } : { kind: "pooled" as const, pool: "group-memory" as const };
    const record = this.reserveValue(label, shape, scope, () => this.allocator.createMemory(shape));
    if (!(record.value instanceof WebAssembly.Memory)) throw new TypeError("memory allocator returned an invalid value");
    return record.value;
  }

  releaseGroupMemory(memory: WebAssembly.Memory, error?: unknown): void {
    const record = this.findValue(memory);
    if (!record) return;
    if (error) {
      record.state = { kind: "debt", error };
      return;
    }
    record.state = { kind: "idle" };
    const list = this.idleGroups.get(record.declaredBytes) ?? [];
    list.push(record);
    this.idleGroups.set(record.declaredBytes, list);
  }

  arena(runtime: RuntimeToken): SharedArrayBuffer {
    const declared = this.arenaBytes();
    const pool = this.idleArenas.get(declared);
    const reusable = pool?.pop();
    if (reusable) {
      reusable.state = { kind: "live" };
      if (!(reusable.value instanceof SharedArrayBuffer)) throw new TypeError("arena pool contains a non-buffer value");
      return reusable.value;
    }
    const shape: ReservationShape = { kind: "growable-buffer", maximum: bytes(declared) };
    const record = this.reserveValue("request-arena", shape, { kind: "pooled", pool: "request-arena" }, () => this.allocator.createBuffer(shape));
    if (!(record.value instanceof SharedArrayBuffer)) throw new TypeError("arena allocator returned an invalid value");
    return record.value;
  }

  releaseArena(arena: SharedArrayBuffer, error?: unknown): void {
    const record = this.findValue(arena);
    if (!record) return;
    if (error) {
      record.state = { kind: "debt", error };
      return;
    }
    record.state = { kind: "idle" };
    const list = this.idleArenas.get(record.declaredBytes) ?? [];
    list.push(record);
    this.idleArenas.set(record.declaredBytes, list);
  }

  groupMemory(maximumPages?: WasmPages): GroupMemoryPlan {
    const pagesValue = maximumPages ?? pages(isBounded(this.platform) ? BOUNDED_GROUP_MAXIMUM_PAGES : DESKTOP_GROUP_MAXIMUM_PAGES);
    return isBounded(this.platform) ? { kind: "fixed", pages: pagesValue } : { kind: "growable", maximumPages: pagesValue };
  }

  pipeRegistryCells(): number {
    return isBounded(this.platform) ? BOUNDED_PIPE_REGISTRY_CELLS : DESKTOP_PIPE_REGISTRY_CELLS;
  }

  check(reservation: GuestReservation): { readonly kind: "admitted" } | { readonly kind: "refused"; readonly error: SharedMemoryAdmissionError } {
    const error = this.refusalFor(reservation, 0);
    return error ? { kind: "refused", error } : { kind: "admitted" };
  }

  admit(plan: ProcessPlan): PreLaunchAdmission {
    if (this.platform.kind === "measuring") void this.measured().catch(() => {});
    const group = this.groupMemory();
    const refusal = this.refusalFor(plan.guest, plan.connections * this.arenaBytes(), group);
    if (refusal) throw refusal;
    const records: HolderRecord[] = [];
    let arena: SharedArrayBuffer | undefined;
    let groupMemory: WebAssembly.Memory | undefined;
    try {
      const guestShape = plan.guest.memory === "group" ? undefined : shapeForGuest(plan.guest, group);
      if (guestShape) {
        const scope = { kind: "worker" as const, pid: plan.pid, incarnation: Symbol(`waffle.worker.${plan.pid}`) };
        const value = this.allocateShape("guest-memory", guestShape, scope);
        records.push(value.record);
      }
      if (plan.connections > 0) {
        arena = this.arena(this.runtimeToken());
        const arenaRecord = this.findValue(arena);
        if (arenaRecord) records.push(arenaRecord);
      }
      if (plan.guest.memory === "group" && plan.guest.join === "new") {
        const shape = shapeForGuest(plan.guest, group);
        if (shape && (shape.kind === "shared-memory" || shape.kind === "private-memory")) {
          groupMemory = this.reserveMemory("memory-group", shape);
          const groupRecord = this.findValue(groupMemory);
          if (!groupRecord) throw new TypeError("group reservation was not recorded");
          records.push(groupRecord);
        }
      }
    } catch (error) {
      this.rollback(records);
      if (error instanceof SharedMemoryAdmissionError) throw error;
      const shape = shapeForGuest(plan.guest, group) ?? { kind: "growable-buffer" as const, maximum: bytes(this.arenaBytes()) };
      const cause = error instanceof RangeError ? error : new RangeError(String(error));
      this.scheduleRemeasure();
      throw new SharedMemoryAdmissionError({ kind: "platform", shape, cause });
    }
    return this.ticket(records, arena, groupMemory);
  }

  measured(): Promise<SharedMemoryPlatform> {
    if (this.platform.kind !== "measuring") return Promise.resolve(this.platform);
    const pending = this.platform.settled ??= this.measure();
    return pending.then(platform => { this.platform = platform; return platform; });
  }

  disposeRuntime(runtime: RuntimeToken): void {
    for (const record of this.holders.values()) {
      if (record.scope.kind !== "runtime" || record.scope.runtime !== runtime) continue;
      if (record.state.kind !== "live") continue;
      record.state = { kind: "awaiting-collection" };
    }
  }

  collectRuntime(runtime: RuntimeToken): void {
    for (const [id, record] of this.holders) {
      if (record.scope.kind !== "runtime" || record.scope.runtime !== runtime) continue;
      if (record.state.kind !== "awaiting-collection") continue;
      this.holders.delete(id);
    }
  }

  snapshot(): SharedMemorySnapshot {
    const platform = this.platform.kind === "measuring" ? { kind: "measuring" as const } : this.platform;
    const budget = platform.kind === "bounded" ? platform.budgetBytes : null;
    const reservedBytes = this.sumCharged();
    const awaitingReleaseBytes = this.sumState("awaiting-collection");
    const availableBytes = budget === null ? null : Math.max(0, budget - reservedBytes);
    return {
      platform,
      budgetBytes: budget,
      reservedBytes,
      availableBytes,
      awaitingReleaseBytes,
      holders: Array.from(this.holders.values(), record => ({
        label: record.label,
        shape: record.shape,
        scope: record.scope.kind,
        state: record.state.kind,
        declaredBytes: record.declaredBytes,
        grownBytes: record.value instanceof SharedArrayBuffer ? record.value.byteLength : null,
      })),
    };
  }

  private arenaBytes(): number {
    return isBounded(this.platform) ? BOUNDED_ARENA_BYTES : DESKTOP_ARENA_BYTES;
  }

  private refusalFor(reservation: GuestReservation, extraBytes: number, group = this.groupMemory()): SharedMemoryAdmissionError | undefined {
    if (isBounded(this.platform) && isGrowableSharedWithManyAgents(reservation)) {
      return new SharedMemoryAdmissionError({ kind: "configuration", configuration: "growable-shared-memory-with-many-agents" });
    }
    const shape = shapeForGuest(reservation, group);
    const arenaBytes = this.reusableArenaBytes(extraBytes);
    const memoryBytes = shape ? this.reusableMemoryBytes(reservation, shape) : 0;
    const requested = arenaBytes + memoryBytes;
    const budget = this.platform.kind === "bounded" ? this.platform.budgetBytes : undefined;
    if (budget === undefined) return undefined;
    const available = Math.max(0, budget - this.sumCharged());
    if (requested <= available) return undefined;
    return new SharedMemoryAdmissionError({ kind: "budget", requested: bytes(requested), available: bytes(available), budget, awaitingRelease: bytes(this.sumState("awaiting-collection")) });
  }

  private reusableArenaBytes(requested: number): number {
    if (!requested) return 0;
    const slots = this.idleArenas.get(this.arenaBytes())?.length ?? 0;
    const connections = Math.ceil(requested / this.arenaBytes());
    return Math.max(0, connections - slots) * this.arenaBytes();
  }

  private reusableMemoryBytes(reservation: GuestReservation, shape: ReservationShape): number {
    if (reservation.memory !== "group" || reservation.join !== "new") return countsKind(this.platform.kind === "measuring" ? undefined : this.platform, shapeKind(shape)) ? shapeBytes(shape) : 0;
    const reusable = this.idleGroups.get(shapeBytes(shape))?.length ?? 0;
    return reusable ? 0 : countsKind(this.platform.kind === "measuring" ? undefined : this.platform, shapeKind(shape)) ? shapeBytes(shape) : 0;
  }

  private reserveValue(label: HolderLabel, shape: ReservationShape, scope: HolderScope, create: () => SharedArrayBuffer | WebAssembly.Memory): HolderRecord {
    const { record, value } = this.allocateShape(label, shape, scope, create);
    if (value !== record.value) throw new TypeError("reservation allocator changed its value");
    return record;
  }

  private allocateShape(label: HolderLabel, shape: ReservationShape, scope: HolderScope, create?: () => SharedArrayBuffer | WebAssembly.Memory): { readonly record: HolderRecord; readonly value: SharedArrayBuffer | WebAssembly.Memory } {
    const chargedBytes = countsKind(this.platform.kind === "measuring" ? undefined : this.platform, shapeKind(shape)) ? shapeBytes(shape) : 0;
    this.ensureCapacity(chargedBytes, 0);
    const value = create?.() ?? (shape.kind === "growable-buffer" || shape.kind === "fixed-buffer"
      ? this.allocator.createBuffer(shape)
      : this.allocator.createMemory(shape));
    const record: HolderRecord = { id: this.nextHolder++, label, shape, scope, state: { kind: "live" }, declaredBytes: shapeBytes(shape), chargedBytes, value };
    this.holders.set(record.id, record);
    return { record, value };
  }

  private ensureCapacity(requested: number, awaitingRelease: number): void {
    if (this.platform.kind !== "bounded") return;
    const available = Math.max(0, this.platform.budgetBytes - this.sumCharged());
    if (requested > available) throw new SharedMemoryAdmissionError({ kind: "budget", requested: bytes(requested), available: bytes(available), budget: this.platform.budgetBytes, awaitingRelease: bytes(awaitingRelease || this.sumState("awaiting-collection")) });
  }

  private ticket(records: readonly HolderRecord[], arena: SharedArrayBuffer | undefined, groupMemory: WebAssembly.Memory | undefined): PreLaunchAdmission {
    let phase: "admitted" | "launched" | "aborted" | "stopped" | "failed" = "admitted";
    const release = (error?: unknown) => {
      if (phase === "aborted" || phase === "stopped" || phase === "failed") return;
      if (error) {
        for (const record of records) record.state = { kind: "debt", error };
        phase = "failed";
        return;
      }
      for (const record of records) this.holders.delete(record.id);
      phase = "aborted";
    };
    const launched: LaunchedAdmission = {
      stopped: () => {
        if (phase !== "launched") return;
        for (const record of records) {
          if (record.label === "request-arena" && record.value instanceof SharedArrayBuffer) this.releaseArena(record.value);
          else if (record.label === "memory-group" && record.value instanceof WebAssembly.Memory) this.releaseGroupMemory(record.value);
          else this.holders.delete(record.id);
        }
        phase = "stopped";
      },
      failed: error => release(error),
    };
    return {
      arena,
      groupMemory,
      abort: () => release(),
      launched: () => {
        if (phase !== "admitted") return launched;
        phase = "launched";
        return launched;
      },
    };
  }

  private rollback(records: readonly HolderRecord[]): void {
    for (const record of records) this.holders.delete(record.id);
  }

  private findValue(value: SharedArrayBuffer | WebAssembly.Memory): HolderRecord | undefined {
    for (const record of this.holders.values()) if (record.value === value) return record;
    return undefined;
  }

  private sumCharged(): number {
    let total = 0;
    for (const record of this.holders.values()) total += record.chargedBytes;
    return total;
  }

  private sumState(state: HolderState["kind"]): number {
    let total = 0;
    for (const record of this.holders.values()) if (record.state.kind === state) total += record.chargedBytes;
    return total;
  }

  private scheduleRemeasure(): void {
    if (this.platform.kind !== "bounded" || this.remeasure) return;
    this.remeasure = this.measure().then(platform => { this.platform = platform; this.remeasure = undefined; return platform; }, () => { this.remeasure = undefined; return this.platform.kind === "bounded" ? this.platform : { kind: "unbounded", probedBytes: bytes(PROBE_CEILING_BYTES) }; });
  }
}

export function createSharedMemoryLedger(options: LedgerOptions = {}): SharedMemoryLedger {
  return new Ledger(options);
}

const pageLedgerKey = Symbol.for("waffle.shared-memory.ledger");
type PageLedgerHost = typeof globalThis & { [pageLedgerKey]?: SharedMemoryLedger };

export function pageSharedMemoryLedger(platform?: SharedMemoryPlatform): SharedMemoryLedger {
  const host = globalThis as PageLedgerHost;
  return host[pageLedgerKey] ??= createSharedMemoryLedger(platform ? { platform } : undefined);
}

export interface ProbeResult {
  readonly growableBytes: number;
  readonly ceilingReached: boolean;
  readonly counts: Readonly<Record<Exclude<ReservationKind, "growable-buffer">, boolean>>;
}

export interface SharedMemoryMeasureOptions {
  readonly workerURL?: string | URL;
  readonly probe?: () => Promise<ProbeResult>;
}

function parseProbeResult(value: unknown): ProbeResult {
  if (!value || typeof value !== "object") throw new TypeError("shared memory probe returned invalid data");
  const result = value as { growableBytes?: unknown; ceilingReached?: unknown; counts?: unknown };
  if (typeof result.growableBytes !== "number" || !Number.isSafeInteger(result.growableBytes) || typeof result.ceilingReached !== "boolean" || !result.counts || typeof result.counts !== "object") throw new TypeError("shared memory probe returned invalid data");
  const counts = result.counts as Record<string, unknown>;
  if (typeof counts["fixed-buffer"] !== "boolean" || typeof counts["shared-memory"] !== "boolean" || typeof counts["private-memory"] !== "boolean") throw new TypeError("shared memory probe returned invalid counts");
  return {
    growableBytes: result.growableBytes,
    ceilingReached: result.ceilingReached,
    counts: { "fixed-buffer": counts["fixed-buffer"], "shared-memory": counts["shared-memory"], "private-memory": counts["private-memory"] },
  };
}

export async function measureSharedMemory(options: SharedMemoryMeasureOptions = {}): Promise<SharedMemoryPlatform> {
  const probe = options.probe ?? (() => runProbeWorker(options.workerURL));
  const result = parseProbeResult(await probe());
  if (result.ceilingReached || result.growableBytes >= PROBE_CEILING_BYTES) return { kind: "unbounded", probedBytes: bytes(result.growableBytes) };
  return {
    kind: "bounded",
    budgetBytes: bytes(Math.max(0, result.growableBytes - PROBE_SAFETY_MARGIN_BYTES)),
    counts: result.counts,
  };
}

async function runProbeWorker(workerURL?: string | URL): Promise<ProbeResult> {
  if (typeof Worker !== "function") throw new Error("Shared memory measurement requires Worker");
  const worker = new Worker(workerURL ?? new URL("./probe-worker.js", import.meta.url), { type: "module" });
  return new Promise<ProbeResult>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      try { worker.terminate(); } catch {}
      action();
    };
    worker.onmessage = event => finish(() => {
      try { resolve(parseProbeResult(event.data)); }
      catch (error) { reject(error); }
    });
    worker.onerror = event => finish(() => reject(new Error(event.message || "shared memory probe failed")));
    try { worker.postMessage({ ceilingBytes: PROBE_CEILING_BYTES }); }
    catch (error) { finish(() => reject(error)); }
  });
}
