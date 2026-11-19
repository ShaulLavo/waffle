import { afterEach, expect, test } from "bun:test";
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

const channels: MessageChannel[] = [];
function retainedPorts(): Set<MessagePort> {
  const ports: unknown = Reflect.get(FilesystemRequestPool, "formerServicePorts");
  if (!(ports instanceof Set)) throw Error("missing private former service ports");
  return ports;
}
afterEach(() => {
  for (const channel of channels.splice(0)) {
    retainedPorts().delete(channel.port2);
    channel.port1.close();
    channel.port2.close();
  }
});
function connection(pool: FilesystemRequestPool) {
  const revocation = new SharedArrayBuffer(4);
  const memory = pool.take(revocation);
  const channel = new MessageChannel();
  channels.push(channel);
  pool.retainServiceSender(memory, channel.port2).transferred = true;
  return { revocation, memory, port: channel.port2 };
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
  for (const peer of [live, unreaped, unretired, copying, failed])
    expect(retainedPorts().has(peer.port)).toBe(true);
  for (const peer of [safe, excess]) expect(retainedPorts().has(peer.port)).toBe(false);
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
  expect(retainedPorts().has(failed.port)).toBe(true);
  expect(retainedPorts().has(copying.port)).toBe(false);
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
  for (const peer of peers) expect(retainedPorts().has(peer.port)).toBe(false);
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

test("final release preserves uncertain lifetimes and settles eligible arenas once", () => {
  const pool = new FilesystemRequestPool(createRequestBudget(), 65536);
  const live = connection(pool);
  const unreaped = connection(pool);
  const unretired = connection(pool);
  const copying = connection(pool);
  const failed = connection(pool);
  const safe = connection(pool);
  const excess = connection(pool);
  retireRequestMemory(unreaped.memory);
  Atomics.store(new Int32Array(unretired.revocation), 0, 2);
  Atomics.add(new BigInt64Array(copying.memory.control), 7, 1n);
  retire(copying);
  retire(failed, 29);
  const abandoned = new FilesystemRequestAllocator(safe.memory).allocate(16, 100);
  retire(safe);
  retire(excess);
  const before = requestBudgetBytes(pool.budget);
  pool.releaseRetired();
  const kept = [live, unreaped, unretired, copying, failed].map((peer) => peer.memory);
  for (const peer of [live, unreaped, unretired, copying, failed])
    expect(retainedPorts().has(peer.port)).toBe(true);
  for (const peer of [safe, excess]) expect(retainedPorts().has(peer.port)).toBe(false);
  expectOwned(pool, kept);
  expect(requestMemoryResources(live.memory).namespaceRequests).toBe(0);
  expect(requestTransportError(safe.memory)?.reason).toBe("stale");
  expect(requestBudgetBytes(pool.budget)).toBe(before);
  pool.releaseRetired();
  expectOwned(pool, kept);
  for (const peer of [live, unreaped, unretired, copying, failed])
    expect(retainedPorts().has(peer.port)).toBe(true);
  releaseRequestBuffer(abandoned, REQUEST_CLIENT);
  releaseRequestBuffer(abandoned, REQUEST_SERVICE);
  expect(requestBudgetBytes(pool.budget)).toBe(before);
  Atomics.sub(new BigInt64Array(copying.memory.control), 7, 1n);
  pool.releaseRetired();
  expect(retainedPorts().has(copying.port)).toBe(false);
  expectOwned(
    pool,
    [live, unreaped, unretired, failed].map((peer) => peer.memory),
  );
  const later = connection(pool);
  expect(later.memory.data).not.toBe(safe.memory.data);
  expect(later.memory.data).not.toBe(failed.memory.data);
  const request = new FilesystemRequestAllocator(later.memory).allocate(16);
  releaseRequestBuffer(request, REQUEST_CLIENT);
  releaseRequestBuffer(request, REQUEST_SERVICE);
});

test("sender ownership binds the exact control object and generation before arena reuse", () => {
  const pool = new FilesystemRequestPool(createRequestBudget(), 65536);
  const first = connection(pool);
  const other = new MessageChannel();
  channels.push(other);
  for (const stale of [
    { ...first.memory, control: new SharedArrayBuffer(REQUEST_CONTROL_BYTES) },
    { ...first.memory, generation: first.memory.generation + 1 },
  ]) {
    expect(() => pool.retainServiceSender(stale, other.port2)).toThrow();
    pool.cancelServiceSender(stale, first.port);
    expect(retainedPorts().has(first.port)).toBe(true);
    expect(retainedPorts().has(other.port2)).toBe(false);
  }
  expect(() => pool.retainServiceSender(first.memory, other.port2)).toThrow();
  pool.cancelServiceSender(first.memory, first.port);
  expect(retainedPorts().has(first.port)).toBe(true);
  retire(first);
  // Observe inside control allocation: settlement has already dropped the old wrapper.
  const allocate = Reflect.get(pool, "createControl");
  Reflect.set(pool, "createControl", function (this: FilesystemRequestPool) {
    expect(retainedPorts().has(first.port)).toBe(false);
    return Reflect.apply(allocate, this, []);
  });
  const second = connection(pool);
  expect(second.memory.data).toBe(first.memory.data);
  expect(second.memory.control).not.toBe(first.memory.control);
  expect(second.memory.generation).not.toBe(first.memory.generation);
  expect(retainedPorts().has(second.port)).toBe(true);
  expect(() => pool.retainServiceSender(first.memory, other.port2)).toThrow();
  pool.cancelServiceSender(first.memory, second.port);
  retireRequestMemory(first.memory);
  pool.releaseRetired();
  expect(retainedPorts().has(second.port)).toBe(true);
  retire(second);
  pool.releaseRetired();
  pool.releaseRetired();
  expect(retainedPorts().has(second.port)).toBe(false);
});

test("only an exact provisional sender can be cancelled", () => {
  const pool = new FilesystemRequestPool(createRequestBudget(), 65536);
  const memory = pool.take(new SharedArrayBuffer(4));
  const channel = new MessageChannel();
  channels.push(channel);
  for (const stale of [
    { ...memory, control: new SharedArrayBuffer(REQUEST_CONTROL_BYTES) },
    { ...memory, generation: memory.generation + 1 },
  ]) {
    expect(() => pool.retainServiceSender(stale, channel.port2)).toThrow();
    expect(retainedPorts().has(channel.port2)).toBe(false);
  }
  const sender = pool.retainServiceSender(memory, channel.port2);
  pool.cancelServiceSender({ ...memory, generation: memory.generation + 1 }, channel.port2);
  pool.cancelServiceSender(
    { ...memory, control: new SharedArrayBuffer(REQUEST_CONTROL_BYTES) },
    channel.port2,
  );
  pool.cancelServiceSender(memory, channel.port1);
  expect(retainedPorts().has(channel.port2)).toBe(true);
  expect(sender.transferred).toBe(false);
  pool.cancelServiceSender(memory, channel.port2);
  expect(retainedPorts().has(channel.port2)).toBe(false);
  pool.cancelServiceSender(memory, channel.port2);
  pool.retainServiceSender(memory, channel.port2).transferred = true;
  pool.cancelServiceSender(memory, channel.port2);
  expect(retainedPorts().has(channel.port2)).toBe(true);
  // Remove every pool-owned local arena reference; only bare ports remain globally rooted.
  Reflect.set(pool, "arenas", []);
  expect(Array.from(retainedPorts()).every((port) => port instanceof MessagePort)).toBe(true);
  expect(retainedPorts().has(channel.port2)).toBe(true);
});

test("private sender roots use captured collection operations", () => {
  const pool = new FilesystemRequestPool(createRequestBudget(), 65536);
  const memory = pool.take(new SharedArrayBuffer(4));
  const channel = new MessageChannel();
  channels.push(channel);
  const add = Set.prototype.add;
  const remove = Set.prototype.delete;
  const unexpected = () => {
    throw Error("mutable collection operation observed a private port");
  };
  try {
    Set.prototype.add = unexpected;
    Set.prototype.delete = unexpected;
    pool.retainServiceSender(memory, channel.port2);
    pool.cancelServiceSender(memory, channel.port2);
  } finally {
    Set.prototype.add = add;
    Set.prototype.delete = remove;
  }
  expect(retainedPorts().has(channel.port2)).toBe(false);
});

/** Every distinct SharedArrayBuffer the value strongly references, through own properties,
 * arrays, maps and sets. Like expectOwned, this inspects ownership directly instead of GC. */
function ownedSharedBuffers(root: object): Set<SharedArrayBuffer> {
  const buffers = new Set<SharedArrayBuffer>();
  const seen = new Set<unknown>();
  const pending: unknown[] = [root];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof SharedArrayBuffer) buffers.add(value);
    else if (ArrayBuffer.isView(value)) pending.push(value.buffer);
    else if (value instanceof Map) pending.push(...value.keys(), ...value.values());
    else if (value instanceof Set) pending.push(...value);
    else for (const key of Reflect.ownKeys(value)) pending.push(Reflect.get(value, key));
  }
  return buffers;
}

test("a long-lived pool does not keep the control of every connection it ever served", () => {
  const budget = createRequestBudget();
  const pool = new FilesystemRequestPool(budget, 65536);
  const baseline = ownedSharedBuffers(pool).size;
  const controls = new Set<SharedArrayBuffer>();
  for (let round = 0; round < 1000; round++) {
    const peer = connection(pool);
    controls.add(peer.memory.control);
    retire(peer);
  }
  expect(controls.size).toBe(1000);
  const owned = ownedSharedBuffers(pool);
  // The budget plus the one reusable arena's data, control and revocation word: nothing per
  // past connection.
  expect(owned.size).toBeLessThanOrEqual(baseline + 3);
  expect(Array.from(controls).filter((control) => owned.has(control)).length).toBeLessThanOrEqual(
    1,
  );
});
