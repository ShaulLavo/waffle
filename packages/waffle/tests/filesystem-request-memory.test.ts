import { expect, test } from "bun:test";
import {
  FilesystemRequestPool,
  FilesystemRequestAllocator,
  createRequestBudget,
  releaseRequestBuffer,
  receiveRequestBuffer,
  requestCells,
  requestBytes,
  requestMemoryResources,
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
