import type { MemoryBudget, MemoryLease, MemoryPlan, MemoryReference } from "./memory-budget.js";
import { admittedLease } from "./memory-admission.js";
import type { PublicationBuffers } from "./publication-internal.js";

const NativeSharedBuffer = SharedArrayBuffer;
const publishedGroups = new WeakMap<MemoryBudget, Set<PublicationAllocationGroup>>();
type Phase =
  | { readonly kind: "unpublished" }
  | { readonly kind: "published"; readonly buffers: PublicationBuffers }
  | { readonly kind: "cancelled" };

class PublicationAllocationGroup {
  private phase: Phase = { kind: "unpublished" };
  private readonly references: (MemoryReference | undefined)[];
  private readonly lease: MemoryLease;
  private next = 0;
  constructor(
    private readonly budget: MemoryBudget,
    plan: MemoryPlan,
  ) {
    this.references = Array.from({ length: plan.allocations }, () => undefined);
    this.lease = admittedLease(budget.tryOperation(plan));
  }
  allocate(bytes: number): SharedArrayBuffer {
    if (this.phase.kind !== "unpublished" || this.next >= this.references.length)
      throw new Error("publication allocation group is not open");
    const allocation = this.lease.allocate({ kind: "shared", bytes, maximum: bytes });
    this.references[this.next++] = allocation.ref;
    const buffer = allocation.backing.buffer;
    if (!(buffer instanceof NativeSharedBuffer))
      throw new TypeError("shared publication backing required");
    return buffer;
  }
  publish(buffers: PublicationBuffers): void {
    if (this.phase.kind !== "unpublished") return;
    const published: Phase = { kind: "published", buffers };
    const prior = publishedGroups.get(this.budget);
    const groups = prior ?? new Set<PublicationAllocationGroup>();
    try {
      groups.add(this);
      if (!prior) publishedGroups.set(this.budget, groups);
    } catch (error) {
      groups.delete(this);
      if (!prior) publishedGroups.delete(this.budget);
      throw error;
    }
    this.phase = published;
    this.lease.close();
  }
  cancel(): void {
    if (this.phase.kind !== "unpublished") return;
    for (let index = 0; index < this.references.length; index++) {
      const reference = this.references[index];
      if (!reference) continue;
      this.lease.release(reference);
      this.references[index] = undefined;
    }
    this.lease.close();
    this.phase = { kind: "cancelled" };
  }
}

export function withPublicationMemory(
  budget: MemoryBudget,
  plan: MemoryPlan,
  construct: (allocate: (bytes: number) => SharedArrayBuffer) => PublicationBuffers,
): PublicationBuffers {
  const group = new PublicationAllocationGroup(budget, plan);
  try {
    const buffers = construct((bytes) => group.allocate(bytes));
    group.publish(buffers);
    return buffers;
  } catch (error) {
    group.cancel();
    throw error;
  }
}
