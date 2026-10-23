/** Internal, realm-local allocation authority. No runtime producer uses this candidate yet. */
export interface MemoryCharge {
  readonly backingBytes: number;
  readonly metadataUnits: number;
  readonly nativeAllowance: number;
}
export interface MemoryRecords {
  readonly allocations: number;
  readonly references: number;
  readonly leases: number;
}
export interface MemoryPlan extends MemoryRecords {
  readonly bytes: number;
}
export interface MemoryBudgetLimits {
  readonly bytes: number;
  readonly producers: MemoryRecords;
  readonly progress: MemoryPlan;
  readonly waiters: number;
  readonly serialLimit: number;
}
export type MemoryBackingSpec =
  | { readonly kind: "array"; readonly bytes: number }
  | { readonly kind: "shared"; readonly bytes: number; readonly maximum: number };

/** Trusted instrumentation only. Methods must return fresh backing, not retain failed results, and not grow past the request. */
export interface MemoryAllocator {
  allocate(spec: MemoryBackingSpec): ArrayBuffer | SharedArrayBuffer;
  grow(buffer: SharedArrayBuffer, bytes: number): void;
}
export interface MemoryLease {
  allocate(spec: MemoryBackingSpec): {
    readonly backing: MemoryBacking;
    readonly ref: MemoryReference;
  };
  account(charge: Omit<MemoryCharge, "backingBytes">): MemoryReference;
  grow(backing: MemoryBacking, ref: MemoryReference, bytes: number): void;
  retain(ref: MemoryReference): MemoryReference;
  release(ref: MemoryReference): boolean;
  delegate(plan: MemoryPlan): MemoryLease;
  close(): void;
}
export type MemoryAdmission =
  | { readonly kind: "granted"; readonly lease: MemoryLease }
  | { readonly kind: "pressure"; readonly changed: bigint }
  | { readonly kind: "impossible" }
  | { readonly kind: "exhausted" }
  | { readonly kind: "stopped" };

export class MemoryBudgetError extends Error {
  constructor(readonly code: "closed" | "capacity" | "records" | "serial" | "reference" | "busy") {
    super(`memory budget ${code}`);
  }
}

type PoolKind = "producer" | "progress";
type Location = { readonly pool: PoolKind; readonly slot: number; readonly serial: number };

class Reference {
  readonly #key: symbol;
  readonly #location: Location;
  constructor(
    readonly allocation: number,
    key: symbol,
    location: Location,
  ) {
    this.#key = key;
    this.#location = location;
    Object.freeze(this);
  }
  locate(key: symbol): Location | undefined {
    if (#key in this && key === this.#key) return this.#location;
  }
}
export type MemoryReference = Reference;

class Backing {
  readonly #key: symbol;
  readonly #location: Location;
  constructor(
    readonly buffer: ArrayBuffer | SharedArrayBuffer,
    key: symbol,
    location: Location,
  ) {
    this.#key = key;
    this.#location = location;
    Object.freeze(this);
  }
  locate(key: symbol): Location | undefined {
    if (#key in this && key === this.#key) return this.#location;
  }
}
export type MemoryBacking = Backing;
Object.freeze(Reference.prototype);
Object.freeze(Reference);
Object.freeze(Backing.prototype);
Object.freeze(Backing);
const referenceLocation = Reference.prototype.locate;
const backingLocation = Backing.prototype.locate;

const enum LeaseWord {
  Serial,
  Open,
  Bytes,
  Allocations,
  References,
  Leases,
  Held,
  Busy,
  Serials,
  Count,
}
const enum AllocationWord {
  Serial,
  Backing,
  Metadata,
  Native,
  References,
  Busy,
  Count,
}
const enum ReferenceWord {
  Serial,
  Allocation,
  Owner,
  Count,
}

// These are conservative declared units for bounded JS control records, not heap measurements.
const CONTROL_UNITS = 256;
const ALLOCATION_UNITS = 128;
const REFERENCE_UNITS = 128;
const LEASE_UNITS = 512;
const WAITER_UNITS = 256;
const MAX_RECORDS = 65_536;
const NativeArrayBuffer = ArrayBuffer;
const NativeSharedArrayBuffer = SharedArrayBuffer;
const arrayLength = Object.getOwnPropertyDescriptor(NativeArrayBuffer.prototype, "byteLength")?.get;
const sharedLength = Object.getOwnPropertyDescriptor(
  NativeSharedArrayBuffer.prototype,
  "byteLength",
)?.get;

function integer(value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new RangeError("memory budget requires nonnegative safe integers within its limits");
  return value;
}
function sum(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - total) throw new RangeError("memory budget sum overflow");
    total += value;
  }
  return total;
}
function records(value: MemoryRecords): MemoryRecords {
  return {
    allocations: integer(value.allocations, MAX_RECORDS),
    references: integer(value.references, MAX_RECORDS),
    leases: integer(value.leases, MAX_RECORDS),
  };
}
function plan(value: MemoryPlan): MemoryPlan {
  const bytes = integer(value.bytes);
  return { ...records(value), bytes };
}
function specification(value: MemoryBackingSpec): MemoryBackingSpec {
  const kind = value.kind;
  const bytes = integer(value.bytes);
  if (kind === "array") return Object.freeze({ kind, bytes });
  const maximum = integer(value.maximum);
  if (bytes > maximum) throw new RangeError("initial backing exceeds its maximum");
  return Object.freeze({ kind, bytes, maximum });
}
function length(buffer: ArrayBuffer | SharedArrayBuffer): number {
  const getter = buffer instanceof NativeSharedArrayBuffer ? sharedLength : arrayLength;
  if (!getter) throw new Error("missing native buffer byteLength getter");
  return Reflect.apply(getter, buffer, []);
}
const nativeAllocator: MemoryAllocator = {
  allocate(spec) {
    if (spec.kind === "array") return new NativeArrayBuffer(spec.bytes);
    const buffer: unknown = Reflect.construct(NativeSharedArrayBuffer, [
      spec.bytes,
      { maxByteLength: spec.maximum },
    ]);
    if (!(buffer instanceof NativeSharedArrayBuffer)) throw new TypeError("invalid shared backing");
    return buffer;
  },
  grow(buffer, bytes) {
    if (!("grow" in buffer) || typeof buffer.grow !== "function")
      throw new TypeError("growable SharedArrayBuffer required");
    buffer.grow(bytes);
  },
};

class Table {
  constructor(
    private readonly view: DataView,
    private readonly offset: number,
    readonly count: number,
    private readonly width: number,
  ) {}
  get(slot: number, word: number): number {
    return this.view.getFloat64(this.offset + (slot * this.width + word) * 8, true);
  }
  set(slot: number, word: number, value: number): void {
    this.view.setFloat64(this.offset + (slot * this.width + word) * 8, value, true);
  }
  add(slot: number, word: number, delta: number): void {
    this.set(slot, word, this.get(slot, word) + delta);
  }
  free(): number {
    for (let slot = 0; slot < this.count; slot++) if (this.get(slot, 0) === 0) return slot;
    throw new MemoryBudgetError("records");
  }
  clear(slot: number): void {
    for (let word = 0; word < this.width; word++) this.set(slot, word, 0);
  }
}
class Pool {
  readonly allocations: Table;
  readonly references: Table;
  readonly leases: Table;
  freeAllocations: number;
  freeReferences: number;
  freeLeases: number;
  escrow = 0;
  constructor(
    view: DataView,
    offset: number,
    readonly limits: MemoryRecords,
  ) {
    this.allocations = new Table(view, offset, limits.allocations, AllocationWord.Count);
    offset += limits.allocations * AllocationWord.Count * 8;
    this.references = new Table(view, offset, limits.references, ReferenceWord.Count);
    offset += limits.references * ReferenceWord.Count * 8;
    this.leases = new Table(view, offset, limits.leases, LeaseWord.Count);
    this.freeAllocations = limits.allocations;
    this.freeReferences = limits.references;
    this.freeLeases = limits.leases;
  }
}
function tableBytes(value: MemoryRecords): number {
  return (
    (value.allocations * AllocationWord.Count +
      value.references * ReferenceWord.Count +
      value.leases * LeaseWord.Count) *
    8
  );
}
function controlCharge(
  producer: MemoryRecords,
  progress: MemoryRecords,
  waiters: number,
): MemoryCharge {
  return {
    backingBytes: tableBytes(producer) + tableBytes(progress),
    metadataUnits:
      CONTROL_UNITS +
      (producer.allocations + progress.allocations) * ALLOCATION_UNITS +
      (producer.references + progress.references) * REFERENCE_UNITS +
      (producer.leases + progress.leases) * LEASE_UNITS +
      waiters * WAITER_UNITS,
    nativeAllowance: 0,
  };
}

type Waiter = {
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
};

export class MemoryBudget {
  readonly #key = Symbol("memory authority");
  readonly #producer: Pool;
  readonly #progress: Pool;
  readonly #waiters: (Waiter | null)[];
  readonly #allocator: MemoryAllocator;
  readonly #limit: number;
  readonly #serialLimit: number;
  readonly #producerLimit: number;
  readonly #progressLimit: number;
  #serial = 0;
  #serialReserved = 0;
  #backing: number;
  #metadata: number;
  #native = 0;
  #reserve: number;
  #changed = 0n;
  #stopped = false;

  constructor(limits: MemoryBudgetLimits, allocator: MemoryAllocator = nativeAllocator) {
    const bytes = integer(limits.bytes);
    const producer = records(limits.producers);
    const progress = plan(limits.progress);
    const waiters = integer(limits.waiters, MAX_RECORDS);
    const serialLimit = integer(limits.serialLimit);
    const control = controlCharge(producer, progress, waiters);
    if (sum(control.backingBytes, control.metadataUnits, progress.bytes) > bytes)
      throw new MemoryBudgetError("capacity");
    const view = new DataView(new NativeArrayBuffer(control.backingBytes));
    this.#producer = new Pool(view, 0, producer);
    this.#progress = new Pool(view, tableBytes(producer), progress);
    this.#waiters = Array.from({ length: waiters }, () => null);
    this.#allocator = {
      allocate: allocator.allocate.bind(allocator),
      grow: allocator.grow.bind(allocator),
    };
    this.#limit = bytes;
    this.#serialLimit = serialLimit;
    this.#producerLimit = bytes - control.backingBytes - control.metadataUnits - progress.bytes;
    this.#progressLimit = progress.bytes;
    this.#backing = control.backingBytes;
    this.#metadata = control.metadataUnits;
    this.#reserve = progress.bytes;
  }

  snapshot() {
    return {
      limit: this.#limit,
      backingBytes: this.#backing,
      metadataUnits: this.#metadata,
      nativeAllowance: this.#native,
      allocated: this.#backing + this.#metadata + this.#native,
      obligations: this.#producer.escrow + this.#progress.escrow,
      reserve: this.#reserve,
      changed: this.#changed,
      stopped: this.#stopped,
      waiting: this.#waiters.reduce((count, waiter) => count + Number(waiter !== null), 0),
      producerFree: this.#free(this.#producer),
      progressFree: this.#free(this.#progress),
    };
  }
  #free(pool: Pool): MemoryRecords {
    return {
      allocations: pool.freeAllocations,
      references: pool.freeReferences,
      leases: pool.freeLeases,
    };
  }
  #pool(kind: PoolKind): Pool {
    return kind === "producer" ? this.#producer : this.#progress;
  }
  #reserveSerials(count: number): void {
    if (count > this.#serialLimit - this.#serial - this.#serialReserved)
      throw new MemoryBudgetError("serial");
    this.#serialReserved += count;
  }
  #mint(count: number): number {
    this.#serialReserved -= count;
    this.#serial += count;
    return this.#serial;
  }
  #spendSerials(owner: Location, count: number): number {
    const table = this.#pool(owner.pool).leases;
    const available = table.get(owner.slot, LeaseWord.Serials);
    const extra = Math.max(0, count - available);
    this.#reserveSerials(extra);
    table.add(owner.slot, LeaseWord.Serials, extra - count);
    return this.#mint(count);
  }
  tryOperation(demand: MemoryPlan): MemoryAdmission {
    return this.#admit("producer", plan(demand));
  }
  tryProgress(demand: MemoryPlan): MemoryAdmission {
    return this.#admit("progress", plan(demand));
  }
  #admit(kind: PoolKind, demand: MemoryPlan): MemoryAdmission {
    if (this.#stopped) return { kind: "stopped" };
    const pool = this.#pool(kind);
    const leases = demand.leases + 1;
    const ceiling = kind === "progress" ? this.#progressLimit : this.#producerLimit;
    if (
      demand.bytes > ceiling ||
      demand.allocations > pool.limits.allocations ||
      demand.references > pool.limits.references ||
      leases > pool.limits.leases
    )
      return { kind: "impossible" };
    const available = kind === "progress" ? this.#reserve : this.#available();
    if (
      demand.bytes > available ||
      demand.allocations > pool.freeAllocations ||
      demand.references > pool.freeReferences ||
      leases > pool.freeLeases
    )
      return { kind: "pressure", changed: this.#changed };
    const serials = 1 + demand.allocations + demand.references + demand.leases;
    if (serials > this.#serialLimit - this.#serial - this.#serialReserved)
      return { kind: "exhausted" };
    const slot = pool.leases.free();
    this.#reserveSerials(serials);
    const serial = this.#mint(1);
    pool.freeAllocations -= demand.allocations;
    pool.freeReferences -= demand.references;
    pool.freeLeases -= leases;
    pool.escrow += demand.bytes;
    if (kind === "progress") this.#reserve -= demand.bytes;
    this.#writeLease(pool, slot, serial, demand);
    return { kind: "granted", lease: this.#lease(kind, slot, serial) };
  }
  #available(): number {
    return (
      this.#limit -
      this.#backing -
      this.#metadata -
      this.#native -
      this.#producer.escrow -
      this.#progress.escrow -
      this.#reserve
    );
  }
  #writeLease(pool: Pool, slot: number, serial: number, demand: MemoryPlan): void {
    const table = pool.leases;
    table.set(slot, LeaseWord.Serial, serial);
    table.set(slot, LeaseWord.Open, 1);
    table.set(slot, LeaseWord.Bytes, demand.bytes);
    table.set(slot, LeaseWord.Allocations, demand.allocations);
    table.set(slot, LeaseWord.References, demand.references);
    table.set(slot, LeaseWord.Leases, demand.leases);
    table.set(slot, LeaseWord.Serials, demand.allocations + demand.references + demand.leases);
  }
  #lease(kind: PoolKind, slot: number, serial: number): MemoryLease {
    const location = Object.freeze({ pool: kind, slot, serial });
    return Object.freeze({
      allocate: (spec: MemoryBackingSpec) => this.#allocate(location, specification(spec)),
      account: (charge: Omit<MemoryCharge, "backingBytes">) => this.#account(location, charge),
      grow: (backing: MemoryBacking, ref: MemoryReference, bytes: number) =>
        this.#grow(location, backing, ref, integer(bytes)),
      retain: (ref: MemoryReference) => this.#retain(location, ref),
      release: (ref: MemoryReference) => this.#release(location, ref),
      delegate: (demand: MemoryPlan) => this.#delegate(location, plan(demand)),
      close: () => this.#closeLease(location),
    });
  }
  #isOpen(location: Location): boolean {
    const leases = this.#pool(location.pool).leases;
    return (
      leases.get(location.slot, LeaseWord.Serial) === location.serial &&
      leases.get(location.slot, LeaseWord.Open) === 1
    );
  }
  #check(
    location: Location,
    bytes: number,
    allocations: number,
    references: number,
    leases = 0,
  ): Pool {
    if (!this.#isOpen(location)) throw new MemoryBudgetError("closed");
    const pool = this.#pool(location.pool);
    const table = pool.leases;
    if (bytes > table.get(location.slot, LeaseWord.Bytes)) throw new MemoryBudgetError("capacity");
    if (
      allocations > table.get(location.slot, LeaseWord.Allocations) ||
      references > table.get(location.slot, LeaseWord.References) ||
      leases > table.get(location.slot, LeaseWord.Leases)
    )
      throw new MemoryBudgetError("records");
    return pool;
  }
  #delegate(location: Location, demand: MemoryPlan): MemoryLease {
    const count = demand.leases + 1;
    const pool = this.#check(location, demand.bytes, demand.allocations, demand.references, count);
    const slot = pool.leases.free();
    const credits = demand.allocations + demand.references + count;
    const table = pool.leases;
    const available = table.get(location.slot, LeaseWord.Serials);
    const extra = Math.max(0, credits - available);
    this.#reserveSerials(extra);
    table.add(location.slot, LeaseWord.Serials, extra - credits);
    const serial = this.#mint(1);
    table.add(location.slot, LeaseWord.Bytes, -demand.bytes);
    table.add(location.slot, LeaseWord.Allocations, -demand.allocations);
    table.add(location.slot, LeaseWord.References, -demand.references);
    table.add(location.slot, LeaseWord.Leases, -count);
    this.#writeLease(pool, slot, serial, demand);
    return this.#lease(location.pool, slot, serial);
  }
  #newAllocation(location: Location, charge: MemoryCharge): { slot: number; ref: Reference } {
    const bytes = sum(charge.backingBytes, charge.metadataUnits, charge.nativeAllowance);
    const pool = this.#check(location, bytes, 1, 1);
    const slot = pool.allocations.free();
    const reference = pool.references.free();
    const serial = this.#spendSerials(location, 2);
    pool.leases.add(location.slot, LeaseWord.Bytes, -bytes);
    pool.leases.add(location.slot, LeaseWord.Allocations, -1);
    pool.leases.add(location.slot, LeaseWord.References, -1);
    pool.escrow -= bytes;
    pool.allocations.set(slot, AllocationWord.Serial, serial - 1);
    pool.allocations.set(slot, AllocationWord.Backing, charge.backingBytes);
    pool.allocations.set(slot, AllocationWord.Metadata, charge.metadataUnits);
    pool.allocations.set(slot, AllocationWord.Native, charge.nativeAllowance);
    pool.allocations.set(slot, AllocationWord.References, 1);
    this.#backing += charge.backingBytes;
    this.#metadata += charge.metadataUnits;
    this.#native += charge.nativeAllowance;
    return { slot, ref: this.#newReference(location, reference, slot, serial) };
  }
  #newReference(location: Location, slot: number, allocation: number, serial: number): Reference {
    const pool = this.#pool(location.pool);
    pool.references.set(slot, ReferenceWord.Serial, serial);
    pool.references.set(slot, ReferenceWord.Allocation, allocation);
    pool.references.set(slot, ReferenceWord.Owner, location.slot);
    pool.leases.add(location.slot, LeaseWord.Held, 1);
    const id = pool.allocations.get(allocation, AllocationWord.Serial);
    return new Reference(id, this.#key, Object.freeze({ pool: location.pool, slot, serial }));
  }
  #allocate(location: Location, spec: MemoryBackingSpec) {
    const { slot, ref } = this.#newAllocation(location, {
      backingBytes: spec.bytes,
      metadataUnits: 0,
      nativeAllowance: 0,
    });
    try {
      const buffer = this.#allocator.allocate(spec);
      if (
        length(buffer) !== spec.bytes ||
        (spec.kind === "shared") !== buffer instanceof NativeSharedArrayBuffer
      )
        throw new TypeError("allocator returned a different backing shape");
      const serial = this.#pool(location.pool).allocations.get(slot, AllocationWord.Serial);
      const identity = Object.freeze({ pool: location.pool, slot, serial });
      return { backing: new Backing(buffer, this.#key, identity), ref };
    } catch (error) {
      this.#release(location, ref);
      throw error;
    }
  }
  #account(location: Location, charge: Omit<MemoryCharge, "backingBytes">): Reference {
    const metadataUnits = integer(charge.metadataUnits);
    const nativeAllowance = integer(charge.nativeAllowance);
    return this.#newAllocation(location, { backingBytes: 0, metadataUnits, nativeAllowance }).ref;
  }
  #reference(ref: Reference): Location | undefined {
    const location = ref instanceof Reference ? referenceLocation.call(ref, this.#key) : undefined;
    if (!location) return;
    const table = this.#pool(location.pool).references;
    if (table.get(location.slot, ReferenceWord.Serial) === location.serial) return location;
  }
  #retain(owner: Location, ref: Reference): Reference {
    const location = this.#reference(ref);
    if (!location || location.pool !== owner.pool) throw new MemoryBudgetError("reference");
    const pool = this.#check(owner, 0, 0, 1);
    const slot = pool.references.free();
    const serial = this.#spendSerials(owner, 1);
    const allocation = pool.references.get(location.slot, ReferenceWord.Allocation);
    pool.leases.add(owner.slot, LeaseWord.References, -1);
    pool.allocations.add(allocation, AllocationWord.References, 1);
    return this.#newReference(owner, slot, allocation, serial);
  }
  #release(owner: Location, ref: Reference): boolean {
    const location = this.#reference(ref);
    if (!location || location.pool !== owner.pool) return false;
    const pool = this.#pool(owner.pool);
    if (
      pool.leases.get(owner.slot, LeaseWord.Serial) !== owner.serial ||
      pool.references.get(location.slot, ReferenceWord.Owner) !== owner.slot
    )
      return false;
    const allocation = pool.references.get(location.slot, ReferenceWord.Allocation);
    pool.references.clear(location.slot);
    pool.leases.add(owner.slot, LeaseWord.Held, -1);
    this.#returnRecord(owner, LeaseWord.References);
    pool.allocations.add(allocation, AllocationWord.References, -1);
    this.#retire(owner, allocation);
    this.#retireLease(owner);
    this.#notify();
    return true;
  }
  #returnRecord(owner: Location, word: LeaseWord.Allocations | LeaseWord.References): void {
    const pool = this.#pool(owner.pool);
    if (this.#isOpen(owner)) pool.leases.add(owner.slot, word, 1);
    else if (word === LeaseWord.Allocations) pool.freeAllocations++;
    else pool.freeReferences++;
  }
  #refund(owner: Location, bytes: number): void {
    const pool = this.#pool(owner.pool);
    if (this.#isOpen(owner)) {
      pool.leases.add(owner.slot, LeaseWord.Bytes, bytes);
      pool.escrow += bytes;
      return;
    }
    if (owner.pool === "progress" && !this.#stopped) this.#reserve += bytes;
  }
  #retire(owner: Location, slot: number): void {
    const table = this.#pool(owner.pool).allocations;
    if (table.get(slot, AllocationWord.References) || table.get(slot, AllocationWord.Busy)) return;
    const backing = table.get(slot, AllocationWord.Backing);
    const metadata = table.get(slot, AllocationWord.Metadata);
    const native = table.get(slot, AllocationWord.Native);
    table.clear(slot);
    this.#backing -= backing;
    this.#metadata -= metadata;
    this.#native -= native;
    this.#refund(owner, backing + metadata + native);
    this.#returnRecord(owner, LeaseWord.Allocations);
  }
  #grow(owner: Location, backing: Backing, ref: Reference, bytes: number): void {
    const location = this.#reference(ref);
    const identity =
      backing instanceof Backing ? backingLocation.call(backing, this.#key) : undefined;
    if (!location || !identity || identity.pool !== owner.pool || location.pool !== owner.pool)
      throw new MemoryBudgetError("reference");
    const pool = this.#check(owner, 0, 0, 0);
    const slot = identity.slot;
    const table = pool.allocations;
    if (
      pool.references.get(location.slot, ReferenceWord.Owner) !== owner.slot ||
      pool.references.get(location.slot, ReferenceWord.Allocation) !== slot ||
      table.get(slot, AllocationWord.Serial) !== identity.serial
    )
      throw new MemoryBudgetError("reference");
    if (table.get(slot, AllocationWord.Busy)) throw new MemoryBudgetError("busy");
    if (!(backing.buffer instanceof NativeSharedArrayBuffer))
      throw new TypeError("shared backing required");
    const prior = table.get(slot, AllocationWord.Backing);
    if (bytes < prior) throw new RangeError("shared backing cannot shrink");
    const delta = bytes - prior;
    this.#check(owner, delta, 0, 0);
    pool.leases.add(owner.slot, LeaseWord.Bytes, -delta);
    pool.escrow -= delta;
    this.#backing += delta;
    table.add(slot, AllocationWord.Backing, delta);
    table.set(slot, AllocationWord.Busy, 1);
    pool.leases.add(owner.slot, LeaseWord.Busy, 1);
    try {
      this.#allocator.grow(backing.buffer, bytes);
    } finally {
      const actual = length(backing.buffer);
      const unused = bytes - actual;
      table.set(slot, AllocationWord.Backing, actual);
      table.set(slot, AllocationWord.Busy, 0);
      this.#backing -= unused;
      this.#refund(owner, unused);
      this.#retire(owner, slot);
      pool.leases.add(owner.slot, LeaseWord.Busy, -1);
      this.#retireLease(owner);
      this.#notify();
    }
  }
  #closeLease(owner: Location): void {
    if (!this.#isOpen(owner)) return;
    const pool = this.#pool(owner.pool);
    const table = pool.leases;
    const bytes = table.get(owner.slot, LeaseWord.Bytes);
    pool.freeAllocations += table.get(owner.slot, LeaseWord.Allocations);
    pool.freeReferences += table.get(owner.slot, LeaseWord.References);
    pool.freeLeases += table.get(owner.slot, LeaseWord.Leases);
    pool.escrow -= bytes;
    this.#serialReserved -= table.get(owner.slot, LeaseWord.Serials);
    table.set(owner.slot, LeaseWord.Serials, 0);
    table.set(owner.slot, LeaseWord.Bytes, 0);
    table.set(owner.slot, LeaseWord.Allocations, 0);
    table.set(owner.slot, LeaseWord.References, 0);
    table.set(owner.slot, LeaseWord.Leases, 0);
    table.set(owner.slot, LeaseWord.Open, 0);
    if (owner.pool === "progress" && !this.#stopped) this.#reserve += bytes;
    this.#retireLease(owner);
    this.#notify();
  }
  #retireLease(owner: Location): void {
    const pool = this.#pool(owner.pool);
    const table = pool.leases;
    if (
      table.get(owner.slot, LeaseWord.Open) ||
      table.get(owner.slot, LeaseWord.Held) ||
      table.get(owner.slot, LeaseWord.Busy)
    )
      return;
    table.clear(owner.slot);
    pool.freeLeases++;
  }
  observe(changed: bigint, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#stopped) return Promise.reject(new MemoryBudgetError("closed"));
    if (changed !== this.#changed) return Promise.resolve();
    const slot = this.#waiters.findIndex((waiter) => waiter === null);
    if (slot === -1) return Promise.reject(new MemoryBudgetError("records"));
    const pending = Promise.withResolvers<void>();
    const abort = () => this.#settle(slot, signal.reason);
    this.#waiters[slot] = { signal, abort, resolve: pending.resolve, reject: pending.reject };
    signal.addEventListener("abort", abort, { once: true });
    return pending.promise;
  }
  #settle(slot: number, ...failure: [] | [unknown]): void {
    const waiter = this.#waiters[slot];
    if (!waiter) return;
    this.#waiters[slot] = null;
    waiter.signal.removeEventListener("abort", waiter.abort);
    if (failure.length) waiter.reject(failure[0]);
    else waiter.resolve();
  }
  #notify(): void {
    this.#changed++;
    for (let slot = 0; slot < this.#waiters.length; slot++) {
      if (this.#stopped) this.#settle(slot, new MemoryBudgetError("closed"));
      else this.#settle(slot);
    }
  }
  close(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#reserve = 0;
    this.#closePool("producer");
    this.#closePool("progress");
    for (let slot = 0; slot < this.#waiters.length; slot++)
      this.#settle(slot, new MemoryBudgetError("closed"));
  }
  #closePool(kind: PoolKind): void {
    const table = this.#pool(kind).leases;
    for (let slot = 0; slot < table.count; slot++) {
      const serial = table.get(slot, LeaseWord.Serial);
      if (serial) this.#closeLease({ pool: kind, slot, serial });
    }
  }
}
