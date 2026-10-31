import { expect, spyOn, test } from "bun:test";
import {
  MemoryBudget,
  MemoryBudgetError,
  type MemoryAllocator,
  type MemoryBackingSpec,
  type MemoryRecords,
} from "../fs/memory-budget";
import { parseFileIdentity } from "../fs/file-identity";
import { createPublicationBuffers, PublicationDomain } from "../fs/publication";
import type { CheckpointPublication } from "../fs/storage";
import type { PublicationBuffers, PublicationLimits } from "../fs/publication-internal";

const limits: PublicationLimits = {
  sessions: 2,
  operations: 2,
  argumentBytes: 256,
  inputBytes: 64,
  resultBytes: 128,
  effectBytes: 1024,
  effects: 4,
  logRecords: 2,
  logBytes: 2048,
  pins: 2,
  pinBytes: 128,
};
const records: MemoryRecords = { allocations: 32, references: 32, leases: 8 };
const reason = new Error("controlled publication construction failure");
type Snapshot = ReturnType<MemoryBudget["snapshot"]>;
type Fault =
  | { kind: "none" }
  | { kind: "throw"; at: number }
  | { kind: "shape"; at: number; shape: "array" | "short" };

function sizes(observe: boolean): number[] {
  const fixed = [44, 32, 72, 640, 256, 24, 2048, 24, 128, 49_152];
  return observe ? [98_304, 16].concat(fixed) : fixed;
}
function demand(observe: boolean) {
  const fields = sizes(observe);
  return {
    bytes: fields.reduce((total, bytes) => total + bytes, 0),
    allocations: fields.length,
    references: fields.length,
    leases: 0,
  };
}
function failure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected publication construction to fail");
}
function granted(budget: MemoryBudget, plan: Parameters<MemoryBudget["tryOperation"]>[0]) {
  const admission = budget.tryOperation(plan);
  if (admission.kind !== "granted") throw new Error(`unexpected ${admission.kind}`);
  return admission.lease;
}
function usage(snapshot: Snapshot) {
  return {
    allocated: snapshot.allocated,
    backingBytes: snapshot.backingBytes,
    metadataUnits: snapshot.metadataUnits,
    nativeAllowance: snapshot.nativeAllowance,
    obligations: snapshot.obligations,
    reserve: snapshot.reserve,
    waiting: snapshot.waiting,
    producerFree: snapshot.producerFree,
    progressFree: snapshot.progressFree,
  };
}
class Allocator implements MemoryAllocator {
  readonly specs: MemoryBackingSpec[] = [];
  readonly snapshots: Snapshot[] = [];
  budget: MemoryBudget | undefined;
  fault: Fault = { kind: "none" };
  grows = 0;
  allocate(spec: MemoryBackingSpec): ArrayBuffer | SharedArrayBuffer {
    if (!this.budget) throw new Error("missing test authority");
    this.specs.push(spec);
    this.snapshots.push(this.budget.snapshot());
    if (this.fault.kind === "throw" && this.specs.length === this.fault.at) throw reason;
    if (this.fault.kind === "shape" && this.specs.length === this.fault.at)
      return this.fault.shape === "array"
        ? new ArrayBuffer(spec.bytes)
        : new SharedArrayBuffer(spec.bytes - 1);
    return new SharedArrayBuffer(spec.bytes);
  }
  grow(): void {
    this.grows++;
    throw new Error("fixed publication backing must not grow");
  }
}
function rig(options: { room?: number; records?: MemoryRecords; serialLimit?: number } = {}) {
  const allocator = new Allocator();
  const configuration = {
    bytes: 1024 * 1024,
    producers: options.records ?? records,
    progress: { bytes: 0, allocations: 0, references: 0, leases: 0 },
    waiters: 0,
    serialLimit: options.serialLimit ?? Number.MAX_SAFE_INTEGER,
  };
  const probe = new MemoryBudget(configuration);
  const overhead = probe.snapshot().allocated;
  probe.close();
  const budget = new MemoryBudget(
    { ...configuration, bytes: overhead + (options.room ?? 512 * 1024) },
    allocator,
  );
  allocator.budget = budget;
  expect(budget.snapshot().limit).toBeLessThan(2 * 1024 * 1024);
  return { budget, allocator };
}
function construct(budget: MemoryBudget, observe: boolean): PublicationBuffers {
  return createPublicationBuffers(limits, observe, { backing: { kind: "budget", budget } });
}
function holdBaseline(budget: MemoryBudget) {
  const lease = granted(budget, { bytes: 64, allocations: 1, references: 1, leases: 0 });
  const reference = lease.account({ metadataUnits: 17, nativeAllowance: 0 });
  return () => {
    lease.release(reference);
    lease.close();
  };
}
function expectCharged(budget: MemoryBudget, before: Snapshot, observe: boolean, count = 1) {
  const plan = demand(observe);
  expect(budget.snapshot()).toMatchObject({
    backingBytes: before.backingBytes + count * plan.bytes,
    allocated: before.allocated + count * plan.bytes,
    metadataUnits: before.metadataUnits,
    nativeAllowance: before.nativeAllowance,
    obligations: before.obligations,
    producerFree: {
      allocations: before.producerFree.allocations - count * plan.allocations,
      references: before.producerFree.references - count * plan.references,
      leases: before.producerFree.leases - count,
    },
  });
}

const denials = ["bytes", "allocations", "references", "leases"] as const;
test.each(denials)(
  "publication impossible %p denial has no allocator or ledger effects",
  (field) => {
    const plan = demand(false);
    const constrained = { ...records, [field]: field === "leases" ? 0 : plan.allocations - 1 };
    const { budget, allocator } = rig(
      field === "bytes" ? { room: plan.bytes - 1 } : { records: constrained },
    );
    try {
      const before = budget.snapshot();
      expect(failure(() => construct(budget, false))).toEqual(new MemoryBudgetError("capacity"));
      expect(allocator.specs).toHaveLength(0);
      expect(budget.snapshot()).toEqual(before);
    } finally {
      budget.close();
    }
  },
);
test.each(denials)("publication pressured %p denial preserves an existing reservation", (field) => {
  const plan = demand(false);
  const { budget, allocator } = rig({ room: plan.bytes });
  const held = granted(budget, {
    bytes: field === "bytes" ? 1 : 0,
    allocations: field === "allocations" ? records.allocations - plan.allocations + 1 : 0,
    references: field === "references" ? records.references - plan.references + 1 : 0,
    leases: field === "leases" ? records.leases - 1 : 0,
  });
  try {
    const before = budget.snapshot();
    expect(failure(() => construct(budget, false))).toEqual(new MemoryBudgetError("capacity"));
    expect(allocator.specs).toHaveLength(0);
    expect(budget.snapshot()).toEqual(before);
  } finally {
    held.close();
    budget.close();
  }
});
test.each(["serial", "closed"] as const)("publication %p authority allocates nothing", (code) => {
  const { budget, allocator } = rig({ serialLimit: code === "serial" ? 20 : undefined });
  if (code === "closed") budget.close();
  try {
    const before = budget.snapshot();
    expect(failure(() => construct(budget, false))).toEqual(new MemoryBudgetError(code));
    expect(allocator.specs).toHaveLength(0);
    expect(budget.snapshot()).toEqual(before);
  } finally {
    budget.close();
  }
});
test.each([false, true])("publication fixed backing plan and precharge, observe=%p", (observe) => {
  const { budget, allocator } = rig({ room: demand(observe).bytes });
  const admit = spyOn(budget, "tryOperation");
  try {
    const before = budget.snapshot();
    const buffers = construct(budget, observe);
    const plan = demand(observe);
    expect(plan.bytes).toBeLessThan(256 * 1024);
    expect(admit.mock.calls).toEqual([[plan]]);
    expect(allocator.specs).toEqual(
      sizes(observe).map((bytes) => ({ kind: "shared", bytes, maximum: bytes })),
    );
    let charged = 0;
    for (const [index, state] of allocator.snapshots.entries()) {
      charged += sizes(observe)[index]!;
      expect(state.backingBytes).toBe(before.backingBytes + charged);
      expect(state.obligations).toBe(before.obligations + plan.bytes - charged);
      expect(state.producerFree).toEqual({
        allocations: 32 - plan.allocations,
        references: 32 - plan.references,
        leases: 7,
      });
    }
    const backings = Object.values(buffers).filter((value) => value instanceof SharedArrayBuffer);
    expect(backings.map((buffer) => buffer.byteLength)).toEqual(sizes(observe));
    expect(new Set(backings).size).toBe(plan.allocations);
    expect(Object.keys(buffers).sort()).toEqual(
      [
        "history",
        "sessionLimit",
        "limits",
        "control",
        "sessions",
        "operations",
        "inputs",
        "results",
        "log",
        "logData",
        "pins",
        "pinData",
        "versions",
      ]
        .concat(observe ? ["pageReaders", "readerLifetimes"] : [])
        .sort(),
    );
    expect(allocator.grows).toBe(0);
    expectCharged(budget, before, observe);
    const published = budget.snapshot();
    expect(failure(() => construct(budget, observe))).toEqual(new MemoryBudgetError("capacity"));
    expect(allocator.specs).toHaveLength(plan.allocations);
    expect(budget.snapshot()).toEqual(published);
  } finally {
    admit.mockRestore();
    budget.close();
  }
});
function expectRollback(observe: boolean, fault: Fault): void {
  const { budget, allocator } = rig();
  const drop = holdBaseline(budget);
  allocator.fault = fault;
  try {
    const before = budget.snapshot();
    const error = failure(() => construct(budget, observe));
    if (fault.kind === "throw") expect(error).toBe(reason);
    else expect(error).toBeInstanceOf(TypeError);
    expect(allocator.specs).toHaveLength(fault.kind === "none" ? 0 : fault.at);
    expect(usage(budget.snapshot())).toEqual(usage(before));
    expect(budget.snapshot().changed).toBeGreaterThan(before.changed);
  } finally {
    drop();
    budget.close();
  }
}
for (const observe of [false, true]) {
  test.each(Array.from({ length: demand(observe).allocations }, (_, index) => index + 1))(
    `publication allocator rollback at %p, observe=${observe}`,
    (at) => expectRollback(observe, { kind: "throw", at }),
  );
  test.each(["array", "short"] as const)(
    `publication rejects invalid backing %p after earlier allocations, observe=${observe}`,
    (shape) => expectRollback(observe, { kind: "shape", at: demand(observe).allocations, shape }),
  );
}
test("publication UUID failure precedes allocation and reservation", () => {
  const { budget, allocator } = rig();
  const uuid = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    writable: true,
    value: () => {
      throw reason;
    },
  });
  try {
    const before = budget.snapshot();
    expect(failure(() => construct(budget, true))).toBe(reason);
    expect(allocator.specs).toHaveLength(0);
    expect(budget.snapshot()).toEqual(before);
  } finally {
    if (uuid) Object.defineProperty(crypto, "randomUUID", uuid);
    else Reflect.deleteProperty(crypto, "randomUUID");
    budget.close();
  }
  expect(Object.getOwnPropertyDescriptor(crypto, "randomUUID")).toEqual(uuid);
});
test.each(["before", "after"])(
  "publication registry failure %p final insertion removes the group",
  (position) => {
    const { budget, allocator } = rig();
    const drop = holdBaseline(budget);
    const nativeSet = WeakMap.prototype.set;
    let registry: unknown;
    let hasRegistryEntry = () => false;
    const registration = spyOn(WeakMap.prototype, "set").mockImplementation(function (
      this: WeakMap<object, unknown>,
      key: object,
      value: unknown,
    ) {
      if (key !== budget) return nativeSet.call(this, key, value);
      registry = value;
      hasRegistryEntry = () => this.has(budget);
      if (position === "after") nativeSet.call(this, key, value);
      throw reason;
    });
    try {
      const before = budget.snapshot();
      expect(failure(() => construct(budget, true))).toBe(reason);
      expect(allocator.specs).toHaveLength(12);
      expect(registry).toBeInstanceOf(Set);
      if (!(registry instanceof Set)) throw new Error("missing private registry");
      expect(registry.size).toBe(0);
      expect(hasRegistryEntry()).toBe(false);
      expect(usage(budget.snapshot())).toEqual(usage(before));
    } finally {
      registration.mockRestore();
      drop();
      budget.close();
    }
  },
);
function exerciseAliases(buffers: PublicationBuffers): void {
  const writer = new PublicationDomain(buffers);
  const reader = new PublicationDomain(buffers);
  const session = writer.openSession();
  const start = reader.cut();
  const id = writer.next(session);
  const admitted = writer.admit(
    session,
    id,
    { kind: "remove", path: "/tiny", ifContent: true },
    new Uint8Array([7]),
  );
  if (admitted.kind !== "admitted") throw new Error("expected new publication");
  const result = { kind: "boolean", value: true } as const;
  const file = {
    ...parseFileIdentity({ id: "10000000000000001", version: "10000000000000001" }),
    birthHistory: buffers.history,
    ino: 1,
  };
  const changes = [{ kind: "metadata", file, mode: 420, mtime: 1 }] as const;
  const prepared = writer.prepare(admitted.admission, result, changes);
  const receipt = writer.commit(prepared);
  expect(reader.lookup(session, id)).toEqual({ kind: "committed", receipt });
  const page = reader.changes(start, limits.logBytes);
  if (page.kind !== "changes") throw new Error("missing publication changes");
  expect(page.publications).toEqual([{ receipt, changes }]);
  writer.stop();
  expect(reader.stopped).toBe(true);
  writer.releaseStopped();
}
test.each([false, true])(
  "publication aliases and stopped budgets retain backing, observe=%p",
  (observe) => {
    const { budget, allocator } = rig();
    try {
      const before = budget.snapshot();
      const buffers = construct(budget, observe);
      const alias = buffers.inputs;
      exerciseAliases(buffers);
      expectCharged(budget, before, observe);
      construct(budget, observe);
      expectCharged(budget, before, observe, 2);
      budget.close();
      expectCharged(budget, before, observe, 2);
      expect(alias.byteLength).toBe(640);
      const stopped = budget.snapshot();
      const calls = allocator.specs.length;
      expect(failure(() => construct(budget, observe))).toEqual(new MemoryBudgetError("closed"));
      expect(allocator.specs).toHaveLength(calls);
      expect(budget.snapshot()).toEqual(stopped);
    } finally {
      budget.close();
    }
  },
);

test("publication existing registry insertion failure preserves published owners", () => {
  const { budget, allocator } = rig();
  const nativeSet = WeakMap.prototype.set;
  let registry: unknown;
  const capture = spyOn(WeakMap.prototype, "set").mockImplementation(function (
    this: WeakMap<object, unknown>,
    key: object,
    value: unknown,
  ) {
    if (key === budget) registry = value;
    return nativeSet.call(this, key, value);
  });
  try {
    construct(budget, false);
  } finally {
    capture.mockRestore();
  }
  const nativeAdd = Set.prototype.add;
  const insertion = spyOn(Set.prototype, "add").mockImplementation(function (
    this: Set<unknown>,
    value: unknown,
  ) {
    const result = nativeAdd.call(this, value);
    if (this === registry) throw reason;
    return result;
  });
  try {
    const before = budget.snapshot();
    expect(failure(() => construct(budget, false))).toBe(reason);
    expect(allocator.specs).toHaveLength(20);
    if (!(registry instanceof Set)) throw new Error("missing private registry");
    expect(registry.size).toBe(1);
    expect(usage(budget.snapshot())).toEqual(usage(before));
  } finally {
    insertion.mockRestore();
    budget.close();
  }
});
test.each([false, true])(
  "publication unbudgeted and default-allocator layouts, observe=%p",
  (observe) => {
    const { budget } = rig();
    const unbudgeted = createPublicationBuffers(limits, observe);
    const native = new MemoryBudget({
      bytes: 512 * 1024,
      producers: records,
      progress: { bytes: 0, allocations: 0, references: 0, leases: 0 },
      waiters: 0,
      serialLimit: Number.MAX_SAFE_INTEGER,
    });
    try {
      const before = native.snapshot();
      const funded = construct(native, observe);
      expect(Object.keys(funded)).toEqual(Object.keys(unbudgeted));
      const lengths = (buffers: PublicationBuffers) =>
        Object.values(buffers)
          .filter((value) => value instanceof SharedArrayBuffer)
          .map((buffer) => buffer.byteLength);
      expect(lengths(funded)).toEqual(sizes(observe));
      expect(lengths(unbudgeted)).toEqual(sizes(observe));
      expectCharged(native, before, observe);
      expect(budget.snapshot().obligations).toBe(0);
    } finally {
      native.close();
      budget.close();
    }
  },
);

function compositionCheckpoint(): CheckpointPublication {
  const cut = { history: "publication-constructor-composition", generation: 7 };
  return {
    kind: "settled-publication-v1",
    cut,
    sessionSerial: 9,
    limits,
    receipts: [
      {
        id: { session: 9, sequence: 1 },
        cut,
        result: { kind: "void" },
        durability: { kind: "untracked" },
      },
    ],
    changes: [],
    contentVersions: [{ ino: 1, version: 7 }],
  };
}

test.each([false, true])(
  "publication composition restores within admitted frozen backing, observe=%p",
  (observe) => {
    const checkpoint = compositionCheckpoint();
    const { budget, allocator } = rig({ room: demand(observe).bytes });
    const admit = spyOn(budget, "tryOperation");
    try {
      const before = budget.snapshot();
      const buffers = createPublicationBuffers(limits, observe, {
        checkpoint,
        backing: { kind: "budget", budget },
      });
      expect(admit.mock.calls).toEqual([[demand(observe)]]);
      expect(allocator.specs.map((spec) => spec.bytes)).toEqual(sizes(observe));
      expectCharged(budget, before, observe);
      expect(Object.isFrozen(buffers)).toBe(true);
      expect(Object.isFrozen(buffers.limits)).toBe(true);
      expect(buffers.sessionLimit).toBe(checkpoint.sessionSerial + 65_536);
      const restored = new PublicationDomain(buffers);
      expect(restored.cut()).toEqual(checkpoint.cut);
      const receipt = checkpoint.receipts[0];
      if (!receipt) throw new Error("missing composition receipt");
      expect(restored.lookupAny(receipt.id)).toEqual({ kind: "committed", receipt });
      expect(restored.contentVersion(1)).toBe(7);
      const session = restored.openSession();
      expect(session.serial).toBe(checkpoint.sessionSerial + 1);
      expect(new PublicationDomain(buffers).cut()).toEqual(checkpoint.cut);
    } finally {
      admit.mockRestore();
      budget.close();
    }
  },
);

test("publication composition validates restore before admission and refuses before allocation", () => {
  const checkpoint = compositionCheckpoint();
  const { budget, allocator } = rig({ room: demand(true).bytes - 1 });
  const admit = spyOn(budget, "tryOperation");
  const backing = { kind: "budget", budget } as const;
  try {
    const before = budget.snapshot();
    expect(() =>
      createPublicationBuffers(limits, true, {
        checkpoint: { ...checkpoint, limits: { ...limits, operations: 3 } },
        backing,
      }),
    ).toThrow("checkpoint publication limits differ");
    expect(() =>
      createPublicationBuffers(limits, true, {
        checkpoint: { ...checkpoint, sessionSerial: 0x7ffffffe },
        backing,
      }),
    ).toThrow("publication session frontier exhausted");
    expect(admit.mock.calls).toHaveLength(0);
    expect(failure(() => createPublicationBuffers(limits, true, { checkpoint, backing }))).toEqual(
      new MemoryBudgetError("capacity"),
    );
    expect(admit.mock.calls).toEqual([[demand(true)]]);
    expect(allocator.specs).toHaveLength(0);
    expect(budget.snapshot()).toEqual(before);
  } finally {
    admit.mockRestore();
    budget.close();
  }
});

test("publication composition rolls back admitted backing when restore initialization fails", () => {
  const checkpoint = compositionCheckpoint();
  const { budget, allocator } = rig();
  const descriptor = Object.getOwnPropertyDescriptor(PublicationDomain.prototype, "restore");
  if (!descriptor) throw new Error("missing restore initializer");
  Object.defineProperty(PublicationDomain.prototype, "restore", {
    ...descriptor,
    value() {
      throw reason;
    },
  });
  try {
    const before = budget.snapshot();
    expect(
      failure(() =>
        createPublicationBuffers(limits, true, {
          checkpoint,
          backing: { kind: "budget", budget },
        }),
      ),
    ).toBe(reason);
    expect(allocator.specs).toHaveLength(demand(true).allocations);
    expect(usage(budget.snapshot())).toEqual(usage(before));
    expect(budget.snapshot().changed).toBeGreaterThan(before.changed);
  } finally {
    Object.defineProperty(PublicationDomain.prototype, "restore", descriptor);
    budget.close();
  }
  expect(Object.getOwnPropertyDescriptor(PublicationDomain.prototype, "restore")).toEqual(
    descriptor,
  );
});
