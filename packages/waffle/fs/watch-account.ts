import { FilesystemError } from "../core/filesystem.js";
import {
  MemoryBudgetError,
  type MemoryBudget,
  type MemoryLease,
  type MemoryReference,
} from "./memory-budget.js";

export interface WatchResourceLimits {
  readonly backingBytes: number;
  readonly controlUnits: number;
  readonly workBytes: number;
  readonly slabBytes: number;
  readonly eventBytes: number;
}
export const ORDINARY_WATCH_LIMITS: WatchResourceLimits = Object.freeze({
  backingBytes: 64 * 1024 * 1024,
  eventBytes: 16 * 1024 * 1024,
  workBytes: 1024 * 1024,
  controlUnits: 4 * 1024 * 1024,
  slabBytes: 4096,
});
export const WATCH_CONTROL_UNITS = { root: 256, slab: 128, allocation: 64 } as const;
type ParentCharge = { readonly lease: MemoryLease; readonly reference: MemoryReference };
export type WatchAllocationKind = "metadata" | "scratch" | "events";
type Phase = "reserved" | "committed" | "released";
interface Slab {
  buffer: ArrayBuffer | undefined;
  readonly capacity: number;
  readonly parent: ParentCharge | undefined;
  owner: WatchAllocation | undefined;
}

function capacity(): never {
  throw new FilesystemError(6, "watch allocation capacity exhausted");
}
function validate(limits: WatchResourceLimits): WatchResourceLimits {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError("invalid watch resource limit");
  }
  if (
    limits.slabBytes < 4 ||
    limits.slabBytes % 4 ||
    limits.slabBytes > limits.backingBytes ||
    limits.workBytes > limits.backingBytes ||
    limits.eventBytes > limits.backingBytes ||
    limits.controlUnits < WATCH_CONTROL_UNITS.root
  )
    throw new RangeError("invalid watch resource plan");
  return Object.freeze({ ...limits });
}
function parentLease(parent: MemoryBudget, bytes: number): MemoryLease {
  const admission = parent.tryOperation({ bytes, allocations: 1, references: 1, leases: 0 });
  if (admission.kind !== "granted") return capacity();
  return admission.lease;
}
function parentControl(parent: MemoryBudget | undefined, units: number): ParentCharge | undefined {
  if (!parent) return;
  const lease = parentLease(parent, units);
  try {
    const reference = lease.account({ metadataUnits: units, nativeAllowance: 0 });
    lease.close();
    return { lease, reference };
  } catch (error) {
    lease.close();
    throw error;
  }
}
function backing(
  parent: MemoryBudget | undefined,
  bytes: number,
): { buffer: ArrayBuffer; charge: ParentCharge | undefined } {
  if (!parent) return { buffer: new ArrayBuffer(bytes), charge: undefined };
  const lease = parentLease(parent, bytes);
  let reference: MemoryReference | undefined;
  try {
    const allocation = lease.allocate({ kind: "array", bytes });
    reference = allocation.ref;
    const buffer = allocation.backing.buffer;
    if (!(buffer instanceof ArrayBuffer)) throw new TypeError("watch backing must be private");
    lease.close();
    return { buffer, charge: { lease, reference } };
  } catch (error) {
    if (reference) lease.release(reference);
    lease.close();
    throw error;
  }
}
function release(charge: ParentCharge | undefined): void {
  charge?.lease.release(charge.reference);
}

class Allocation {
  private phase: Phase = "reserved";
  private data: DataView | undefined;
  private bytes: Uint8Array | undefined;
  constructor(
    private readonly commitAllocation: () => void,
    private readonly releaseAllocation: () => void,
    slab: Slab,
    readonly length: number,
    readonly kind: WatchAllocationKind,
  ) {
    this.data = new DataView(slab.buffer!, 0, length);
    this.bytes = new Uint8Array(slab.buffer!, 0, length);
  }
  get view(): DataView {
    if (!this.data) throw new FilesystemError(11, "watch allocation released");
    return this.data;
  }
  get array(): Uint8Array {
    if (!this.bytes) throw new FilesystemError(11, "watch allocation released");
    return this.bytes;
  }
  get reserved(): boolean {
    return this.phase === "reserved";
  }
  commit(): Allocation {
    if (this.phase !== "reserved")
      throw new FilesystemError(11, "watch reservation is not pending");
    this.commitAllocation();
    this.phase = "committed";
    return this;
  }
  cancel(): void {
    if (this.phase === "reserved") this.release();
  }
  release(): void {
    if (this.phase === "released") return;
    this.releaseAllocation();
    this.phase = "released";
    this.data = undefined;
    this.bytes = undefined;
  }
}

export type WatchAllocation = Allocation;

/** A root-local watch ledger, including ordinary roots without a startup MemoryBudget. */
export class RootWatchAccount {
  private readonly limits: WatchResourceLimits;
  private readonly slabs: Slab[] = [];
  private control: ParentCharge | undefined;
  private stopped = false;
  private live = 0;
  private pending = 0;
  private work = 0;
  private events = 0;
  private controls: number = WATCH_CONTROL_UNITS.root;
  private bytes = 0;
  private peakControls: number = WATCH_CONTROL_UNITS.root;
  private peakWork = 0;
  private peakEvents = 0;
  private peakBacking = 0;
  private peak(): void {
    this.peakControls = Math.max(this.peakControls, this.controls);
    this.peakWork = Math.max(this.peakWork, this.work);
    this.peakEvents = Math.max(this.peakEvents, this.events);
    this.peakBacking = Math.max(this.peakBacking, this.bytes);
  }
  constructor(
    limits: WatchResourceLimits = ORDINARY_WATCH_LIMITS,
    private readonly parent?: MemoryBudget,
  ) {
    this.limits = validate(limits);
  }
  get closed(): boolean {
    return this.stopped;
  }
  resources() {
    let reusable = 0;
    for (const slab of this.slabs) if (!slab.owner) reusable += slab.capacity;
    return {
      stopped: this.stopped,
      backingBytes: this.bytes,
      liveBytes: this.live,
      reservedBytes: this.pending,
      workBytes: this.work,
      eventBytes: this.events,
      reusableBytes: reusable,
      paddingBytes: this.bytes - reusable - this.live - this.pending,
      controlUnits: this.controls,
      slabs: this.slabs.length,
      peakBackingBytes: this.peakBacking,
      peakControlUnits: this.peakControls,
      peakWorkBytes: this.peakWork,
      peakEventBytes: this.peakEvents,
    };
  }
  reserveControl(units: number): { release(): void } {
    if (this.stopped) throw new FilesystemError(11, "watch account closed");
    if (!Number.isSafeInteger(units) || units < 0)
      throw new RangeError("invalid watch control charge");
    const charged = units + WATCH_CONTROL_UNITS.allocation;
    if (charged > this.limits.controlUnits - this.controls) return capacity();
    this.control ??= parentControl(this.parent, this.limits.controlUnits);
    this.controls += charged;
    this.peak();
    let held = true;
    return {
      release: () => {
        if (!held) return;
        held = false;
        if (!this.stopped) this.controls -= charged;
      },
    };
  }
  reserve(bytes: number, kind: WatchAllocationKind = "metadata"): WatchAllocation {
    if (this.stopped) throw new FilesystemError(11, "watch account closed");
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new RangeError("invalid watch allocation size");
    if (bytes > 0xffffffff) return capacity();
    if (kind === "scratch" && bytes > this.limits.workBytes - this.work) return capacity();
    if (kind === "events" && bytes > this.limits.eventBytes - this.events) return capacity();
    if (WATCH_CONTROL_UNITS.allocation > this.limits.controlUnits - this.controls)
      return capacity();
    const slab =
      this.slabs.find((candidate) => !candidate.owner && candidate.capacity >= bytes) ??
      this.grow(bytes);
    let allocation: Allocation;
    try {
      allocation = new Allocation(
        () => this.commit(allocation),
        () => this.release(allocation, slab),
        slab,
        bytes,
        kind,
      );
    } catch (error) {
      throw error instanceof RangeError ? new FilesystemError(48) : error;
    }
    allocation.array.fill(0);
    slab.owner = allocation;
    this.controls += WATCH_CONTROL_UNITS.allocation;
    this.pending += bytes;
    if (kind === "scratch") this.work += bytes;
    if (kind === "events") this.events += bytes;
    this.peak();
    return allocation;
  }
  private grow(bytes: number): Slab {
    const limits = this.limits;
    const rounded = Math.ceil(bytes / limits.slabBytes) * limits.slabBytes;
    if (
      rounded > limits.backingBytes - this.bytes ||
      WATCH_CONTROL_UNITS.slab + WATCH_CONTROL_UNITS.allocation >
        limits.controlUnits - this.controls
    )
      return capacity();
    let control = this.control;
    let candidate: ReturnType<typeof backing> | undefined;
    try {
      control ??= parentControl(this.parent, limits.controlUnits);
      const allocation = backing(this.parent, rounded);
      candidate = allocation;
      if (this.stopped) throw new FilesystemError(11, "watch account closed during allocation");
      const slab: Slab = {
        buffer: allocation.buffer,
        capacity: rounded,
        parent: allocation.charge,
        owner: undefined,
      };
      this.slabs.push(slab);
      this.control = control;
      this.controls += WATCH_CONTROL_UNITS.slab;
      this.bytes += rounded;
      this.peak();
      return slab;
    } catch (error) {
      release(candidate?.charge);
      if (!this.control) release(control);
      if (error instanceof MemoryBudgetError) return capacity();
      if (error instanceof RangeError) throw new FilesystemError(48);
      throw error;
    }
  }
  private commit(allocation: WatchAllocation): void {
    if (
      this.stopped ||
      !allocation.reserved ||
      !this.slabs.some((slab) => slab.owner === allocation)
    )
      throw new FilesystemError(11, "invalid watch reservation");
    this.pending -= allocation.length;
    this.live += allocation.length;
  }
  private release(allocation: WatchAllocation, slab: Slab): void {
    if (!this.slabs.includes(slab) || slab.owner !== allocation)
      throw new Error("foreign watch allocation");
    if (allocation.reserved) this.pending -= allocation.length;
    else this.live -= allocation.length;
    if (allocation.kind === "scratch") this.work -= allocation.length;
    if (allocation.kind === "events") this.events -= allocation.length;
    this.controls -= WATCH_CONTROL_UNITS.allocation;
    slab.owner = undefined;
  }
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const slab of this.slabs) {
      slab.owner?.release();
      slab.buffer = undefined;
      release(slab.parent);
    }
    this.slabs.length = 0;
    release(this.control);
    this.control = undefined;
    this.bytes = 0;
    this.controls = 0;
  }
}
