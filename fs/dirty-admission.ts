import { FilesystemError } from "./protocol.js";
import type { CheckpointLimits, CheckpointCost } from "./checkpoint-pressure.js";

export interface DirtyLimits {
  readonly maxBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxWaiters: number;
}

export class DirtyCapacityError extends FilesystemError {
  constructor(readonly permanent = false) {
    super(6, "filesystem dirty capacity exhausted");
  }
}

// These words are inside the fixed shared header. All Float64 access owns the global lock.
const ENABLED = 0,
  MAX_BYTES = 1,
  MAX_METADATA = 2,
  MAX_WAITERS = 3;
const CAPTURE_BYTES = 4,
  CAPTURE_METADATA = 5,
  DIRTY_BYTES = 6,
  DIRTY_METADATA = 7;
const NAMESPACE = 8,
  PINS = 9,
  COPIES = 10,
  COPY_METADATA = 11,
  OPERATIONS = 12;
const REVISION = 13,
  REJECTED = 14;
export const DIRTY_HEADER_WORDS = 48;
const DIRTY_PIN_UNITS = 2048;
export const DIRTY_NODE_UNITS = 1024;
const BASE_UNITS = 1024;

/** A fixed ledger shared by service and direct writers. No producer payloads live here. */
export class DirtyAdmission {
  private readonly values: Float64Array;
  private readonly signals: Int32Array;
  constructor(
    buffer: SharedArrayBuffer,
    private readonly inputBytes = () => 0,
    private readonly inputMetadata = () => 0,
  ) {
    this.values = new Float64Array(buffer, 32 * 4, 20);
    this.signals = new Int32Array(buffer, 9 * 4, 2);
  }
  get enabled(): boolean {
    return this.values[ENABLED] === 1;
  }
  configure(limits: Partial<DirtyLimits>, capture: CheckpointLimits, namespace: number): void {
    const maxBytes = limits.maxBytes ?? 2 * 1024 * 1024 * 1024;
    const maxMetadataBytes = limits.maxMetadataBytes ?? capture.maxMetadataBytes * 2;
    const maxWaiters = limits.maxWaiters ?? 64;
    for (const value of [maxBytes, maxMetadataBytes, maxWaiters])
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("invalid dirty limit");
    this.values[MAX_BYTES] = maxBytes;
    this.values[MAX_METADATA] = maxMetadataBytes;
    this.values[MAX_WAITERS] = maxWaiters;
    this.values[CAPTURE_BYTES] = capture.maxBytes;
    this.values[CAPTURE_METADATA] = capture.maxMetadataBytes;
    this.values[NAMESPACE] = namespace;
    this.values[ENABLED] = 1;
  }
  private reject(permanent = false): never {
    this.values[REJECTED]!++;
    throw new DirtyCapacityError(permanent);
  }
  private metadata(): number {
    return BASE_UNITS + this.values[NAMESPACE]! + this.values[PINS]! + this.values[DIRTY_METADATA]!;
  }
  checkInput(resident: number): void {
    if (!this.enabled) return;
    if (
      resident + this.values[DIRTY_BYTES]! + this.values[COPIES]! + this.inputBytes() >
      this.values[MAX_BYTES]!
    )
      this.reject();
    if (
      this.metadata() * 2 + this.values[COPY_METADATA]! + this.inputMetadata() >
      this.values[MAX_METADATA]!
    )
      this.reject();
  }
  private check(resident: number, bytes: number, metadata: number): void {
    if (!this.enabled) return;
    if (this.values[DIRTY_BYTES]! + bytes > this.values[CAPTURE_BYTES]!) this.reject();
    if (this.metadata() + metadata > this.values[CAPTURE_METADATA]!) this.reject();
    if (
      resident +
        (this.values[DIRTY_BYTES]! + bytes) * 2 +
        this.values[COPIES]! +
        this.inputBytes() >
      this.values[MAX_BYTES]!
    )
      this.reject();
    if (
      (this.metadata() + metadata) * 2 + this.values[COPY_METADATA]! + this.inputMetadata() >
      this.values[MAX_METADATA]!
    )
      this.reject();
  }
  checkFile(resident: number, previous: number, size: number, first: boolean): void {
    if (!this.enabled) return;
    if (
      size * 2 > this.values[CAPTURE_BYTES]! ||
      Math.ceil(size / 65536) * 65536 + size * 4 > this.values[MAX_BYTES]!
    )
      this.reject(true);
    this.check(resident, Math.max(0, size - previous) * 2, first ? DIRTY_NODE_UNITS : 0);
  }
  file(resident: number, previous: number, size: number, first: boolean): void {
    if (!this.enabled) return;
    this.checkFile(resident, previous, size, first);
    this.values[DIRTY_BYTES]! += Math.max(0, size - previous) * 2;
    if (first) this.values[DIRTY_METADATA]! += DIRTY_NODE_UNITS;
    this.values[REVISION]!++;
  }
  resident(bytes: number): void {
    this.check(bytes, 0, 0);
  }
  mutation(resident: number, namespace: number, bytes: number, metadata: number): void {
    if (!this.enabled) return;
    if (namespace + BASE_UNITS > this.values[CAPTURE_METADATA]!) this.reject(true);
    this.check(resident, bytes, namespace + metadata);
    this.values[NAMESPACE]! += namespace;
    this.values[DIRTY_BYTES]! += bytes;
    this.values[DIRTY_METADATA]! += metadata;
    this.values[REVISION]!++;
  }
  pin(delta: 1 | -1, resident: number): void {
    if (!this.enabled) return;
    if (delta === 1) this.check(resident, 0, DIRTY_PIN_UNITS);
    this.values[PINS]! += delta * DIRTY_PIN_UNITS;
  }
  reserveCopy(cost: CheckpointCost, resident: number): void {
    if (!this.enabled) return;
    if (
      resident + this.values[DIRTY_BYTES]! + this.values[COPIES]! + this.inputBytes() + cost.bytes >
      this.values[MAX_BYTES]!
    )
      this.reject();
    if (
      this.metadata() + this.values[COPY_METADATA]! + this.inputMetadata() + cost.metadataBytes >
      this.values[MAX_METADATA]!
    )
      this.reject();
    this.values[COPIES]! += cost.bytes;
    this.values[COPY_METADATA]! += cost.metadataBytes;
    this.values[OPERATIONS]!++;
  }
  growCopyMetadata(units: number): void {
    if (!this.enabled || !units) return;
    if (
      this.metadata() + this.values[COPY_METADATA]! + this.inputMetadata() + units >
      this.values[MAX_METADATA]!
    )
      this.reject();
    this.values[COPY_METADATA]! += units;
  }
  releaseCopy(cost: CheckpointCost): void {
    if (!this.enabled) return;
    this.values[COPIES]! -= cost.bytes;
    this.values[COPY_METADATA]! -= cost.metadataBytes;
    this.values[OPERATIONS]!--;
    this.notify();
  }
  get revision(): number {
    return this.values[REVISION]!;
  }
  clean(revision: number, namespace: number): boolean {
    if (!this.enabled || this.revision !== revision) return false;
    this.values[DIRTY_BYTES] = 0;
    this.values[DIRTY_METADATA] = 0;
    this.values[NAMESPACE] = namespace;
    this.notify();
    return true;
  }
  private notify(): void {
    Atomics.add(this.signals, 0, 1);
  }
  /** Bounded observation records. Cancellation is checked without entering a mutation lock. */
  async wait(changed: number, cancelled: () => boolean, failure: () => unknown): Promise<void> {
    const count = Atomics.add(this.signals, 1, 1);
    if (count >= this.values[MAX_WAITERS]!) {
      Atomics.sub(this.signals, 1, 1);
      throw new DirtyCapacityError(true);
    }
    try {
      while (Atomics.load(this.signals, 0) === changed) {
        if (cancelled()) throw new FilesystemError(11);
        const error = failure();
        if (error !== undefined) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
      if (cancelled()) throw new FilesystemError(11);
    } finally {
      Atomics.sub(this.signals, 1, 1);
    }
  }
  get hasDebt(): boolean {
    return this.values[DIRTY_BYTES]! > 0 || this.values[DIRTY_METADATA]! > 0;
  }
  capacityReleased(): void {
    if (this.enabled) this.notify();
  }
  get change(): number {
    return Atomics.load(this.signals, 0);
  }
  diagnostics(residentBytes: number) {
    return {
      enabled: this.enabled,
      residentBytes,
      dirtyCaptureBytes: this.values[DIRTY_BYTES]!,
      dirtyMetadataUnits: this.values[DIRTY_METADATA]!,
      namespaceUnits: this.values[NAMESPACE]!,
      pinUnits: this.values[PINS]!,
      immutableCopyBytes: this.values[COPIES]!,
      immutableMetadataUnits: this.values[COPY_METADATA]!,
      pendingOperations: this.values[OPERATIONS]!,
      waiters: Atomics.load(this.signals, 1),
      rejected: this.values[REJECTED]!,
      pendingInputBytes: this.inputBytes(),
      pendingInputMetadataUnits: this.inputMetadata(),
      accountedBytes:
        residentBytes + this.values[DIRTY_BYTES]! + this.values[COPIES]! + this.inputBytes(),
      accountedMetadataUnits: this.metadata() + this.values[COPY_METADATA]! + this.inputMetadata(),
      limits: {
        maxBytes: this.values[MAX_BYTES]!,
        maxMetadataBytes: this.values[MAX_METADATA]!,
        maxWaiters: this.values[MAX_WAITERS]!,
      },
    };
  }
}
