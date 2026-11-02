import { expect, test } from "bun:test";
import { sharedArrayBufferMaxByteLength } from "../proc/intrinsics.js";
import {
  FilesystemRequestPool,
  FilesystemRequestAllocator,
  createRequestBudget,
  releaseRequestBuffer,
  receiveRequestBuffer,
  requestCells,
  requestBytes,
  requestMemoryResources,
  createRequestArenaData,
  FALLBACK_REQUEST_CONNECTION_BYTES,
  FILESYSTEM_REQUEST_LIMITS,
  closeRequestMemory,
  retireRequestMemory,
  requestTransportError,
  cancelRequestBuffer,
  requestCancelled,
  REQUEST_CLIENT,
  REQUEST_SERVICE,
} from "../fs/request-memory.js";

function fixture(maximum = 1024 * 1024) {
  const budget = createRequestBudget(undefined, maximum);
  const pool = new FilesystemRequestPool(budget);
  const revocation = new SharedArrayBuffer(4);
  const memory = pool.take(revocation);
  return { budget, pool, revocation, memory, allocator: new FilesystemRequestAllocator(memory) };
}
function release(buffer: ReturnType<FilesystemRequestAllocator["allocate"]>) {
  releaseRequestBuffer(buffer, REQUEST_CLIENT);
  releaseRequestBuffer(buffer, REQUEST_SERVICE);
}

test("retries an oversized arena reservation at the small-tab cap", () => {
  const attempts: number[] = [];
  const data = createRequestArenaData((_bytes, maximum) => {
    attempts.push(maximum);
    if (maximum === FILESYSTEM_REQUEST_LIMITS.connectionBytes)
      throw new RangeError("simulated small-tab reservation failure");
    return new SharedArrayBuffer(0, { maxByteLength: maximum });
  });
  expect(attempts).toEqual([
    FILESYSTEM_REQUEST_LIMITS.connectionBytes,
    FALLBACK_REQUEST_CONNECTION_BYTES,
  ]);
  expect(sharedArrayBufferMaxByteLength(data)).toBe(FALLBACK_REQUEST_CONNECTION_BYTES);
});

test("does not retry non-allocation arena failures", () => {
  let attempts = 0;
  expect(() =>
    createRequestArenaData((_bytes, _maximum) => {
      attempts++;
      throw new Error("transport setup failed");
    }),
  ).toThrow("transport setup failed");
  expect(attempts).toBe(1);
});

test("live request connections keep separate small-tab arenas", () => {
  const budget = createRequestBudget();
  const pool = new FilesystemRequestPool(budget, FALLBACK_REQUEST_CONNECTION_BYTES);
  const first = pool.take(new SharedArrayBuffer(4));
  const second = pool.take(new SharedArrayBuffer(4));
  expect(first.data).not.toBe(second.data);
  expect(requestMemoryResources(first).maximumBytes).toBe(FALLBACK_REQUEST_CONNECTION_BYTES);
  expect(requestMemoryResources(second).maximumBytes).toBe(FALLBACK_REQUEST_CONNECTION_BYTES);
});
test("request bytes and status use prepublished memory and preserve independent concurrent requests", () => {
  const f = fixture();
  const a = f.allocator.allocate(16),
    b = f.allocator.allocate(128);
  requestBytes(a).set([65, 66]);
  requestCells(a)[0] = 1;
  const remote = receiveRequestBuffer(f.memory, a.id, f.memory.generation, a.offset, a.length);
  expect(Array.from(requestBytes(remote).subarray(0, 2))).toEqual([65, 66]);
  expect(requestCells(remote)[0]).toBe(1);
  expect(a.offset).not.toBe(b.offset);
  expect(requestCells(b)[0]).toBe(0);
  expect(requestMemoryResources(f.memory).requests).toBe(2);
  release(a);
  release(b);
  expect(requestMemoryResources(f.memory).requests).toBe(0);
});
test("cancellation keeps service-owned bytes reserved and late release cannot touch a reused request", () => {
  const f = fixture();
  const a = f.allocator.allocate(64);
  cancelRequestBuffer(a);
  releaseRequestBuffer(a, REQUEST_CLIENT);
  expect(requestCancelled(a)).toBe(true);
  expect(requestMemoryResources(f.memory).requests).toBe(1);
  const b = f.allocator.allocate(64);
  expect(b.offset).not.toBe(a.offset);
  releaseRequestBuffer(a, REQUEST_SERVICE);
  const c = f.allocator.allocate(64);
  expect(c.offset).toBe(a.offset);
  cancelRequestBuffer(a);
  releaseRequestBuffer(a, REQUEST_SERVICE);
  expect(requestCancelled(c)).toBe(false);
  expect(requestMemoryResources(f.memory).requests).toBe(2);
  release(b);
  release(c);
});
test("freed adjacent requests coalesce and retained backing is bounded across connections", () => {
  const f = fixture(2048);
  const a = f.allocator.allocate(256),
    b = f.allocator.allocate(256);
  release(a);
  release(b);
  const before = requestMemoryResources(f.memory).retainedBytes;
  const joined = f.allocator.allocate(512);
  expect(requestMemoryResources(f.memory).retainedBytes).toBe(before);
  expect(() => f.allocator.allocate(2048)).toThrow("quota exhausted");
  expect(requestMemoryResources(f.memory).retainedBytes).toBeLessThanOrEqual(2048);
  release(joined);
});
test("pool reuse requires both service retirement and authoritative reap, and fences every late write", () => {
  const f = fixture();
  const old = f.allocator.allocate(64);
  retireRequestMemory(f.memory);
  const live = f.pool.take(new SharedArrayBuffer(4));
  expect(live.data).not.toBe(f.memory.data);
  Atomics.store(new Int32Array(f.revocation), 0, 2);
  const replacement = f.pool.take(new SharedArrayBuffer(4));
  expect(replacement.data).toBe(f.memory.data);
  const next = new FilesystemRequestAllocator(replacement).allocate(64);
  cancelRequestBuffer(old);
  release(old);
  closeRequestMemory(f.memory);
  retireRequestMemory(f.memory);
  expect(requestCancelled(next)).toBe(false);
  expect(requestTransportError(replacement)).toBeUndefined();
  expect(requestMemoryResources(replacement).requests).toBe(1);
  expect(() =>
    receiveRequestBuffer(replacement, old.id, f.memory.generation, old.offset, old.length),
  ).toThrow("incarnation");
  release(next);
});

test("single-thread releases keep physical byte accounting exact", () => {
  const f = fixture();
  const live: ReturnType<FilesystemRequestAllocator["allocate"]>[] = [];
  for (let index = 0; index < 300000; index++) {
    const buffer = f.allocator.allocate((index * 7919) % 200);
    releaseRequestBuffer(buffer, REQUEST_CLIENT);
    live.push(buffer);
    if (live.length > 64) releaseRequestBuffer(live.shift()!, REQUEST_SERVICE);
  }
  for (const buffer of live) releaseRequestBuffer(buffer, REQUEST_SERVICE);
  expect(requestMemoryResources(f.memory)).toMatchObject({ pendingBytes: 0, requests: 0 });
});

function drainBacklog(q: Int32Array, written: number): void {
  while (written - Atomics.load(q, 2) > 64) {}
}

test("racing client-first and service-last releases preserves physical accounting", async () => {
  const f = fixture();
  const ring = new SharedArrayBuffer((4 + 4096 * 3) * 4);
  const q = new Int32Array(ring);
  const worker = new Worker(
    new URL("./fixtures/filesystem-request-release-worker.ts", import.meta.url).href,
  );
  const done = Promise.withResolvers<void>();
  worker.onmessage = () => done.resolve();
  worker.onerror = (event) => done.reject(new Error(event.message));
  let written = 0;
  try {
    worker.postMessage({ memory: f.memory, ring });
    while (written < 100000) {
      drainBacklog(q, written);
      const buffer = f.allocator.allocate((written * 7919) % 200);
      releaseRequestBuffer(buffer, REQUEST_CLIENT);
      const slot = 4 + (written % 4096) * 3;
      q[slot] = buffer.id;
      q[slot + 1] = buffer.offset;
      q[slot + 2] = buffer.length;
      written++;
      Atomics.store(q, 0, written);
    }
    Atomics.store(q, 1, 1);
    await done.promise;
  } finally {
    Atomics.store(q, 1, 1);
    await worker.terminate();
  }
  expect(requestMemoryResources(f.memory)).toMatchObject({
    pendingBytes: 0,
    requests: 0,
    namespaceRequests: 0,
  });
}, 10000);
