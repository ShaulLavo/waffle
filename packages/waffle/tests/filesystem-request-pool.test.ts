import { expect, test } from "bun:test";
import {
  FilesystemRequestAllocator,
  FilesystemRequestPool,
  REQUEST_CLIENT,
  REQUEST_CONTROL_BYTES,
  REQUEST_SERVICE,
  createRequestBudget,
  releaseRequestBuffer,
  requestBudgetBytes,
  requestMemoryResources,
  requestTransportError,
  retireRequestMemory,
  type FilesystemRequestMemory,
} from "../fs/request-memory.js";

function connection(pool: FilesystemRequestPool) {
  const revocation = new SharedArrayBuffer(4);
  const memory = pool.take(revocation);
  return { revocation, memory };
}
function retire(peer: ReturnType<typeof connection>, errno = 0): void {
  retireRequestMemory(peer.memory, errno);
  Atomics.store(new Int32Array(peer.revocation), 0, 2);
}
function expectOwned(pool: FilesystemRequestPool, memories: readonly FilesystemRequestMemory[]) {
  // Inspect strong ownership directly. GC scheduling and WeakRef clearing are not the oracle.
  expect(Reflect.get(pool, "arenas")).toEqual(
    memories.map((memory) => expect.objectContaining({ data: memory.data })),
  );
}

test("each take releases a retired burst except the one arena reused for that take", () => {
  let allocations = 0;
  const budget = createRequestBudget();
  const pool = new FilesystemRequestPool(budget, 65536, {
    create() {
      allocations++;
      return new SharedArrayBuffer(0, { maxByteLength: 65536 });
    },
    strand() {
      throw new Error("successful retirement must not strand backing");
    },
  });
  for (let round = 0; round < 4; round++) {
    const burst = Array.from({ length: 8 }, () => connection(pool));
    expect(new Set(burst.map((peer) => peer.memory.data)).size).toBe(8);
    for (const peer of burst) retire(peer);
    // A final burst remains owned until another take observes remote retirement.
    expectOwned(
      pool,
      burst.map((peer) => peer.memory),
    );
    const reused = connection(pool);
    expect(reused.memory.data).toBe(burst[0]!.memory.data);
    expectOwned(pool, [reused.memory]);
    const before = allocations;
    retire(reused);
    const sequential = connection(pool);
    expect(sequential.memory.data).toBe(reused.memory.data);
    expect(allocations).toBe(before);
    retire(sequential);
  }
  expect(allocations).toBe(8 + 3 * 7);
});

test("sweep preserves live, unreaped, unretired, in-section and stranded arenas", () => {
  const stranded: SharedArrayBuffer[] = [];
  const pool = new FilesystemRequestPool(createRequestBudget(), 65536, {
    create: () => new SharedArrayBuffer(0, { maxByteLength: 65536 }),
    strand: (data) => stranded.push(data),
  });
  const live = connection(pool);
  const unreaped = connection(pool);
  const unretired = connection(pool);
  const copying = connection(pool);
  const failed = connection(pool);
  const safe = connection(pool);
  const excess = connection(pool);
  retireRequestMemory(unreaped.memory);
  Atomics.store(new Int32Array(unreaped.revocation), 0, 1);
  Atomics.store(new Int32Array(unretired.revocation), 0, 2);
  // Pause a counted transport section before retirement, without relying on thread timing.
  Atomics.add(new BigInt64Array(copying.memory.control), 7, 1n);
  retire(copying);
  retire(failed, 29);
  retire(safe);
  retire(excess);
  const reused = connection(pool);
  expect(reused.memory.data).toBe(safe.memory.data);
  expectOwned(
    pool,
    [live, unreaped, unretired, copying, failed, reused].map((p) => p.memory),
  );
  expect(stranded).toEqual([failed.memory.data]);
  expect(requestTransportError(live.memory)).toBeUndefined();
  expect(requestTransportError(copying.memory)).toBeUndefined();
  const liveRequest = new FilesystemRequestAllocator(live.memory).allocate(16);
  releaseRequestBuffer(liveRequest, REQUEST_CLIENT);
  releaseRequestBuffer(liveRequest, REQUEST_SERVICE);

  Atomics.sub(new BigInt64Array(copying.memory.control), 7, 1n);
  const afterCopy = connection(pool);
  expect(afterCopy.memory.data).toBe(copying.memory.data);
  expectOwned(
    pool,
    [live, unreaped, unretired, afterCopy, failed, reused].map((p) => p.memory),
  );
  // Even a later successful marker cannot undo already recorded stranded ownership/debt.
  retireRequestMemory(failed.memory);
  const later = connection(pool);
  expect(later.memory.data).not.toBe(failed.memory.data);
  expect(stranded).toEqual([failed.memory.data]);
  expectOwned(
    pool,
    [live, unreaped, unretired, afterCopy, failed, reused, later].map((p) => p.memory),
  );
});

test("released and reused arenas settle abandoned counts and private bytes exactly once", () => {
  const budget = createRequestBudget();
  const pool = new FilesystemRequestPool(budget, 65536);
  const peers = Array.from({ length: 3 }, () => connection(pool));
  const abandoned = peers.map((peer) =>
    new FilesystemRequestAllocator(peer.memory).allocate(16, 100),
  );
  const before = requestBudgetBytes(budget);
  for (const peer of peers) retire(peer);
  expect(requestBudgetBytes(budget)).toBe(before - 300);
  expect(requestMemoryResources(peers[0]!.memory).namespaceRequests).toBe(3);
  const reused = connection(pool);
  expectOwned(pool, [reused.memory]);
  expect(requestMemoryResources(reused.memory)).toMatchObject({
    namespaceRequests: 0,
    requests: 0,
    pendingBytes: 0,
    privateBytes: 0,
  });
  for (const peer of peers) expect(requestTransportError(peer.memory)?.reason).toBe("stale");
  const charge = requestBudgetBytes(budget);
  expect(charge).toBe(before - 300 + REQUEST_CONTROL_BYTES);
  for (const buffer of abandoned) {
    releaseRequestBuffer(buffer, REQUEST_CLIENT);
    releaseRequestBuffer(buffer, REQUEST_SERVICE);
  }
  for (const peer of peers) retireRequestMemory(peer.memory);
  expect(requestBudgetBytes(budget)).toBe(charge);
  expect(requestMemoryResources(reused.memory).namespaceRequests).toBe(0);
  expect(Reflect.get(pool, "receipts")).toHaveLength(4);
});

test("retirement errors keep abandoned request counts and private charges while safe peers release", () => {
  const budget = createRequestBudget();
  const pool = new FilesystemRequestPool(budget, 65536);
  const failed = connection(pool);
  const abandoned = new FilesystemRequestAllocator(failed.memory).allocate(16, 100);
  const safe = connection(pool);
  const excess = connection(pool);
  retire(failed, 29);
  retire(safe);
  retire(excess);
  const before = requestBudgetBytes(budget);
  const reused = connection(pool);
  expectOwned(pool, [failed.memory, reused.memory]);
  expect(requestBudgetBytes(budget)).toBe(before + REQUEST_CONTROL_BYTES);
  expect(requestMemoryResources(failed.memory)).toMatchObject({
    namespaceRequests: 1,
    requests: 1,
    privateBytes: 100,
  });
  releaseRequestBuffer(abandoned, REQUEST_CLIENT);
  releaseRequestBuffer(abandoned, REQUEST_SERVICE);
  expect(requestBudgetBytes(budget)).toBe(before + REQUEST_CONTROL_BYTES - 100);
  expect(requestMemoryResources(failed.memory).namespaceRequests).toBe(0);
  expectOwned(pool, [failed.memory, reused.memory]);
});

test("reuse allocation failure leaves the selected arena recoverable and excess arenas released", () => {
  const budget = createRequestBudget();
  let failControl = false;
  const pool = new FilesystemRequestPool(budget, 65536, undefined, (bytes, maximum) => {
    if (bytes === REQUEST_CONTROL_BYTES && failControl)
      throw new Error("control allocation failed");
    return new SharedArrayBuffer(bytes, { maxByteLength: maximum });
  });
  const peers = Array.from({ length: 3 }, () => connection(pool));
  const abandoned = peers.map((peer) => new FilesystemRequestAllocator(peer.memory).allocate(16));
  for (const peer of peers) retire(peer);
  const charged = requestBudgetBytes(budget);
  failControl = true;
  expect(() => connection(pool)).toThrow("control allocation failed");
  expectOwned(pool, [peers[0]!.memory]);
  expect(requestBudgetBytes(budget)).toBe(charged);
  expect(requestMemoryResources(peers[0]!.memory).namespaceRequests).toBe(0);
  expect(Reflect.get(pool, "receipts")).toHaveLength(3);
  failControl = false;
  const recovered = connection(pool);
  expect(recovered.memory.data).toBe(peers[0]!.memory.data);
  expect(new Uint8Array(recovered.memory.data).every((byte) => byte === 0)).toBe(true);
  for (const buffer of abandoned) {
    releaseRequestBuffer(buffer, REQUEST_CLIENT);
    releaseRequestBuffer(buffer, REQUEST_SERVICE);
  }
  expect(requestMemoryResources(recovered.memory).namespaceRequests).toBe(0);
});
