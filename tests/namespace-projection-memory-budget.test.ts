import { expect, spyOn, test } from "bun:test";
import {
  MemoryBudget,
  MemoryBudgetError,
  type MemoryAllocator,
  type MemoryBackingSpec,
  type MemoryRecords,
} from "../fs/memory-budget";
import { NamespaceProjectionTable } from "../fs/namespace-projection-table";

const capacity = {
  nodes: 4,
  edges: 4,
  extraLinks: 2,
  nameBytes: 32,
  scratchSlots: 2,
  byteLimit: 8349,
};
const backingBytes = 157;
const plan = { bytes: backingBytes, allocations: 1, references: 1, leases: 0 };
const records: MemoryRecords = { allocations: 4, references: 4, leases: 2 };
const reason = new Error("controlled namespace construction failure");
type Snapshot = ReturnType<MemoryBudget["snapshot"]>;

class Allocator implements MemoryAllocator {
  readonly specs: MemoryBackingSpec[] = [];
  readonly snapshots: Snapshot[] = [];
  budget: MemoryBudget | undefined;
  fault: "none" | "throw" | "shared" | "short" = "none";
  allocate(spec: MemoryBackingSpec): ArrayBuffer | SharedArrayBuffer {
    if (!this.budget) throw new Error("missing test authority");
    this.specs.push(spec);
    this.snapshots.push(this.budget.snapshot());
    if (this.fault === "throw") throw reason;
    if (this.fault === "shared") return new SharedArrayBuffer(spec.bytes);
    if (this.fault === "short") return new ArrayBuffer(spec.bytes - 1);
    return new ArrayBuffer(spec.bytes);
  }
  grow(): void {
    throw new Error("namespace backing must not grow");
  }
}

function rig(options: { room?: number; records?: MemoryRecords; serialLimit?: number } = {}) {
  const allocator = new Allocator();
  const configuration = {
    bytes: 65536,
    producers: options.records ?? records,
    progress: { bytes: 0, allocations: 0, references: 0, leases: 0 },
    waiters: 0,
    serialLimit: options.serialLimit ?? Number.MAX_SAFE_INTEGER,
  };
  const probe = new MemoryBudget(configuration);
  const overhead = probe.snapshot().allocated;
  probe.close();
  const budget = new MemoryBudget(
    { ...configuration, bytes: overhead + (options.room ?? 4096) },
    allocator,
  );
  allocator.budget = budget;
  return { budget, allocator };
}
function construct(budget: MemoryBudget): NamespaceProjectionTable {
  return new NamespaceProjectionTable(capacity, budget);
}
function failure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected namespace construction to fail");
}
function granted(budget: MemoryBudget, demand: Parameters<MemoryBudget["tryOperation"]>[0]) {
  const admission = budget.tryOperation(demand);
  if (admission.kind !== "granted") throw new Error(`unexpected ${admission.kind}`);
  return admission.lease;
}
function usage(snapshot: Snapshot) {
  return {
    limit: snapshot.limit,
    backingBytes: snapshot.backingBytes,
    metadataUnits: snapshot.metadataUnits,
    nativeAllowance: snapshot.nativeAllowance,
    allocated: snapshot.allocated,
    obligations: snapshot.obligations,
    reserve: snapshot.reserve,
    stopped: snapshot.stopped,
    waiting: snapshot.waiting,
    producerFree: snapshot.producerFree,
    progressFree: snapshot.progressFree,
  };
}
function expectCharged(before: Snapshot, budget: MemoryBudget, count = 1): void {
  expect(budget.snapshot()).toMatchObject({
    backingBytes: before.backingBytes + count * backingBytes,
    allocated: before.allocated + count * backingBytes,
    obligations: before.obligations,
    producerFree: {
      allocations: before.producerFree.allocations - count,
      references: before.producerFree.references - count,
      leases: before.producerFree.leases - count,
    },
  });
}

const denials = ["bytes", "allocations", "references", "leases"] as const;
test.each(denials)("namespace impossible %p denial allocates nothing", (field) => {
  const constrained = { ...records, [field]: 0 };
  const { budget, allocator } = rig(
    field === "bytes" ? { room: backingBytes - 1 } : { records: constrained },
  );
  try {
    const before = budget.snapshot();
    expect(failure(() => construct(budget))).toEqual(new MemoryBudgetError("capacity"));
    expect(allocator.specs).toHaveLength(0);
    expect(budget.snapshot()).toEqual(before);
  } finally {
    budget.close();
  }
});
test.each(denials)("namespace pressured %p denial preserves existing demand", (field) => {
  const { budget, allocator } = rig({ room: backingBytes });
  const held = granted(budget, {
    bytes: field === "bytes" ? backingBytes : 0,
    allocations: field === "allocations" ? records.allocations : 0,
    references: field === "references" ? records.references : 0,
    leases: field === "leases" ? 1 : 0,
  });
  try {
    const before = budget.snapshot();
    expect(failure(() => construct(budget))).toEqual(new MemoryBudgetError("capacity"));
    expect(allocator.specs).toHaveLength(0);
    expect(budget.snapshot()).toEqual(before);
  } finally {
    held.close();
    budget.close();
  }
});
test.each(["serial", "closed"] as const)("namespace %p authority allocates nothing", (code) => {
  const { budget, allocator } = rig({ serialLimit: code === "serial" ? 2 : undefined });
  if (code === "closed") budget.close();
  try {
    const before = budget.snapshot();
    expect(failure(() => construct(budget))).toEqual(new MemoryBudgetError(code));
    expect(allocator.specs).toHaveLength(0);
    expect(budget.snapshot()).toEqual(before);
  } finally {
    budget.close();
  }
});

test("namespace reserves the complete backing before allocation", () => {
  const { budget, allocator } = rig({ room: backingBytes });
  const admit = spyOn(budget, "tryOperation");
  try {
    const before = budget.snapshot();
    const table = construct(budget);
    expect(admit.mock.calls).toEqual([[plan]]);
    expect(allocator.specs).toEqual([{ kind: "array", bytes: backingBytes }]);
    expect(allocator.snapshots).toHaveLength(1);
    expect(allocator.snapshots[0]).toMatchObject({
      backingBytes: before.backingBytes + backingBytes,
      obligations: before.obligations,
      producerFree: { allocations: 3, references: 3, leases: 1 },
    });
    expect(table.allocation()).toMatchObject({ backingBytes, chargedBytes: 8349 });
    expectCharged(before, budget);
  } finally {
    admit.mockRestore();
    budget.close();
  }
});

test.each(["throw", "shared", "short"] as const)(
  "namespace unpublished %p failure rolls back allocation and records",
  (fault) => {
    const { budget, allocator } = rig();
    allocator.fault = fault;
    try {
      const before = budget.snapshot();
      const error = failure(() => construct(budget));
      if (fault === "throw") expect(error).toBe(reason);
      else expect(error).toBeInstanceOf(TypeError);
      expect(allocator.specs).toHaveLength(1);
      expect(usage(budget.snapshot())).toEqual(usage(before));
    } finally {
      budget.close();
    }
  },
);
test("namespace registration failure rolls back the completed construction", () => {
  const { budget, allocator } = rig();
  const nativeSet = WeakMap.prototype.set;
  let registry: unknown;
  const registration = spyOn(WeakMap.prototype, "set").mockImplementation(function (
    this: WeakMap<object, unknown>,
    key: object,
    value: unknown,
  ) {
    if (key !== budget) return nativeSet.call(this, key, value);
    registry = value;
    throw reason;
  });
  try {
    const before = budget.snapshot();
    expect(failure(() => construct(budget))).toBe(reason);
    expect(allocator.specs).toHaveLength(1);
    expect(registry).toBeInstanceOf(Set);
    if (!(registry instanceof Set)) throw new Error("missing private registry");
    expect(registry.size).toBe(0);
    expect(usage(budget.snapshot())).toEqual(usage(before));
  } finally {
    registration.mockRestore();
    budget.close();
  }
});

test("namespace published backings remain charged through aliases and budget close", () => {
  const { budget, allocator } = rig({ room: 2 * backingBytes });
  try {
    const before = budget.snapshot();
    const table = construct(budget);
    const alias = (table as unknown as { readonly backing: ArrayBuffer }).backing;
    construct(budget);
    expectCharged(before, budget, 2);
    expect(alias.byteLength).toBe(backingBytes);
    budget.close();
    expectCharged(before, budget, 2);
    expect(alias.byteLength).toBe(backingBytes);
    const stopped = budget.snapshot();
    expect(failure(() => construct(budget))).toEqual(new MemoryBudgetError("closed"));
    expect(allocator.specs).toHaveLength(2);
    expect(budget.snapshot()).toEqual(stopped);
  } finally {
    budget.close();
  }
});
test("namespace construction without a budget preserves allocation behavior", () => {
  const { budget, allocator } = rig();
  try {
    const before = budget.snapshot();
    const table = new NamespaceProjectionTable(capacity);
    expect(table.allocation()).toMatchObject({ backingBytes, chargedBytes: 8349 });
    expect(allocator.specs).toHaveLength(0);
    expect(budget.snapshot()).toEqual(before);
  } finally {
    budget.close();
  }
});
