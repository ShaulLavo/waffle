import type { MemoryBudget, MemoryLease, MemoryReference } from "./memory-budget.js";
import { admittedLease } from "./memory-admission.js";

const NativeArrayBuffer = ArrayBuffer;
const publishedBackings = new WeakMap<MemoryBudget, Set<NamespaceProjectionBacking>>();

export class NamespaceProjectionBacking {
  private phase: "pending" | "published" | "cancelled" = "pending";
  constructor(
    readonly buffer: ArrayBuffer,
    private readonly budget: MemoryBudget,
    private readonly lease: MemoryLease,
    private readonly reference: MemoryReference,
  ) {}
  publish(): void {
    if (this.phase !== "pending") return;
    const prior = publishedBackings.get(this.budget);
    const backings = prior ?? new Set<NamespaceProjectionBacking>();
    try {
      backings.add(this);
      if (!prior) publishedBackings.set(this.budget, backings);
    } catch (error) {
      backings.delete(this);
      if (!prior) publishedBackings.delete(this.budget);
      throw error;
    }
    this.phase = "published";
    this.lease.close();
  }
  cancel(): void {
    if (this.phase !== "pending") return;
    this.lease.release(this.reference);
    this.lease.close();
    this.phase = "cancelled";
  }
}

export function allocateNamespaceProjectionBacking(
  budget: MemoryBudget,
  bytes: number,
): NamespaceProjectionBacking {
  const lease = admittedLease(
    budget.tryOperation({ bytes, allocations: 1, references: 1, leases: 0 }),
  );
  let reference: MemoryReference | undefined;
  try {
    const allocation = lease.allocate({ kind: "array", bytes });
    reference = allocation.ref;
    const buffer = allocation.backing.buffer;
    if (!(buffer instanceof NativeArrayBuffer))
      throw new TypeError("array namespace projection backing required");
    return new NamespaceProjectionBacking(buffer, budget, lease, reference);
  } catch (error) {
    if (reference) lease.release(reference);
    lease.close();
    throw error;
  }
}
