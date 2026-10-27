import { FilesystemError } from "./protocol.js";

export interface CheckpointLimits {
  readonly maxBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxOperations: number;
}

export interface CheckpointCost {
  readonly bytes: number;
  readonly metadataBytes: number;
}

type Reservation = CheckpointCost & { readonly admittedAt: number; running: boolean };

/** Accounts captures and the adapters' submission copy, not resident shared pages. */
export class CheckpointPressure {
  private readonly reservations = new Map<number, Reservation>();
  private sequence = 0;
  private bytes = 0;
  private metadataBytes = 0;
  private rejected = 0;
  private lastLatencyMs = 0;
  private maxLatencyMs = 0;
  readonly limits: CheckpointLimits;

  constructor(limits: Partial<CheckpointLimits> = {}) {
    this.limits = {
      maxBytes: limits.maxBytes ?? 512 * 1024 * 1024,
      maxMetadataBytes: limits.maxMetadataBytes ?? 8 * 1024 * 1024,
      maxOperations: limits.maxOperations ?? 64,
    };
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new RangeError("invalid checkpoint limit");
  }

  reserve(cost: CheckpointCost): number {
    this.check(cost.bytes, cost.metadataBytes, 1);
    const id = ++this.sequence;
    this.reservations.set(id, { ...cost, admittedAt: performance.now(), running: false });
    this.bytes += cost.bytes;
    this.metadataBytes += cost.metadataBytes;
    return id;
  }

  private check(bytes: number, metadataBytes: number, operations: number): void {
    if (
      this.bytes + bytes <= this.limits.maxBytes &&
      this.metadataBytes + metadataBytes <= this.limits.maxMetadataBytes &&
      this.reservations.size + operations <= this.limits.maxOperations
    )
      return;
    this.rejected++;
    throw new FilesystemError(6, "filesystem checkpoint pressure limit reached");
  }

  start(id: number, metadataBytes: number): void {
    const entry = this.reservations.get(id);
    if (!entry) throw new Error("missing checkpoint reservation");
    const growth = Math.max(0, metadataBytes - entry.metadataBytes);
    this.check(0, growth, 0);
    this.metadataBytes += growth;
    this.reservations.set(id, {
      ...entry,
      metadataBytes: entry.metadataBytes + growth,
      running: true,
    });
  }

  release(id: number): void {
    const entry = this.reservations.get(id);
    if (!entry) return;
    this.reservations.delete(id);
    this.bytes -= entry.bytes;
    this.metadataBytes -= entry.metadataBytes;
    this.lastLatencyMs = performance.now() - entry.admittedAt;
    this.maxLatencyMs = Math.max(this.maxLatencyMs, this.lastLatencyMs);
  }

  diagnostics() {
    const now = performance.now();
    let oldestAgeMs = 0;
    let inFlightOperations = 0;
    for (const entry of this.reservations.values()) {
      oldestAgeMs = Math.max(oldestAgeMs, now - entry.admittedAt);
      if (entry.running) inFlightOperations++;
    }
    return {
      limits: { ...this.limits },
      pendingBytes: this.bytes,
      pendingMetadataBytes: this.metadataBytes,
      pendingOperations: this.reservations.size,
      queuedOperations: this.reservations.size - inFlightOperations,
      inFlightOperations,
      oldestAgeMs,
      lastLatencyMs: this.lastLatencyMs,
      maxLatencyMs: this.maxLatencyMs,
      rejected: this.rejected,
    };
  }
}
