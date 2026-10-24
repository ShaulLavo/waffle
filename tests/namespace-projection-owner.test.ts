import { expect, spyOn, test } from "bun:test";
import { parseFileIdentity } from "../fs/file-identity";
import {
  MemoryBudget,
  type MemoryAllocator,
  type MemoryBackingSpec,
  type MemoryRecords,
} from "../fs/memory-budget";
import { NamespaceProjectionOwner } from "../fs/namespace-projection-owner";
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
const records: MemoryRecords = { allocations: 4, references: 4, leases: 2 };
type Snapshot = ReturnType<MemoryBudget["snapshot"]>;

class Allocator implements MemoryAllocator {
  readonly specs: MemoryBackingSpec[] = [];
  allocate(spec: MemoryBackingSpec): ArrayBuffer | SharedArrayBuffer {
    this.specs.push(spec);
    return new ArrayBuffer(spec.bytes);
  }
  grow(): void {
    throw new Error("namespace backing must not grow");
  }
}

function rig() {
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
  const budget = new MemoryBudget({ ...configuration, bytes: overhead + 16384 }, allocator);
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

function expectCharged(before: Snapshot, budget: MemoryBudget): void {
  expect(usage(budget.snapshot())).toEqual({
    ...usage(before),
    backingBytes: before.backingBytes + backingBytes,
    metadataUnits: before.metadataUnits + 8192,
    allocated: before.allocated + chargedBytes,
    producerFree: {
      allocations: before.producerFree.allocations - 2,
      references: before.producerFree.references - 2,
      leases: before.producerFree.leases - 1,
    },
  });
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
      expect(releases).toBe(1);
      expect(await retiring.catch((error: unknown) => error)).toBe(reason);
      expect(releases).toBe(1);
    } finally {
      admission.mockRestore();
      budget.close();
    }
  },
);

async function fixture() {
  const pair = createFilesystemConnection(undefined, { workspace: true });
  const service = new FilesystemService(new MemoryBackend());
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  const workspace = createWorkspaceVfs(client);
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
  const current = await fixture();
  const retiring = retirements();
  let held: ReturnType<typeof holdResponse> | undefined;
  try {
    const first = await snapshot(current.workspace);
    held = holdResponse(current.serverPort);
    const pending = current.workspace.changes(first.cut.watermark);
    await held.held;
    const second = await snapshot(current.workspace);
    expect(retiring.owners).toHaveLength(1);
    held.release();
    expect((await pending).kind).toBe("gap");
    expect(retiring.owners).toHaveLength(1);
    expect(await current.workspace.changes(second.cut.watermark)).toMatchObject({
      kind: "changes",
      batches: [],
    });
    expect(retiring.owners).toHaveLength(1);
  } finally {
    held?.release();
    await current.stop();
    retiring.spy.mockRestore();
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
