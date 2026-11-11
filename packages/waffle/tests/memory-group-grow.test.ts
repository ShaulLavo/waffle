import { expect, test } from "bun:test";
import { PAGE_BYTES } from "../group/protocol.js";
import { MemoryGroups, type MemberLease } from "../group/state.js";
import { SharedMemoryLedger, bytes, declareSharedMemoryPlatform } from "../memory/reservations.js";

interface Growth {
  page: number;
  bytes: number;
}

/** Exercise the member import and real owner RPC, then physically stop the worker. */
async function grow(lease: MemberLease, pages: readonly number[]): Promise<Growth[]> {
  const worker = new Worker(new URL("./fixtures/memory-group-abi-worker.ts", import.meta.url).href);
  try {
    const result = new Promise<Growth[]>((resolve, reject) => {
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = reject;
    });
    const launched = lease.launch();
    worker.postMessage({ request: launched.request, mode: "grow", pages }, launched.transfer);
    return await result;
  } finally {
    await worker.terminate();
  }
}

test("one page followed by 16 pages strands no space needed by later growth", async () => {
  const groups = new MemoryGroups({ maximumPages: 49, budgetBytes: 49 * PAGE_BYTES });
  const lease = groups.admit(1, "d", "new");
  try {
    // Former leases took 16 then 32 pages. Consuming the second lease left the first
    // lease's 15 pages unreachable, so the final 15-page request failed at this limit.
    const results = await grow(lease, [1, 16, 16, 15]);
    expect(results.map((result) => result.page)).toEqual([1, 2, 18, 34]);
    expect(groups.owner(lease.group)!.snapshot()).toMatchObject({
      committedBytes: 49 * PAGE_BYTES,
      freeBytes: 0,
    });
    expect(groups.budget.committed).toBe(49 * PAGE_BYTES);
    expect(groups.budget.rejected).toBeUndefined();
  } finally {
    lease.stopped();
  }
  expect(groups.budget.committed).toBe(0);
  expect(groups.snapshot()).toEqual([]);
});

test("small requests acquire exactly their pages throughout repeated growth", async () => {
  const groups = new MemoryGroups({ maximumPages: 256 });
  const lease = groups.admit(1, "d", "new");
  try {
    const results = await grow(lease, Array(130).fill(1));
    for (let index = 0; index < results.length; index++) {
      expect(results[index]).toEqual({ page: index + 1, bytes: (index + 2) * PAGE_BYTES });
    }
    expect(groups.budget.committed).toBe(131 * PAGE_BYTES);
    expect(groups.budget.rejected).toBeUndefined();
  } finally {
    lease.stopped();
  }
  expect(groups.budget.committed).toBe(0);
});

test("growth refusal changes no backing and a later small request still fits", async () => {
  const groups = new MemoryGroups({ maximumPages: 64, budgetBytes: 3 * PAGE_BYTES });
  const lease = groups.admit(1, "d", "new");
  try {
    expect(await grow(lease, [1, 2, 1, 1, 0])).toEqual([
      { page: 1, bytes: 2 * PAGE_BYTES },
      { page: -48, bytes: 2 * PAGE_BYTES },
      { page: 2, bytes: 3 * PAGE_BYTES },
      { page: -48, bytes: 3 * PAGE_BYTES },
      { page: -28, bytes: 3 * PAGE_BYTES },
    ]);
    expect(groups.budget.committed).toBe(3 * PAGE_BYTES);
    expect(groups.budget.peak).toBe(3 * PAGE_BYTES);
  } finally {
    lease.stopped();
  }
  expect(groups.budget.committed).toBe(0);
});

test("fixed groups grant exact logical pages within separately reserved backing", async () => {
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(4 * 1024 ** 2),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
  });
  const runtime = new SharedMemoryLedger(platform).openRuntime(platform);
  const groups = new MemoryGroups({ maximumPages: 49 }, runtime.groups, runtime.sizing);
  const lease = groups.admit(1, "d", "new");
  const reservation = () =>
    runtime.snapshot().holders.filter((holder) => holder.label === "memory-group");
  const reserved = reservation();
  try {
    expect(reserved).toHaveLength(1);
    expect(reserved[0]!.declaredBytes).toBe(49 * PAGE_BYTES);
    expect(await grow(lease, [1, 16])).toEqual([
      { page: 1, bytes: 49 * PAGE_BYTES },
      { page: 2, bytes: 49 * PAGE_BYTES },
    ]);
    expect(groups.budget.committed).toBe(18 * PAGE_BYTES);
    expect(groups.owner(lease.group)!.snapshot().committedBytes).toBe(18 * PAGE_BYTES);
    expect(reservation()).toEqual(reserved);
  } finally {
    lease.stopped();
    runtime.dispose();
  }
  expect(groups.budget.committed).toBe(0);
});

test("stopped member pages are charged, reusable and zeroed until the group ends", async () => {
  const groups = new MemoryGroups({ maximumPages: 18, budgetBytes: 18 * PAGE_BYTES });
  const leader = groups.admit(1, "d", "new");
  const first = groups.admit(2, "d", leader.group);
  const owner = groups.owner(leader.group)!;
  try {
    const initial = await grow(first, [1, 16]);
    expect(initial.map((result) => result.page)).toEqual([1, 2]);
    new Uint8Array(leader.group.buffer(), PAGE_BYTES).fill(42);
    first.failed();
    expect(owner.snapshot()).toMatchObject({
      retained: 1,
      committedBytes: 18 * PAGE_BYTES,
      freeBytes: 0,
    });
    first.stopped();
    expect(owner.snapshot()).toMatchObject({
      retained: 0,
      committedBytes: 18 * PAGE_BYTES,
      freeBytes: 17 * PAGE_BYTES,
    });
    const second = groups.admit(3, "d", leader.group);
    try {
      expect(await grow(second, [1, 16])).toEqual([
        { page: 1, bytes: 18 * PAGE_BYTES },
        { page: 2, bytes: 18 * PAGE_BYTES },
      ]);
      expect(new Uint8Array(leader.group.buffer(), PAGE_BYTES).some(Boolean)).toBe(false);
      expect(groups.budget.committed).toBe(18 * PAGE_BYTES);
      expect(owner.snapshot().freeBytes).toBe(0);
    } finally {
      second.stopped();
    }
  } finally {
    first.stopped();
    leader.abort();
  }
  expect(groups.budget.committed).toBe(0);
  expect(groups.snapshot()).toEqual([]);
});
