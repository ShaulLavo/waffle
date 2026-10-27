import type { MemoryBudget, MemoryLease, MemoryReference } from "./memory-budget.js";
import { admittedLease } from "./memory-admission.js";

// Declared control allowance, not a measurement of JavaScript heap usage.
const ROOT_OWNER_UNITS = 512;
const NativeSharedBuffer = SharedArrayBuffer;
const publishedRoots = new WeakMap<MemoryBudget, Set<SharedArrayBuffer>>();

class StartupRootAllocation {
  private phase: "pending" | "published" | "cancelled" = "pending";
  constructor(
    readonly buffer: SharedArrayBuffer,
    private readonly budget: MemoryBudget,
    private readonly lease: MemoryLease,
    private readonly backing: MemoryReference,
    private readonly control: MemoryReference,
  ) {}
  publish(): void {
    if (this.phase !== "pending") return;
    let roots = publishedRoots.get(this.budget);
    if (!roots) {
      roots = new Set();
      publishedRoots.set(this.budget, roots);
    }
    roots.add(this.buffer);
    this.phase = "published";
    this.lease.close();
  }
  cancel(): void {
    if (this.phase !== "pending") return;
    this.phase = "cancelled";
    this.lease.release(this.backing);
    this.lease.release(this.control);
    this.lease.close();
  }
}

/** Published backings stay owned for the authority's lifetime, including after close. */
export function allocateStartupRoot(budget: MemoryBudget, bytes: number): StartupRootAllocation {
  const lease = admittedLease(
    budget.tryOperation({
      bytes: bytes + ROOT_OWNER_UNITS,
      allocations: 2,
      references: 2,
      leases: 0,
    }),
  );
  let control: MemoryReference | undefined;
  let backing: MemoryReference | undefined;
  try {
    control = lease.account({ metadataUnits: ROOT_OWNER_UNITS, nativeAllowance: 0 });
    const allocation = lease.allocate({ kind: "shared", bytes, maximum: bytes });
    backing = allocation.ref;
    const buffer = allocation.backing.buffer;
    if (!(buffer instanceof NativeSharedBuffer))
      throw new TypeError("shared startup root required");
    return new StartupRootAllocation(buffer, budget, lease, backing, control);
  } catch (error) {
    if (backing) lease.release(backing);
    if (control) lease.release(control);
    lease.close();
    throw error;
  }
}
