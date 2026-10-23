import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import {
  MemoryBudget,
  MemoryBudgetError,
  type MemoryAllocator,
  type MemoryBacking,
  type MemoryBackingSpec,
  type MemoryBudgetLimits,
  type MemoryCharge,
  type MemoryLease,
  type MemoryPlan,
  type MemoryRecords,
  type MemoryReference,
} from "../fs/memory-budget";

const producerRecords: MemoryRecords = { allocations: 8, references: 16, leases: 8 };
const progressRecords: MemoryRecords = { allocations: 2, references: 4, leases: 2 };
const emptyPlan: MemoryPlan = { bytes: 0, allocations: 0, references: 0, leases: 0 };

function footprint(
  producers: MemoryRecords,
  progress: MemoryRecords,
  waiters: number,
): MemoryCharge {
  const allocations = producers.allocations + progress.allocations;
  const references = producers.references + progress.references;
  const leases = producers.leases + progress.leases;
  return {
    backingBytes: (allocations * 6 + references * 3 + leases * 9) * 8,
    metadataUnits: 256 + allocations * 128 + references * 128 + leases * 512 + waiters * 256,
    nativeAllowance: 0,
  };
}
function realShared(bytes: number, maximum: number): SharedArrayBuffer {
  const buffer: unknown = Reflect.construct(SharedArrayBuffer, [bytes, { maxByteLength: maximum }]);
  if (!(buffer instanceof SharedArrayBuffer)) throw new Error("expected shared backing");
  return buffer;
}
function realGrow(buffer: SharedArrayBuffer, bytes: number): void {
  if (!("grow" in buffer) || typeof buffer.grow !== "function") throw new Error("grow unavailable");
  buffer.grow(bytes);
}
function failure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to throw");
}
function granted(admission: ReturnType<MemoryBudget["tryOperation"]>): MemoryLease {
  if (admission.kind !== "granted") throw new Error(`expected grant, got ${admission.kind}`);
  return admission.lease;
}

class AllocationOracle implements MemoryAllocator {
  budget: MemoryBudget | null = null;
  readonly buffers = new Set<ArrayBuffer | SharedArrayBuffer>();
  readonly declared = new Set<MemoryCharge>();
  calls = 0;
  grows = 0;
  beforeAllocate: (() => void) | null = null;
  beforeGrow: (() => void) | null = null;
  afterGrow: (() => void) | null = null;
  constructor(readonly baseline: MemoryCharge) {}
  allocate(spec: MemoryBackingSpec): ArrayBuffer | SharedArrayBuffer {
    this.calls++;
    this.check(spec.bytes);
    this.beforeAllocate?.();
    const buffer =
      spec.kind === "array" ? new ArrayBuffer(spec.bytes) : realShared(spec.bytes, spec.maximum);
    this.buffers.add(buffer);
    this.check();
    return buffer;
  }
  grow(buffer: SharedArrayBuffer, bytes: number): void {
    this.grows++;
    this.check(bytes - buffer.byteLength);
    this.beforeGrow?.();
    realGrow(buffer, bytes);
    this.check();
    this.afterGrow?.();
  }
  drop(backing: MemoryBacking): void {
    expect(this.buffers.delete(backing.buffer)).toBe(true);
  }
  check(additionalBacking = 0): void {
    if (!this.budget) throw new Error("oracle not attached");
    const state = this.budget.snapshot();
    const physical = Array.from(this.buffers, (buffer) => buffer.byteLength).reduce(
      (a, b) => a + b,
      0,
    );
    const metadata = Array.from(this.declared, (charge) => charge.metadataUnits).reduce(
      (a, b) => a + b,
      0,
    );
    const native = Array.from(this.declared, (charge) => charge.nativeAllowance).reduce(
      (a, b) => a + b,
      0,
    );
    expect(state.backingBytes).toBe(this.baseline.backingBytes + physical + additionalBacking);
    expect(state.metadataUnits).toBe(this.baseline.metadataUnits + metadata);
    expect(state.nativeAllowance).toBe(native);
    expect(state.allocated + state.obligations + state.reserve).toBeLessThanOrEqual(state.limit);
  }
}
function rig(
  options: {
    room?: number;
    reserve?: number;
    producers?: MemoryRecords;
    progress?: MemoryRecords;
    waiters?: number;
    serialLimit?: number;
  } = {},
) {
  const producers = options.producers ?? producerRecords;
  const progress = options.progress ?? progressRecords;
  const waiters = options.waiters ?? 2;
  const baseline = footprint(producers, progress, waiters);
  const reserve = options.reserve ?? 8;
  const limits: MemoryBudgetLimits = {
    bytes: baseline.backingBytes + baseline.metadataUnits + (options.room ?? 64) + reserve,
    producers,
    progress: { ...progress, bytes: reserve },
    waiters,
    serialLimit: options.serialLimit ?? Number.MAX_SAFE_INTEGER,
  };
  const oracle = new AllocationOracle(baseline);
  const budget = new MemoryBudget(limits, oracle);
  oracle.budget = budget;
  oracle.check();
  return { budget, oracle, limits, baseline };
}
function operation(
  budget: MemoryBudget,
  bytes: number,
  records: Partial<MemoryRecords> = {},
): MemoryLease {
  return granted(
    budget.tryOperation({ bytes, allocations: 1, references: 1, leases: 0, ...records }),
  );
}
function release(
  oracle: AllocationOracle,
  lease: MemoryLease,
  ref: MemoryReference,
  backing: MemoryBacking,
): void {
  expect(lease.release(ref)).toBe(true);
  oracle.drop(backing);
  oracle.check();
}

test("bootstrap funds all numeric table backing, JS control units and nonborrowable reserve", () => {
  const { budget, limits, baseline, oracle } = rig({ room: 0 });
  expect(budget.snapshot()).toMatchObject({
    backingBytes: baseline.backingBytes,
    metadataUnits: baseline.metadataUnits,
    reserve: 8,
    obligations: 0,
    producerFree: producerRecords,
    progressFree: progressRecords,
  });
  expect(() => new MemoryBudget({ ...limits, bytes: limits.bytes - 1 }, oracle)).toThrow(
    MemoryBudgetError,
  );
  expect(oracle.calls).toBe(0);
  expect(budget.tryOperation({ ...emptyPlan, bytes: 1 }).kind).toBe("impossible");
  const progress = granted(budget.tryProgress({ ...emptyPlan, bytes: 8 }));
  oracle.check();
  progress.close();
  oracle.check();
});

test("whole-operation preflight prevents the third copy rather than allocating a prefix", () => {
  const { budget, oracle } = rig({ room: 12 });
  const tooLarge = { bytes: 13, allocations: 3, references: 3, leases: 0 };
  expect(budget.tryOperation(tooLarge).kind).toBe("impossible");
  expect(oracle.calls).toBe(0);
  const lease = operation(budget, 12, { allocations: 3, references: 3 });
  const copies = Array.from({ length: 3 }, () => lease.allocate({ kind: "array", bytes: 4 }));
  expect(new Set(copies.map((copy) => copy.ref.allocation)).size).toBe(3);
  oracle.check();
  expect(budget.tryOperation({ ...emptyPlan, bytes: 1 }).kind).toBe("pressure");
  expect(failure(() => lease.allocate({ kind: "array", bytes: 1 }))).toMatchObject({
    code: "capacity",
  });
  expect(oracle.calls).toBe(3);
  lease.close();
  for (const copy of copies) release(oracle, lease, copy.ref, copy.backing);
  expect(budget.snapshot().producerFree).toEqual(producerRecords);
});

test("same backing aliases charge once, duplicate and stale releases cannot retire another reference", () => {
  const { budget, oracle } = rig({ room: 24 });
  const writer = operation(budget, 24, { references: 4, leases: 1 });
  const owned = writer.allocate({ kind: "shared", bytes: 8, maximum: 24 });
  const first = writer.retain(owned.ref);
  const second = writer.retain(owned.ref);
  expect(new Uint8Array(owned.backing.buffer, 2, 1).buffer).toBe(owned.backing.buffer);
  expect(first).not.toBe(second);
  expect(first.allocation).toBe(owned.ref.allocation);
  expect(second.allocation).toBe(owned.ref.allocation);
  oracle.check();
  expect(writer.release(owned.ref)).toBe(true);
  expect(writer.release(owned.ref)).toBe(false);
  oracle.check();
  writer.grow(owned.backing, first, 16);
  oracle.check();
  const reader = writer.delegate({ bytes: 0, allocations: 0, references: 1, leases: 0 });
  const held = reader.retain(second);
  writer.close();
  expect(writer.release(first)).toBe(true);
  expect(writer.release(second)).toBe(true);
  oracle.check();
  reader.close();
  release(oracle, reader, held, owned.backing);
  const replacement = operation(budget, 8);
  const newer = replacement.allocate({ kind: "array", bytes: 8 });
  expect(writer.release(owned.ref)).toBe(false);
  expect(replacement.release(held)).toBe(false);
  oracle.check();
  replacement.close();
  release(oracle, replacement, newer.ref, newer.backing);
});

test("foreign authorities, wrong owners and mismatched backing handles cannot release or grow", () => {
  const left = rig();
  const right = rig();
  const owner = operation(left.budget, 8);
  const stranger = operation(left.budget, 8);
  const foreign = operation(right.budget, 8);
  const a = owner.allocate({ kind: "shared", bytes: 4, maximum: 8 });
  const b = stranger.allocate({ kind: "shared", bytes: 4, maximum: 8 });
  expect(stranger.release(a.ref)).toBe(false);
  expect(foreign.release(a.ref)).toBe(false);
  expect(failure(() => foreign.retain(a.ref))).toMatchObject({ code: "reference" });
  expect(failure(() => owner.grow(b.backing, a.ref, 8))).toMatchObject({ code: "reference" });
  expect(Object.keys(a.ref)).not.toContain("key");
  left.oracle.check();
  owner.close();
  stranger.close();
  foreign.close();
  release(left.oracle, owner, a.ref, a.backing);
  release(left.oracle, stranger, b.ref, b.backing);
  right.oracle.check();
});

test("child transfer and closed parent observation leave live child and allocation ownership intact", () => {
  const { budget, oracle } = rig({ room: 20 });
  const parent = operation(budget, 20, { allocations: 2, references: 2, leases: 2 });
  const child = parent.delegate({ bytes: 12, allocations: 1, references: 1, leases: 1 });
  const grandchild = child.delegate({ bytes: 8, allocations: 1, references: 1, leases: 0 });
  const before = budget.snapshot();
  parent.close();
  parent.close();
  child.close();
  expect(budget.snapshot().obligations).toBe(8);
  expect(before.obligations).toBe(20);
  const owned = grandchild.allocate({ kind: "array", bytes: 8 });
  grandchild.close();
  oracle.check();
  expect(budget.snapshot().obligations).toBe(0);
  release(oracle, grandchild, owned.ref, owned.backing);
  expect(budget.snapshot().producerFree).toEqual(producerRecords);
});

test.each([undefined, null, false, 0, "", new Error("constructor")])(
  "constructor failure preserves thrown identity and refunds only unmaterialized demand: %p",
  (reason) => {
    const { budget, oracle } = rig({ room: 8 });
    const lease = operation(budget, 8);
    oracle.beforeAllocate = () => {
      throw reason;
    };
    const before = budget.snapshot();
    expect(
      Object.is(
        failure(() => lease.allocate({ kind: "array", bytes: 8 })),
        reason,
      ),
    ).toBe(true);
    oracle.check();
    expect(budget.snapshot().obligations).toBe(before.obligations);
    expect(budget.snapshot().producerFree).toEqual(before.producerFree);
    oracle.beforeAllocate = null;
    const owned = lease.allocate({ kind: "array", bytes: 8 });
    lease.close();
    release(oracle, lease, owned.ref, owned.backing);
    expect(budget.snapshot().producerFree).toEqual(producerRecords);
  },
);

test("constructor reentry may close its lease, but cannot reclaim pending backing or consume returned slots", () => {
  const { budget, oracle } = rig({
    room: 8,
    producers: { allocations: 1, references: 1, leases: 1 },
  });
  const lease = operation(budget, 8);
  oracle.beforeAllocate = () => {
    lease.close();
    expect(budget.tryOperation({ ...emptyPlan, bytes: 8 }).kind).toBe("pressure");
    expect(failure(() => lease.allocate({ kind: "array", bytes: 0 }))).toMatchObject({
      code: "closed",
    });
    oracle.check(8);
  };
  const owned = lease.allocate({ kind: "array", bytes: 8 });
  oracle.check();
  expect(budget.snapshot().producerFree.leases).toBe(0);
  release(oracle, lease, owned.ref, owned.backing);
  expect(budget.snapshot().producerFree).toEqual({ allocations: 1, references: 1, leases: 1 });
});

test("failed constructor after root close releases its pending record without reopening escrow", () => {
  const { budget, oracle } = rig({ room: 8 });
  const lease = operation(budget, 8);
  const reason = new Error("closed constructor");
  oracle.beforeAllocate = () => {
    budget.close();
    oracle.check(8);
    throw reason;
  };
  expect(failure(() => lease.allocate({ kind: "array", bytes: 8 }))).toBe(reason);
  oracle.check();
  expect(budget.snapshot().obligations).toBe(0);
  expect(budget.snapshot().producerFree).toEqual(producerRecords);
});

test("growth failure refunds the delta; successful growth remains charged after a later failure", () => {
  const { budget, oracle } = rig({ room: 24 });
  const lease = operation(budget, 24);
  const owned = lease.allocate({ kind: "shared", bytes: 4, maximum: 16 });
  expect(failure(() => lease.grow(owned.backing, owned.ref, 20))).toBeInstanceOf(RangeError);
  oracle.check();
  expect(budget.snapshot().obligations).toBe(20);
  const reason = new Error("after growth");
  oracle.afterGrow = () => {
    throw reason;
  };
  expect(failure(() => lease.grow(owned.backing, owned.ref, 12))).toBe(reason);
  expect(owned.backing.buffer.byteLength).toBe(12);
  oracle.check();
  lease.close();
  expect(budget.snapshot().obligations).toBe(0);
  oracle.check();
  release(oracle, lease, owned.ref, owned.backing);
});

test("growth reentry pins physical ownership until grow returns, even after release and root close", () => {
  const { budget, oracle } = rig({
    room: 16,
    producers: { allocations: 1, references: 1, leases: 1 },
  });
  const lease = operation(budget, 16);
  const owned = lease.allocate({ kind: "shared", bytes: 4, maximum: 16 });
  oracle.beforeGrow = () => {
    expect(failure(() => lease.grow(owned.backing, owned.ref, 8))).toMatchObject({ code: "busy" });
    expect(lease.release(owned.ref)).toBe(true);
    budget.close();
    expect(budget.snapshot().producerFree.allocations).toBe(0);
    expect(budget.snapshot().producerFree.leases).toBe(0);
    oracle.check(8);
  };
  lease.grow(owned.backing, owned.ref, 12);
  oracle.drop(owned.backing);
  oracle.check();
  expect(budget.snapshot().producerFree).toEqual({ allocations: 1, references: 1, leases: 1 });
  expect(lease.release(owned.ref)).toBe(false);
});

test("last release restores escrow for retry without competing for root admission", () => {
  const { budget, oracle } = rig({ room: 8 });
  const lease = operation(budget, 8);
  const owned = lease.allocate({ kind: "array", bytes: 8 });
  release(oracle, lease, owned.ref, owned.backing);
  expect(budget.snapshot().obligations).toBe(8);
  expect(budget.tryOperation({ ...emptyPlan, bytes: 1 }).kind).toBe("pressure");
  const retry = lease.allocate({ kind: "array", bytes: 8 });
  expect(retry.ref.allocation).not.toBe(owned.ref.allocation);
  expect(lease.release(owned.ref)).toBe(false);
  lease.close();
  release(oracle, lease, retry.ref, retry.backing);
});

test("declared metadata and native allowances remain distinct from measured backing", () => {
  const { budget, oracle } = rig({ room: 12 });
  const lease = operation(budget, 12);
  const charge = { backingBytes: 0, metadataUnits: 5, nativeAllowance: 7 };
  const ref = lease.account(charge);
  oracle.declared.add(charge);
  oracle.check();
  lease.close();
  oracle.check();
  expect(lease.release(ref)).toBe(true);
  oracle.declared.delete(charge);
  oracle.check();
});

test("progress byte and record reserves cannot be borrowed by producers or alias transfers", () => {
  const { budget, oracle } = rig({
    room: 8,
    reserve: 8,
    producers: { allocations: 1, references: 1, leases: 1 },
  });
  const producer = operation(budget, 8);
  const a = producer.allocate({ kind: "array", bytes: 8 });
  const progress = granted(
    budget.tryProgress({ bytes: 8, allocations: 1, references: 1, leases: 0 }),
  );
  const b = progress.allocate({ kind: "array", bytes: 8 });
  expect(budget.tryProgress({ bytes: 8, allocations: 1, references: 1, leases: 0 }).kind).toBe(
    "pressure",
  );
  expect(failure(() => producer.retain(b.ref))).toMatchObject({ code: "reference" });
  producer.close();
  progress.close();
  oracle.check();
  release(oracle, progress, b.ref, b.backing);
  expect(budget.snapshot().reserve).toBe(8);
  release(oracle, producer, a.ref, a.backing);
  budget.close();
  oracle.check();
  expect(budget.snapshot().reserve).toBe(0);
});

test.each(["allocations", "references", "leases"])(
  "bounded %s credits reject before construction and recover after close",
  (field) => {
    const producers = { allocations: 2, references: 2, leases: 2, [field]: 1 };
    const { budget, oracle } = rig({ producers });
    const lease = operation(budget, 1);
    const before = budget.snapshot();
    expect(budget.tryOperation({ bytes: 1, allocations: 1, references: 1, leases: 0 }).kind).toBe(
      "pressure",
    );
    expect(oracle.calls).toBe(0);
    expect(budget.snapshot()).toEqual(before);
    expect(budget.tryOperation({ ...emptyPlan, [field]: 3 }).kind).toBe("impossible");
    lease.close();
    expect(budget.snapshot().producerFree).toEqual(producers);
  },
);

test("reserved record shortages cannot consume bytes, delegate children or call an allocator", () => {
  const { budget, oracle } = rig();
  const lease = operation(budget, 8, { allocations: 0, references: 0 });
  const before = budget.snapshot();
  expect(failure(() => lease.allocate({ kind: "array", bytes: 8 }))).toMatchObject({
    code: "records",
  });
  expect(failure(() => lease.delegate(emptyPlan))).toMatchObject({ code: "records" });
  expect(budget.snapshot()).toEqual(before);
  expect(oracle.calls).toBe(0);
  lease.close();
});

test("serial exhaustion rejects without wraparound or stale-token ABA", () => {
  const { budget, oracle } = rig({ serialLimit: 3, room: 4 });
  const lease = operation(budget, 4);
  const owned = lease.allocate({ kind: "array", bytes: 4 });
  release(oracle, lease, owned.ref, owned.backing);
  const before = budget.snapshot();
  expect(failure(() => lease.allocate({ kind: "array", bytes: 4 }))).toMatchObject({
    code: "serial",
  });
  expect(budget.snapshot()).toEqual(before);
  expect(oracle.calls).toBe(1);
  lease.close();
  expect(budget.tryOperation(emptyPlan).kind).toBe("exhausted");
  expect(lease.release(owned.ref)).toBe(false);
  oracle.check();
});

test("safe-integer boundaries reject invalid demand, counts and overflowing charges without effects", () => {
  const { budget, oracle, limits } = rig();
  const lease = operation(budget, 4);
  for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => budget.tryOperation({ ...emptyPlan, bytes: value })).toThrow(RangeError);
    expect(() => lease.allocate({ kind: "array", bytes: value })).toThrow(RangeError);
    expect(() => new MemoryBudget({ ...limits, waiters: value })).toThrow(RangeError);
    oracle.check();
  }
  expect(() => budget.tryOperation({ ...emptyPlan, allocations: 65_537 })).toThrow(RangeError);
  expect(() =>
    lease.account({ metadataUnits: Number.MAX_SAFE_INTEGER, nativeAllowance: 1 }),
  ).toThrow(RangeError);
  expect(oracle.calls).toBe(0);
  lease.close();
});

test("bounded waiting observes capacity changes, removes abort listeners and preserves falsy reasons", async () => {
  const { budget, oracle } = rig({ waiters: 1 });
  const first = new AbortController();
  const changed = budget.snapshot().changed;
  const pending = budget.observe(changed, first.signal);
  const observed = pending.then(
    () => ({ kind: "resolved" }),
    (reason: unknown) => ({ kind: "rejected", reason }),
  );
  expect(budget.snapshot().waiting).toBe(1);
  await expect(budget.observe(changed, new AbortController().signal)).rejects.toMatchObject({
    code: "records",
  });
  first.abort(false);
  expect(await observed).toEqual({ kind: "rejected", reason: false });
  expect(budget.snapshot().waiting).toBe(0);
  const next = budget.observe(changed, new AbortController().signal);
  first.signal.dispatchEvent(new Event("abort"));
  expect(budget.snapshot().waiting).toBe(1);
  const lease = operation(budget, 1);
  lease.close();
  await next;
  expect(budget.snapshot().waiting).toBe(0);
  await budget
    .observe(changed, first.signal)
    .catch((reason: unknown) => expect(reason).toBe(false));
  await budget.observe(changed, new AbortController().signal);
  oracle.check();
});

test("root close rejects observations but never frees a live allocation or its later release", async () => {
  const { budget, oracle } = rig({ room: 8 });
  const lease = operation(budget, 8);
  const owned = lease.allocate({ kind: "array", bytes: 4 });
  const pending = budget.observe(budget.snapshot().changed, new AbortController().signal);
  const observed = pending.catch((reason: unknown) => reason);
  budget.close();
  budget.close();
  expect(await observed).toMatchObject({ code: "closed" });
  expect(budget.snapshot()).toMatchObject({
    obligations: 0,
    reserve: 0,
    waiting: 0,
    stopped: true,
  });
  oracle.check();
  expect(budget.tryOperation(emptyPlan).kind).toBe("stopped");
  expect(budget.tryProgress(emptyPlan).kind).toBe("stopped");
  expect(failure(() => lease.retain(owned.ref))).toMatchObject({ code: "closed" });
  release(oracle, lease, owned.ref, owned.backing);
  expect(budget.snapshot().producerFree).toEqual(producerRecords);
});

test("independent negative controls detect duplicate alias charging, omitted copies and early ownership release", () => {
  const { budget, oracle, baseline } = rig({ room: 8 });
  const lease = operation(budget, 8, { allocations: 2, references: 3 });
  const a = lease.allocate({ kind: "array", bytes: 4 });
  const alias = lease.retain(a.ref);
  const b = lease.allocate({ kind: "array", bytes: 4 });
  oracle.check();
  const actual = budget.snapshot().backingBytes;
  oracle.buffers.add(a.backing.buffer);
  oracle.check();
  expect(oracle.buffers.size).toBe(2);
  const unadmittedCopy = new ArrayBuffer(4);
  oracle.buffers.add(unadmittedCopy);
  expect(() => oracle.check()).toThrow();
  oracle.buffers.delete(unadmittedCopy);
  oracle.buffers.delete(a.backing.buffer);
  expect(() => oracle.check()).toThrow();
  oracle.buffers.add(a.backing.buffer);
  expect(actual).toBe(baseline.backingBytes + 8);
  lease.close();
  expect(lease.release(a.ref)).toBe(true);
  expect(budget.snapshot().backingBytes).toBe(actual);
  oracle.check();
  release(oracle, lease, alias, a.backing);
  release(oracle, lease, b.ref, b.backing);
});

test("deterministic repeated allocation transitions reuse bounded records without retaining old references", () => {
  const capacities = { allocations: 1, references: 2, leases: 1 };
  const { budget, oracle } = rig({ room: 32, producers: capacities });
  let previous: MemoryReference | null = null;
  for (let index = 0; index < 200; index++) {
    const bytes = ((index * 17 + 3) % 32) + 1;
    const lease = operation(budget, bytes, { references: 2 });
    const owned = lease.allocate({ kind: "array", bytes });
    const alias = lease.retain(owned.ref);
    if (previous) expect(lease.release(previous)).toBe(false);
    expect(lease.release(owned.ref)).toBe(true);
    oracle.check();
    lease.close();
    release(oracle, lease, alias, owned.backing);
    expect(budget.snapshot().producerFree).toEqual(capacities);
    previous = owned.ref;
  }
  expect(oracle.buffers.size).toBe(0);
});

test("default fixed constructors and shared growth own real backing without an injected allocator", () => {
  const setup = rig({ room: 32 });
  const budget = new MemoryBudget(setup.limits);
  const oracle = new AllocationOracle(setup.baseline);
  oracle.budget = budget;
  const lease = operation(budget, 32, { allocations: 2, references: 2 });
  const array = lease.allocate({ kind: "array", bytes: 8 });
  oracle.buffers.add(array.backing.buffer);
  oracle.check();
  const shared = lease.allocate({ kind: "shared", bytes: 4, maximum: 16 });
  oracle.buffers.add(shared.backing.buffer);
  oracle.check();
  lease.grow(shared.backing, shared.ref, 16);
  oracle.check();
  expect(() => lease.grow(shared.backing, shared.ref, 20)).toThrow(RangeError);
  oracle.check();
  lease.close();
  release(oracle, lease, array.ref, array.backing);
  release(oracle, lease, shared.ref, shared.backing);
});

test("input getter reentry completes before numeric state transitions", () => {
  const { budget, oracle } = rig();
  const lease = operation(budget, 8);
  const spec: MemoryBackingSpec = {
    kind: "array",
    get bytes() {
      lease.close();
      return 8;
    },
  };
  expect(failure(() => lease.allocate(spec))).toMatchObject({ code: "closed" });
  expect(oracle.calls).toBe(0);
  oracle.check();
});

test("one admitted operation cannot spend another operation's reserved serials", () => {
  const { budget, oracle } = rig({ serialLimit: 6, room: 8 });
  const first = operation(budget, 4);
  const second = operation(budget, 4);
  expect(budget.tryOperation(emptyPlan).kind).toBe("exhausted");
  const a = first.allocate({ kind: "array", bytes: 4 });
  release(oracle, first, a.ref, a.backing);
  expect(failure(() => first.allocate({ kind: "array", bytes: 4 }))).toMatchObject({
    code: "serial",
  });
  const b = second.allocate({ kind: "array", bytes: 4 });
  first.close();
  second.close();
  release(oracle, second, b.ref, b.backing);
  expect(budget.snapshot().producerFree).toEqual(producerRecords);
});

const observerFailures: readonly unknown[] = [
  undefined, null, false, 0, -0, 0n, NaN, "", new Error("observer hook"),
];

function observed(pending: Promise<void>) {
  return pending.then(
    () => ({ kind: "resolved" }),
    (reason: unknown) => ({ kind: "rejected", reason }),
  );
}
function replayAbort(listener: EventListenerOrEventListenerObject, signal: AbortSignal): void {
  const event = new Event("abort");
  if (typeof listener === "function") listener.call(signal, event);
  else listener.handleEvent(event);
}
async function failedRegistration(reason: unknown, install: boolean): Promise<void> {
  const { budget, oracle } = rig({ waiters: 1 });
  const signal = new AbortController().signal;
  const nativeAdd = signal.addEventListener.bind(signal);
  const callbacks: EventListenerOrEventListenerObject[] = [];
  signal.addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (listener) callbacks.push(listener);
    if (install && listener) nativeAdd(type, listener, options);
    throw reason;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(failure(() => budget.observe(budget.snapshot().changed, signal))).toBe(reason);
    expect(budget.snapshot().waiting).toBe(0);
  }
  const next = observed(budget.observe(budget.snapshot().changed, new AbortController().signal));
  for (const callback of callbacks) replayAbort(callback, signal);
  signal.dispatchEvent(new Event("abort"));
  expect(budget.snapshot().waiting).toBe(1);
  operation(budget, 0).close();
  expect(await next).toEqual({ kind: "resolved" });
  expect(budget.snapshot().waiting).toBe(0);
  budget.close();
  oracle.check();
}

test.each(observerFailures)("ledger observer registration rolls back arbitrary throws %p", async (reason) => {
  await failedRegistration(reason, false);
  await failedRegistration(reason, true);
});

test.each(observerFailures)("ledger observer cleanup cannot strand close or throw %p", async (reason) => {
  const { budget, oracle } = rig({ waiters: 2 });
  operation(budget, 8);
  operation(budget, 8);
  const signal = new AbortController().signal;
  let cleanupCalls = 0;
  signal.removeEventListener = () => { cleanupCalls++; throw reason; };
  const outcomes: unknown[] = [];
  void observed(budget.observe(budget.snapshot().changed, signal)).then((value) => outcomes.push(value));
  void observed(budget.observe(budget.snapshot().changed, new AbortController().signal)).then((value) => outcomes.push(value));
  expect(() => budget.close()).not.toThrow();
  budget.close();
  await Promise.resolve();
  await Promise.resolve();
  expect(outcomes).toHaveLength(2);
  expect(outcomes).toEqual([
    { kind: "rejected", reason: expect.objectContaining({ code: "closed" }) },
    { kind: "rejected", reason: expect.objectContaining({ code: "closed" }) },
  ]);
  expect(cleanupCalls).toBe(1);
  expect(budget.snapshot()).toMatchObject({ stopped: true, waiting: 0, obligations: 0, reserve: 0 });
  expect(budget.snapshot().producerFree).toEqual(producerRecords);
  oracle.check();
});

async function allocatorFailureWithCleanup(reason: unknown, mode: "allocate" | "beforeGrow" | "afterGrow"): Promise<void> {
  const { budget, oracle } = rig({ room: 16, waiters: 1 });
  const lease = operation(budget, 16);
  const owned = mode === "allocate" ? null : lease.allocate({ kind: "shared", bytes: 4, maximum: 16 });
  const signal = new AbortController().signal;
  signal.removeEventListener = () => { throw new Error("cleanup must not replace allocator error"); };
  const outcomes: unknown[] = [];
  void observed(budget.observe(budget.snapshot().changed, signal)).then((value) => outcomes.push(value));
  const throwReason = () => { throw reason; };
  if (mode === "allocate") oracle.beforeAllocate = throwReason;
  if (mode === "beforeGrow") oracle.beforeGrow = throwReason;
  if (mode === "afterGrow") oracle.afterGrow = throwReason;
  const run = () => owned ? lease.grow(owned.backing, owned.ref, 12) : lease.allocate({ kind: "array", bytes: 8 });
  expect(failure(run)).toBe(reason);
  await Promise.resolve();
  await Promise.resolve();
  expect(outcomes).toEqual([{ kind: "resolved" }]);
  expect(budget.snapshot().waiting).toBe(0);
  expect(owned?.backing.buffer.byteLength ?? 0).toBe(mode === "afterGrow" ? 12 : mode === "beforeGrow" ? 4 : 0);
  oracle.check();
  lease.close();
  if (owned) release(oracle, lease, owned.ref, owned.backing);
  budget.close();
}

test.each(observerFailures)("ledger observer cleanup preserves allocator and growth throws %p", async (reason) => {
  await allocatorFailureWithCleanup(reason, "allocate");
  await allocatorFailureWithCleanup(reason, "beforeGrow");
  await allocatorFailureWithCleanup(reason, "afterGrow");
});

function consumptionResults(lease: MemoryLease, ref: MemoryReference, backing: MemoryBacking): unknown[] {
  const attempts = [
    () => lease.allocate({ kind: "array", bytes: 1 }),
    () => lease.account({ metadataUnits: 1, nativeAllowance: 0 }),
    () => lease.retain(ref),
    () => lease.delegate(emptyPlan),
    () => lease.grow(backing, ref, 8),
  ];
  return attempts.map((attempt) => {
    try { attempt(); return "unexpected consumption"; }
    catch (reason) { return reason; }
  });
}

test("ledger observer reentrant cleanup fences every producer and progress lease before root drain", async () => {
  const { budget, oracle } = rig({ room: 32, reserve: 16 });
  operation(budget, 0);
  const producer = operation(budget, 16, { references: 2, leases: 1 });
  const progress = granted(budget.tryProgress({ bytes: 16, allocations: 1, references: 2, leases: 1 }));
  const a = producer.allocate({ kind: "shared", bytes: 4, maximum: 16 });
  const b = progress.allocate({ kind: "shared", bytes: 4, maximum: 16 });
  const signal = new AbortController().signal;
  let cleanupCalls = 0;
  const reentrant: unknown[] = [];
  signal.removeEventListener = () => {
    cleanupCalls++;
    reentrant.push(consumptionResults(producer, a.ref, a.backing));
    reentrant.push(consumptionResults(progress, b.ref, b.backing));
    budget.close();
    throw false;
  };
  const pending = observed(budget.observe(budget.snapshot().changed, signal));
  expect(() => budget.close()).not.toThrow();
  expect(cleanupCalls).toBe(1);
  expect(await pending).toMatchObject({ kind: "rejected", reason: { code: "closed" } });
  expect(budget.snapshot()).toMatchObject({ waiting: 0, obligations: 0, reserve: 0 });
  expect(oracle.calls).toBe(2);
  expect(oracle.grows).toBe(0);
  oracle.check();
  const closed = Array.from({ length: 5 }, () => expect.objectContaining({ code: "closed" }));
  expect(reentrant).toEqual([closed, closed]);
  expect(consumptionResults(producer, a.ref, a.backing)).toEqual(closed);
  expect(consumptionResults(progress, b.ref, b.backing)).toEqual(closed);
  release(oracle, producer, a.ref, a.backing);
  release(oracle, progress, b.ref, b.backing);
});

async function lateRegistration(action: "abort" | "close" | "notify", throws: boolean): Promise<void> {
  const { budget, oracle } = rig({ waiters: 1 });
  const lease = operation(budget, 0);
  const controller = new AbortController();
  const signal = controller.signal;
  const nativeAdd = signal.addEventListener.bind(signal);
  let cleanupCalls = 0;
  const registrationError = new Error("registration after reentry");
  signal.removeEventListener = () => { cleanupCalls++; throw null; };
  signal.addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (action === "abort") controller.abort(false);
    if (action === "close") budget.close();
    if (action === "notify") lease.close();
    if (listener) nativeAdd(type, listener, options);
    if (throws) throw registrationError;
  };
  if (throws) expect(failure(() => budget.observe(budget.snapshot().changed, signal))).toBe(registrationError);
  const outcomes: unknown[] = [];
  if (!throws) void observed(budget.observe(budget.snapshot().changed, signal)).then((value) => outcomes.push(value));
  await Promise.resolve();
  await Promise.resolve();
  if (!throws) expect(outcomes).toHaveLength(1);
  expect(budget.snapshot().waiting).toBe(0);
  expect(cleanupCalls).toBe(1);
  expect(getEventListeners(signal, "abort")).toHaveLength(0);
  signal.dispatchEvent(new Event("abort"));
  const next = observed(budget.observe(budget.snapshot().changed, new AbortController().signal));
  if (action !== "close") expect(budget.snapshot().waiting).toBe(1);
  signal.dispatchEvent(new Event("abort"));
  if (action !== "close") expect(budget.snapshot().waiting).toBe(1);
  budget.close();
  expect(await next).toMatchObject({ kind: "rejected", reason: { code: "closed" } });
  oracle.check();
}

test.each(["abort", "close", "notify"] satisfies ("abort" | "close" | "notify")[])(
  "ledger observer registration handles %s before late install and preserves registration error",
  async (action) => {
    await lateRegistration(action, false);
    await lateRegistration(action, true);
  },
);

test("ledger observer cleanup can reuse a slot without stale cancellation or same-epoch notification", async () => {
  const { budget, oracle } = rig({ waiters: 2 });
  const first = new AbortController();
  const signal = new AbortController().signal;
  const nativeAdd = signal.addEventListener.bind(signal);
  const saved: EventListenerOrEventListenerObject[] = [];
  signal.addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (listener) saved.push(listener);
    if (listener) nativeAdd(type, listener, options);
  };
  const initial = observed(budget.observe(budget.snapshot().changed, first.signal));
  const current = observed(budget.observe(budget.snapshot().changed, signal));
  first.abort(false);
  expect(await initial).toEqual({ kind: "rejected", reason: false });
  const next: Promise<unknown>[] = [];
  signal.removeEventListener = () => {
    next.push(observed(budget.observe(budget.snapshot().changed, signal)));
    next.push(observed(budget.observe(budget.snapshot().changed, signal)));
    for (const listener of saved.slice(0, 1)) replayAbort(listener, signal);
    throw 0;
  };
  operation(budget, 0).close();
  expect(budget.snapshot().waiting).toBe(2);
  expect(await current).toEqual({ kind: "resolved" });
  signal.removeEventListener = AbortSignal.prototype.removeEventListener;
  operation(budget, 0).close();
  expect(await Promise.all(next)).toEqual([{ kind: "resolved" }, { kind: "resolved" }]);
  expect(budget.snapshot().waiting).toBe(0);
  budget.close();
  oracle.check();
});
