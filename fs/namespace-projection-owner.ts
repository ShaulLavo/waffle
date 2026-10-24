import { admittedLease } from "./memory-admission.js";
import {
  MemoryBudgetError,
  type MemoryBudget,
  type MemoryLease,
  type MemoryReference,
} from "./memory-budget.js";
import { NamespaceProjectionTable, namespaceProjectionPlan } from "./namespace-projection-table.js";

type ProjectionOptions = ConstructorParameters<typeof NamespaceProjectionTable>[0];
type ProjectionAllocation =
  | { readonly kind: "unfunded" }
  | {
      readonly kind: "funded";
      readonly lease: MemoryLease;
      readonly references: MemoryReference[];
    };
type LiveProjection = {
  readonly table: NamespaceProjectionTable;
  readonly allocation: ProjectionAllocation;
  borrowers: number;
};
type ProjectionPhase =
  | ({ readonly kind: "open" | "draining" } & LiveProjection)
  | ({ readonly kind: "cleanup-failed"; readonly error: unknown } & Omit<
      LiveProjection,
      "borrowers"
    >)
  | { readonly kind: "retired" };

interface NamespaceProjectionBorrow {
  readonly table: NamespaceProjectionTable;
  release(): void;
}

function abandon(lease: MemoryLease, references: readonly MemoryReference[]): void {
  try {
    for (const reference of references) lease.release(reference);
  } finally {
    lease.close();
  }
}

function fundedProjection(options: ProjectionOptions, budget: MemoryBudget) {
  const plan = namespaceProjectionPlan(options);
  const bytes = plan.backingBytes + plan.bookkeepingBytes;
  const lease = admittedLease(
    budget.tryOperation({ bytes, allocations: 2, references: 2, leases: 0 }),
  );
  const references: MemoryReference[] = [];
  try {
    const backing = lease.allocate({ kind: "array", bytes: plan.backingBytes });
    references.push(backing.ref);
    if (!(backing.backing.buffer instanceof ArrayBuffer))
      throw new TypeError("array namespace projection backing required");
    references.push(lease.account({ metadataUnits: plan.bookkeepingBytes, nativeAllowance: 0 }));
    const table = new NamespaceProjectionTable(options, undefined, backing.backing.buffer);
    lease.close();
    return { table, allocation: { kind: "funded", lease, references } as const };
  } catch (error) {
    abandon(lease, references);
    throw error;
  }
}

export class NamespaceProjectionOwner {
  private phase: ProjectionPhase;
  private settlement:
    | {
        readonly promise: Promise<void>;
        readonly resolve: () => void;
        readonly reject: (reason?: unknown) => void;
      }
    | undefined;

  private constructor(table: NamespaceProjectionTable, allocation: ProjectionAllocation) {
    this.phase = { kind: "open", table, allocation, borrowers: 0 };
  }

  static create(options: ProjectionOptions = {}, budget?: MemoryBudget): NamespaceProjectionOwner {
    if (budget) {
      const funded = fundedProjection(options, budget);
      return new NamespaceProjectionOwner(funded.table, funded.allocation);
    }
    return new NamespaceProjectionOwner(new NamespaceProjectionTable(options), {
      kind: "unfunded",
    });
  }

  borrow(): NamespaceProjectionBorrow | undefined {
    if (this.phase.kind !== "open") return undefined;
    const phase = this.phase;
    phase.borrowers++;
    let released = false;
    return {
      table: phase.table,
      release: () => {
        if (released) return;
        released = true;
        this.release();
      },
    };
  }

  retire(): Promise<void> {
    if (this.settlement) return this.settlement.promise;
    if (this.phase.kind !== "open") throw new Error("namespace projection retirement is unsettled");
    const phase = this.phase;
    this.phase = { ...phase, kind: "draining" };
    this.settlement = Promise.withResolvers<void>();
    if (phase.borrowers === 0) this.cleanup();
    return this.settlement.promise;
  }

  private release(): void {
    if (this.phase.kind !== "open" && this.phase.kind !== "draining") return;
    if (this.phase.borrowers === 0) throw new Error("namespace projection borrower underflow");
    this.phase.borrowers--;
    if (this.phase.kind === "draining" && this.phase.borrowers === 0) this.cleanup();
  }

  private cleanup(): void {
    if (this.phase.kind !== "draining" || this.phase.borrowers !== 0) return;
    const phase = this.phase;
    const settlement = this.settlement;
    if (!settlement) throw new Error("namespace projection cleanup is unsettled");
    try {
      if (phase.allocation.kind === "funded") this.releaseAllocations(phase.allocation);
      this.phase = { kind: "retired" };
      settlement.resolve();
    } catch (error) {
      this.phase = {
        kind: "cleanup-failed",
        table: phase.table,
        allocation: phase.allocation,
        error,
      };
      settlement.reject(error);
    }
  }

  private releaseAllocations(allocation: Extract<ProjectionAllocation, { kind: "funded" }>): void {
    while (allocation.references.length) {
      const reference = allocation.references[0]!;
      if (!allocation.lease.release(reference)) throw new MemoryBudgetError("reference");
      allocation.references.shift();
    }
  }
}
