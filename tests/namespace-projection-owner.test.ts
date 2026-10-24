import { expect, spyOn, test } from "bun:test";
import { parseFileIdentity } from "../fs/file-identity";
import {
  MemoryBudget,
  MemoryBudgetError,
  type MemoryAllocator,
  type MemoryBackingSpec,
  type MemoryRecords,
} from "../fs/memory-budget";
import { NamespaceProjectionOwner } from "../fs/namespace-projection-owner";
import { namespaceProjectionPlan } from "../fs/namespace-projection-table";
import type { NamespaceRecord } from "../fs/workspace-protocol";
import {
  createFilesystemConnection,
  createWorkspaceVfs,
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  type NamespaceEntry,
  type WorkspaceVfs,
} from "../fs";

const capacity = {
  nodes: 4,
  edges: 4,
  extraLinks: 2,
  nameBytes: 32,
  scratchSlots: 2,
  byteLimit: 8349,
};
const backingBytes = 157;
const chargedBytes = 8349;
const workspacePlan = namespaceProjectionPlan();
const workspaceChargedBytes = workspacePlan.backingBytes + workspacePlan.bookkeepingBytes;
const records: MemoryRecords = { allocations: 4, references: 4, leases: 2 };
type Snapshot = ReturnType<MemoryBudget["snapshot"]>;

class Allocator implements MemoryAllocator {
  readonly specs: MemoryBackingSpec[] = [];
  failure: { readonly reason: unknown } | undefined;
  allocate(spec: MemoryBackingSpec): ArrayBuffer | SharedArrayBuffer {
    this.specs.push(spec);
    if (this.failure) throw this.failure.reason;
    return new ArrayBuffer(spec.bytes);
  }
  grow(): void {
    throw new Error("namespace backing must not grow");
  }
}

function rig(room = 16384) {
  const allocator = new Allocator();
  const configuration = {
    bytes: 65536,
    producers: records,
    progress: { bytes: 0, allocations: 0, references: 0, leases: 0 },
    waiters: 0,
    serialLimit: Number.MAX_SAFE_INTEGER,
  };
  const probe = new MemoryBudget(configuration);
  const overhead = probe.snapshot().allocated;
  probe.close();
  const budget = new MemoryBudget({ ...configuration, bytes: overhead + room }, allocator);
  return { allocator, budget };
}

function usage(snapshot: Snapshot) {
  return {
    backingBytes: snapshot.backingBytes,
    metadataUnits: snapshot.metadataUnits,
    allocated: snapshot.allocated,
    obligations: snapshot.obligations,
    reserve: snapshot.reserve,
    stopped: snapshot.stopped,
    producerFree: snapshot.producerFree,
    progressFree: snapshot.progressFree,
  };
}

function expectCharged(
  before: Snapshot,
  budget: MemoryBudget,
  count = 1,
  bytes = chargedBytes,
): void {
  expect(usage(budget.snapshot())).toEqual({
    ...usage(before),
    backingBytes: before.backingBytes + count * (bytes - 8192),
    metadataUnits: before.metadataUnits + count * 8192,
    allocated: before.allocated + count * bytes,
    producerFree: {
      allocations: before.producerFree.allocations - count * 2,
      references: before.producerFree.references - count * 2,
      leases: before.producerFree.leases - count,
    },
  });
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected funded construction to fail");
}

function constructWithUint32ArrayFailure(
  before: Snapshot,
  budget: MemoryBudget,
  reason: unknown,
  options: { readonly construct?: () => unknown; readonly bytes?: number } = {},
): unknown {
  const construct = options.construct ?? (() => NamespaceProjectionOwner.create(capacity, budget));
  const bytes = options.bytes ?? chargedBytes;
  const NativeUint32Array = globalThis.Uint32Array;
  try {
    globalThis.Uint32Array = new Proxy(NativeUint32Array, {
      construct() {
        expectCharged(before, budget, 1, bytes);
        throw reason;
      },
    });
    return thrown(construct);
  } finally {
    globalThis.Uint32Array = NativeUint32Array;
  }
}

function borrowed(owner: NamespaceProjectionOwner) {
  const borrow = owner.borrow();
  if (!borrow) throw new Error("expected an open namespace projection");
  return borrow;
}

function identity(serial: number) {
  const token = ((1n << 64n) | BigInt(serial)).toString(16);
  return parseFileIdentity({ id: token, version: token });
}

function record(serial: number, parent: number | null, name: string): NamespaceRecord {
  return {
    ...identity(serial),
    parent: parent === null ? null : identity(parent).id,
    name,
    path: "/",
    selected: true,
    kind: parent === null ? "directory" : "file",
    size: 0,
    mtime: 0,
    mode: 0o600,
  };
}

test("funded admission denial allocates nothing and preserves every ledger record", () => {
  const { allocator, budget } = rig(chargedBytes - 1);
  try {
    const before = budget.snapshot();
    const error = thrown(() => NamespaceProjectionOwner.create(capacity, budget));
    expect(error).toEqual(new MemoryBudgetError("capacity"));
    expect(allocator.specs).toHaveLength(0);
    expect(usage(budget.snapshot())).toEqual(usage(before));
  } finally {
    budget.close();
  }
});

test.each([0, "", undefined] as const)(
  "backing allocation rejection %p rolls back its reservation and lease",
  (reason) => {
    const { allocator, budget } = rig();
    allocator.failure = { reason };
    try {
      const before = budget.snapshot();
      const error = thrown(() => NamespaceProjectionOwner.create(capacity, budget));
      expect(Object.is(error, reason)).toBe(true);
      expect(allocator.specs).toEqual([{ kind: "array", bytes: backingBytes }]);
      expect(usage(budget.snapshot())).toEqual(usage(before));
    } finally {
      budget.close();
    }
  },
);

test.each([0, "", undefined] as const)(
  "table construction rejection %p releases both allocations and references",
  (reason) => {
    const { allocator, budget } = rig();
    try {
      const before = budget.snapshot();
      const error = constructWithUint32ArrayFailure(before, budget, reason);
      expect(Object.is(error, reason)).toBe(true);
      expect(allocator.specs).toEqual([{ kind: "array", bytes: backingBytes }]);
      expect(usage(budget.snapshot())).toEqual(usage(before));
    } finally {
      budget.close();
    }
  },
);

test("funded retirement waits for the final borrower and refunds exactly once", async () => {
  const { allocator, budget } = rig();
  const admit = spyOn(budget, "tryOperation");
  try {
    const before = budget.snapshot();
    const owner = NamespaceProjectionOwner.create(capacity, budget);
    expect(admit.mock.calls).toEqual([
      [{ bytes: chargedBytes, allocations: 2, references: 2, leases: 0 }],
    ]);
    expect(allocator.specs).toEqual([{ kind: "array", bytes: backingBytes }]);
    expectCharged(before, budget);

    const borrow = borrowed(owner);
    borrow.table.add(record(1, null, ""));
    borrow.table.add(record(2, 1, "kept"));
    const copied = borrow.table.project(
      [
        {
          kind: "metadata",
          file: { ...identity(2), ino: 2, birthHistory: "fixture" },
          mode: 0o600,
          mtime: 1,
        },
      ],
      { take() {} },
    );
    const retiring = owner.retire();
    expect(owner.retire()).toBe(retiring);
    expect(owner.borrow()).toBeUndefined();
    expectCharged(before, budget);

    borrow.release();
    borrow.release();
    await retiring;
    expect(usage(budget.snapshot())).toEqual(usage(before));
    expect(owner.borrow()).toBeUndefined();
    expect(copied).toEqual([
      {
        kind: "metadata",
        ...identity(2),
        mode: 0o600,
        mtime: 1,
        paths: ["/kept"],
      },
    ]);
  } finally {
    admit.mockRestore();
    budget.close();
  }
});

test.each([0, "", undefined] as const)(
  "cleanup rejection %p retains the charge and failure",
  async (reason) => {
    const { budget } = rig();
    const failing = failFirstReferenceRelease(budget, reason);
    try {
      const before = budget.snapshot();
      const owner = NamespaceProjectionOwner.create(capacity, budget);
      const retiring = owner.retire();
      const failure = await retiring.then(
        () => "released",
        (error: unknown) => error,
      );
      expect(Object.is(failure, reason)).toBe(true);
      expect(owner.retire()).toBe(retiring);
      expectCharged(before, budget);
      expect(failing.releases()).toBe(1);
      expect(await retiring.catch((error: unknown) => error)).toBe(reason);
      expect(failing.releases()).toBe(1);
    } finally {
      failing.admission.mockRestore();
      budget.close();
    }
  },
);

function failFirstReferenceRelease(budget: MemoryBudget, reason: unknown) {
  const tryOperation = budget.tryOperation.bind(budget);
  let releases = 0;
  const admission = spyOn(budget, "tryOperation").mockImplementation((demand) => {
    const result = tryOperation(demand);
    if (result.kind !== "granted") return result;
    const release = result.lease.release;
    spyOn(result.lease, "release").mockImplementation((reference) => {
      releases++;
      if (releases === 1) throw reason;
      return release(reference);
    });
    return result;
  });
  return { admission, releases: () => releases };
}

async function fixture(budget?: MemoryBudget) {
  const pair = createFilesystemConnection(undefined, { workspace: true });
  const service = new FilesystemService(new MemoryBackend());
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  const workspace = createWorkspaceVfs(client, budget);
  return {
    client,
    serverPort: pair.server.port,
    service,
    workspace,
    async stop() {
      await workspace.close();
      client.dispose();
      service.dispose();
    },
  };
}

async function snapshot(workspace: WorkspaceVfs) {
  const cursor = workspace.snapshot();
  const entries: NamespaceEntry[] = [];
  for (;;) {
    const page = await cursor.next();
    if (page.kind === "complete") return { cut: page.cut, entries };
    if (page.kind !== "entries") throw new Error(`snapshot returned ${page.kind}`);
    entries.push(...page.entries);
  }
}

function holdResponse(port: MessagePort) {
  const post = port.postMessage.bind(port);
  const held = Promise.withResolvers<void>();
  let response: unknown;
  port.postMessage = (value: unknown) => {
    port.postMessage = post;
    response = value;
    held.resolve();
  };
  return {
    held: held.promise,
    release() {
      port.postMessage = post;
      post(response);
    },
  };
}

function retirements() {
  const original = NamespaceProjectionOwner.prototype.retire;
  const owners: NamespaceProjectionOwner[] = [];
  const spy = spyOn(NamespaceProjectionOwner.prototype, "retire").mockImplementation(function (
    this: NamespaceProjectionOwner,
  ) {
    owners.push(this);
    return original.call(this);
  });
  return { owners, spy };
}

function holdFirstBorrow() {
  const original = NamespaceProjectionOwner.prototype.borrow;
  let held: ReturnType<NamespaceProjectionOwner["borrow"]>;
  const spy = spyOn(NamespaceProjectionOwner.prototype, "borrow").mockImplementation(function (
    this: NamespaceProjectionOwner,
  ) {
    const borrow = original.call(this);
    if (borrow && !held) held = original.call(this);
    return borrow;
  });
  return {
    spy,
    release() {
      held?.release();
    },
  };
}

test("workspace factory preserves funding across memoized repeats", async () => {
  const funded = rig(workspaceChargedBytes);
  const other = rig(workspaceChargedBytes);
  const fundedFixture = await fixture(funded.budget);
  const defaultFixture = await fixture();
  try {
    const before = funded.budget.snapshot();
    expect(createWorkspaceVfs(fundedFixture.client, funded.budget)).toBe(fundedFixture.workspace);
    expect(createWorkspaceVfs(fundedFixture.client)).toBe(fundedFixture.workspace);
    expect(() => createWorkspaceVfs(fundedFixture.client, other.budget)).toThrow(
      "different namespace projection budget",
    );
    expect(createWorkspaceVfs(defaultFixture.client)).toBe(defaultFixture.workspace);
    expect(() => createWorkspaceVfs(defaultFixture.client, funded.budget)).toThrow(
      "different namespace projection budget",
    );
    await snapshot(defaultFixture.workspace);
    expect(funded.allocator.specs).toHaveLength(0);
    expect(usage(funded.budget.snapshot())).toEqual(usage(before));
  } finally {
    await fundedFixture.stop();
    await defaultFixture.stop();
    funded.budget.close();
    other.budget.close();
  }
});

test("workspace admission denial precedes projection allocation and remote work", async () => {
  const { allocator, budget } = rig(workspaceChargedBytes - 1);
  const current = await fixture(budget);
  const submission = spyOn(current.client, "submit");
  try {
    const before = budget.snapshot();
    const error = thrown(() => current.workspace.snapshot());
    expect(error).toEqual(new MemoryBudgetError("capacity"));
    expect(allocator.specs).toHaveLength(0);
    expect(usage(budget.snapshot())).toEqual(usage(before));
    expect(submission.mock.calls).toHaveLength(0);
    expect(current.service.resources().workspaceCursors).toBe(0);
  } finally {
    submission.mockRestore();
    await current.stop();
    budget.close();
  }
});

test("workspace table constructor failure rolls back with exact error identity", async () => {
  const { allocator, budget } = rig(workspaceChargedBytes);
  const current = await fixture(budget);
  const submission = spyOn(current.client, "submit");
  const reason = new Error("controlled workspace projection construction failure");
  try {
    const before = budget.snapshot();
    const error = constructWithUint32ArrayFailure(before, budget, reason, {
      construct: () => current.workspace.snapshot(),
      bytes: workspaceChargedBytes,
    });
    expect(Object.is(error, reason)).toBe(true);
    expect(allocator.specs).toEqual([{ kind: "array", bytes: workspacePlan.backingBytes }]);
    expect(usage(budget.snapshot())).toEqual(usage(before));
    expect(submission.mock.calls).toHaveLength(0);
    expect(current.service.resources().workspaceCursors).toBe(0);
  } finally {
    submission.mockRestore();
    await current.stop();
    budget.close();
  }
});

test("workspace cancellation releases a funded scanning projection exactly once", async () => {
  const { budget } = rig(workspaceChargedBytes);
  const current = await fixture(budget);
  try {
    const before = budget.snapshot();
    const cursor = current.workspace.snapshot();
    expectCharged(before, budget, 1, workspaceChargedBytes);
    const closing = cursor.close();
    expect(cursor.close()).toBe(closing);
    await closing;
    expect(usage(budget.snapshot())).toEqual(usage(before));
    await cursor.close();
    expect(usage(budget.snapshot())).toEqual(usage(before));
  } finally {
    await current.stop();
    budget.close();
  }
});

test("workspace accepted and borrowed projections release only after the final borrower", async () => {
  const { budget } = rig(workspaceChargedBytes);
  const current = await fixture(budget);
  const borrowing = holdFirstBorrow();
  try {
    const before = budget.snapshot();
    await current.client.asyncCall("writeFile", ["/held"], new Uint8Array([65]));
    const cursor = current.workspace.snapshot();
    expect((await cursor.next()).kind).toBe("entries");
    expectCharged(before, budget, 1, workspaceChargedBytes);
    expect((await cursor.next()).kind).toBe("complete");
    expectCharged(before, budget, 1, workspaceChargedBytes);
    const closing = current.workspace.close();
    expect(current.workspace.close()).toBe(closing);
    expectCharged(before, budget, 1, workspaceChargedBytes);
    borrowing.release();
    await closing;
    expect(usage(budget.snapshot())).toEqual(usage(before));
    await current.workspace.close();
    expect(usage(budget.snapshot())).toEqual(usage(before));
  } finally {
    borrowing.release();
    await current.stop();
    borrowing.spy.mockRestore();
    budget.close();
  }
});

test.each([0, "", undefined] as const)(
  "workspace close reports a scanning retirement failure once for %p",
  async (reason) => {
    const { budget } = rig(workspaceChargedBytes);
    const failing = failFirstReferenceRelease(budget, reason);
    let current: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      current = await fixture(budget);
      await current.client.asyncCall("writeFile", ["/held"], new Uint8Array([65]));
      const cursor = current.workspace.snapshot();
      expect((await cursor.next()).kind).toBe("entries");
      const charged = budget.snapshot();
      const closing = current.workspace.close();
      expect(current.workspace.close()).toBe(closing);
      const failure = await closing.then(
        () => "closed",
        (error: unknown) => error,
      );
      expect(Object.is(failure, reason)).toBe(true);
      expect(Object.is(await closing.catch((error: unknown) => error), reason)).toBe(true);
      expect(usage(budget.snapshot())).toEqual(usage(charged));
      expect(failing.releases()).toBe(1);
    } finally {
      await current?.workspace.close().catch(() => {});
      current?.client.dispose();
      current?.service.dispose();
      failing.admission.mockRestore();
      budget.close();
    }
  },
);

test("cursor close reports an independent remote close failure once", async () => {
  const { budget } = rig(workspaceChargedBytes);
  const retirementReason = 0;
  const remoteReason = new Error("remote close failed");
  const failing = failFirstReferenceRelease(budget, retirementReason);
  let current: Awaited<ReturnType<typeof fixture>> | undefined;
  let remoteFailures = 0;
  try {
    current = await fixture(budget);
    await current.client.asyncCall("writeFile", ["/held"], new Uint8Array([65]));
    const cursor = current.workspace.snapshot();
    expect((await cursor.next()).kind).toBe("entries");
    const submit = current.client.submit.bind(current.client);
    const submission = spyOn(current.client, "submit").mockImplementation((operation, ...args) => {
      if (operation !== "publicationNamespaceClose" || remoteFailures++)
        return submit(operation, ...args);
      return {
        value: () => Promise.reject(remoteReason),
        release() {},
      } as ReturnType<FilesystemClient["submit"]>;
    });
    const failure = await cursor.close().then(
      () => "closed",
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([retirementReason, remoteReason]);
    expect(failing.releases()).toBe(1);
    submission.mockRestore();
  } finally {
    await current?.workspace.close().catch(() => {});
    current?.client.dispose();
    current?.service.dispose();
    failing.admission.mockRestore();
    budget.close();
  }
});

test("completion transfers the scanning owner and close retires the accepted owner once", async () => {
  const current = await fixture();
  const retiring = retirements();
  try {
    await current.client.asyncCall("writeFile", ["/kept"], new Uint8Array([65]));
    const initial = await snapshot(current.workspace);
    expect(retiring.owners).toHaveLength(0);
    expect(await current.workspace.changes(initial.cut.watermark)).toMatchObject({
      kind: "changes",
      batches: [],
    });
    await current.workspace.close();
    await current.workspace.close();
    expect(retiring.owners).toHaveLength(1);
    expect(initial.entries.map((entry) => entry.path)).toContain("/kept");
    expect(initial.entries.find((entry) => entry.path === "/kept")?.id).toBeTypeOf("bigint");
  } finally {
    await current.stop();
    retiring.spy.mockRestore();
  }
});

test("replacement retires the old owner while a stale reply preserves the new one", async () => {
  const { budget } = rig(workspaceChargedBytes * 2);
  const current = await fixture(budget);
  const retiring = retirements();
  let held: ReturnType<typeof holdResponse> | undefined;
  try {
    const before = budget.snapshot();
    const first = await snapshot(current.workspace);
    expectCharged(before, budget, 1, workspaceChargedBytes);
    held = holdResponse(current.serverPort);
    const pending = current.workspace.changes(first.cut.watermark);
    await held.held;
    const second = await snapshot(current.workspace);
    expectCharged(before, budget, 1, workspaceChargedBytes);
    expect(retiring.owners).toHaveLength(1);
    held.release();
    expect((await pending).kind).toBe("gap");
    expect(retiring.owners).toHaveLength(1);
    expect(await current.workspace.changes(second.cut.watermark)).toMatchObject({
      kind: "changes",
      batches: [],
    });
    expect(retiring.owners).toHaveLength(1);
    await current.workspace.close();
    expect(usage(budget.snapshot())).toEqual(usage(before));
  } finally {
    held?.release();
    await current.stop();
    retiring.spy.mockRestore();
    budget.close();
  }
});

test("a history gap retires acceptance without invalidating copied change pages", async () => {
  const current = await fixture();
  const retiring = retirements();
  try {
    const initial = await snapshot(current.workspace);
    await current.client.asyncCall("writeFile", ["/copied"], new Uint8Array([66]));
    const changed = await current.workspace.changes(initial.cut.watermark);
    if (changed.kind !== "changes") throw new Error("missing copied changes");
    const copied = changed.batches
      .flatMap((batch) => batch.changes)
      .find((change) => change.kind === "write");
    expect(copied).toMatchObject({ kind: "write", paths: ["/copied"] });
    expect(await current.workspace.changes(initial.cut.watermark)).toMatchObject({
      kind: "gap",
      resync: "snapshot",
    });
    expect(retiring.owners).toHaveLength(1);
    expect(copied).toMatchObject({ kind: "write", paths: ["/copied"] });
  } finally {
    await current.stop();
    retiring.spy.mockRestore();
  }
});
