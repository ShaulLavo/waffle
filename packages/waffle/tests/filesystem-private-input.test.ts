import { expect, test } from "bun:test";
import {
  FilesystemClient,
  FilesystemError,
  FilesystemService,
  MemoryBackend,
  connectFilesystemIdentity,
  createFilesystemConnection,
  createFilesystemIdentity,
  type FilesystemConnection,
} from "../fs/index.js";
import { DirtyCapacityError } from "../fs/dirty-admission.js";
import { State, isRevoked, pack, reapFilesystem, revokeFilesystem } from "../fs/protocol.js";
import {
  FILESYSTEM_REQUEST_LIMITS,
  FilesystemRequestAllocator,
  FilesystemRequestPool,
  REQUEST_ARENA_BYTES,
  REQUEST_CLIENT,
  REQUEST_CONTROL_BYTES,
  REQUEST_INLINE_BYTES,
  REQUEST_SERVICE,
  createRequestBudget,
  receiveRequestBuffer,
  releaseRequestBuffer,
  requestBudgetBytes,
  requestBytes,
  requestCells,
  requestLengths,
  requestMemoryResources,
  requestMemoryRetired,
  requestMemoryRetirementError,
  requestTransportError,
  retireRequestMemory,
  type FilesystemRequestBuffer,
  type FilesystemRequestMemory,
} from "../fs/request-memory.js";
import { UNBOUNDED_ARENA_BYTES } from "../memory/reservations.js";

const PAGE = 65_536;
const MiB = 2 ** 20;
const BLOCK = 65_584;

function namespace(maximum = 16 * MiB, arena = REQUEST_ARENA_BYTES) {
  const budget = createRequestBudget(undefined, maximum);
  const pool = new FilesystemRequestPool(budget, arena);
  const revocation = new SharedArrayBuffer(4);
  const memory = pool.take(revocation);
  return { budget, pool, revocation, memory };
}
function connection(maximum?: number, arena?: number, limit?: number) {
  const space = namespace(maximum, arena);
  return { ...space, allocator: new FilesystemRequestAllocator(space.memory, limit) };
}
function release(buffer: FilesystemRequestBuffer): void {
  releaseRequestBuffer(buffer, REQUEST_CLIENT);
  releaseRequestBuffer(buffer, REQUEST_SERVICE);
}
function counters(memory: FilesystemRequestMemory) {
  const { requests, pendingBytes, privateBytes, namespaceRequests } =
    requestMemoryResources(memory);
  return { requests, pendingBytes, privateBytes, namespaceRequests };
}
const EMPTY = { requests: 0, pendingBytes: 0, privateBytes: 0, namespaceRequests: 0 };
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
function errnoOf(run: () => unknown): number | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof FilesystemError) return error.errno;
    throw error;
  }
  return undefined;
}

test("sizing constants agree across the transport and the memory ledger", () => {
  expect(REQUEST_INLINE_BYTES).toBe(PAGE);
  expect(REQUEST_CONTROL_BYTES).toBe(72);
  expect(REQUEST_ARENA_BYTES).toBe(2 * 1024 * BLOCK);
  expect(UNBOUNDED_ARENA_BYTES).toBe(REQUEST_ARENA_BYTES);
  expect(FILESYSTEM_REQUEST_LIMITS.connectionBytes).toBe(2_147_479_552);
});

test("the full private length is charged, not the logical difference", () => {
  const f = connection();
  const cold = requestBudgetBytes(f.budget);
  const buffer = f.allocator.allocate(PAGE, 65_537);
  expect(buffer.privateBytes).toBe(65_537);
  expect(requestCells(buffer)[7]).toBe(65_537);
  expect(requestMemoryResources(f.memory)).toMatchObject({
    privateBytes: 65_537,
    pendingBytes: 65_600,
    requests: 1,
    namespaceRequests: 1,
  });
  expect(requestBudgetBytes(f.budget) - cold).toBe(BLOCK + 65_537);
  release(buffer);
  expect(counters(f.memory)).toEqual(EMPTY);
  expect(requestBudgetBytes(f.budget) - cold).toBe(BLOCK);
});

test("inline requests still record a zero private length", () => {
  const f = connection();
  const buffer = f.allocator.allocate(1024);
  expect(buffer.privateBytes).toBe(0);
  expect(requestCells(buffer)[7]).toBe(0);
  expect(counters(f.memory)).toEqual({
    requests: 1,
    pendingBytes: 1072,
    privateBytes: 0,
    namespaceRequests: 1,
  });
  release(buffer);
});

test("private input fills the logical limit and refuses a later inline request", () => {
  const f = connection(16 * MiB, REQUEST_ARENA_BYTES, 131_072);
  const held = f.allocator.allocate(1024, 130_000);
  expect(requestMemoryResources(f.memory).pendingBytes).toBe(130_048);
  const before = counters(f.memory);
  expect(() => f.allocator.allocate(2000)).toThrow(
    "filesystem connection request memory exhausted",
  );
  expect(errnoOf(() => f.allocator.allocate(2000))).toBe(48);
  expect(counters(f.memory)).toEqual(before);
  release(held);
  const retried = f.allocator.allocate(2000);
  expect(requestMemoryResources(f.memory).pendingBytes).toBe(2048);
  release(retried);
});

test("the largest total packed input is exact and one more byte is refused", () => {
  const f = connection(8 * 2 ** 30);
  const largest = f.allocator.allocate(1024, 2_147_479_504);
  expect(requestMemoryResources(f.memory)).toMatchObject({
    pendingBytes: 2_147_479_552,
    privateBytes: 2_147_479_504,
  });
  expect(errnoOf(() => f.allocator.allocate(0))).toBe(48);
  release(largest);
  expect(() => f.allocator.allocate(1024, 2_147_479_505)).toThrow(
    "filesystem connection request memory exhausted",
  );
  expect(counters(f.memory)).toEqual(EMPTY);
});

test("the outstanding request limit still applies to private requests", () => {
  const f = connection(8 * 2 ** 30);
  const held: FilesystemRequestBuffer[] = [];
  for (let index = 0; index < FILESYSTEM_REQUEST_LIMITS.outstanding; index++)
    held.push(f.allocator.allocate(0, 70_000));
  expect(errnoOf(() => f.allocator.allocate(0, 70_000))).toBe(6);
  expect(errnoOf(() => f.allocator.allocate(0))).toBe(6);
  expect(requestMemoryResources(f.memory).requests).toBe(1024);
  for (const buffer of held) release(buffer);
  expect(counters(f.memory)).toEqual(EMPTY);
});

test("a placement failure undoes the count, logical debit and private charge once", () => {
  const f = connection(16 * MiB, 1024);
  const before = requestBudgetBytes(f.budget);
  expect(() => f.allocator.allocate(2048, 70_000)).toThrow(
    "filesystem connection request memory exhausted",
  );
  expect(counters(f.memory)).toEqual(EMPTY);
  expect(requestBudgetBytes(f.budget)).toBe(before);
});

test("a namespace refusal undoes the logical debit and never reaches placement", () => {
  const f = connection(131_200);
  const held = f.allocator.allocate(1024, 70_000);
  const before = requestBudgetBytes(f.budget);
  expect(() => f.allocator.allocate(1024, 70_000)).toThrow(
    "filesystem request memory quota exhausted",
  );
  expect(requestBudgetBytes(f.budget)).toBe(before);
  expect(requestMemoryResources(f.memory)).toMatchObject({
    requests: 1,
    privateBytes: 70_000,
    pendingBytes: 70_048,
  });
  release(held);
});

test("arena growth RangeError rolls back and reports errno 48", () => {
  const f = connection();
  Reflect.defineProperty(f.allocator, "grow", {
    value() {
      throw new RangeError("simulated arena growth refusal");
    },
  });
  const before = requestBudgetBytes(f.budget);
  expect(errnoOf(() => f.allocator.allocate(1024, 70_000))).toBe(48);
  expect(errnoOf(() => f.allocator.allocate(1024))).toBe(48);
  expect(counters(f.memory)).toEqual(EMPTY);
  expect(requestBudgetBytes(f.budget)).toBe(before);
});

test("non-allocation growth failures keep their own error and still roll back", () => {
  const f = connection();
  Reflect.defineProperty(f.allocator, "grow", {
    value() {
      throw new TypeError("simulated programming fault");
    },
  });
  expect(() => f.allocator.allocate(1024, 70_000)).toThrow(TypeError);
  expect(counters(f.memory)).toEqual(EMPTY);
});

test("client-first and service-first releases credit private and logical bytes once", () => {
  for (const order of [
    [REQUEST_CLIENT, REQUEST_SERVICE],
    [REQUEST_SERVICE, REQUEST_CLIENT],
  ] as const) {
    const f = connection();
    const warm = f.allocator.allocate(1024);
    release(warm);
    const baseline = requestBudgetBytes(f.budget);
    const buffer = f.allocator.allocate(1024, 70_000);
    expect(requestBudgetBytes(f.budget)).toBe(baseline + 70_000);
    releaseRequestBuffer(buffer, order[0]);
    const firstService = order[0] === REQUEST_SERVICE;
    expect(requestMemoryResources(f.memory)).toMatchObject({
      privateBytes: firstService ? 0 : 70_000,
      requests: 1,
      pendingBytes: 70_048,
    });
    expect(requestBudgetBytes(f.budget)).toBe(baseline + (firstService ? 0 : 70_000));
    releaseRequestBuffer(buffer, order[1]);
    releaseRequestBuffer(buffer, order[0]);
    releaseRequestBuffer(buffer, order[1]);
    expect(counters(f.memory)).toEqual(EMPTY);
    expect(requestBudgetBytes(f.budget)).toBe(baseline);
  }
});

test("successful retirement settles every remaining private byte exactly once", () => {
  const f = connection();
  const warm = f.allocator.allocate(1024);
  release(warm);
  const baseline = requestBudgetBytes(f.budget);
  const queued = f.allocator.allocate(1024, 70_000);
  const received = f.allocator.allocate(0, 80_000);
  releaseRequestBuffer(received, REQUEST_CLIENT);
  retireRequestMemory(f.memory);
  expect(requestMemoryRetired(f.memory)).toBe(true);
  // The zero-room block grew the arena by its 48-byte prefix and header.
  const settled = requestBudgetBytes(f.budget);
  expect(settled).toBe(baseline + 48);
  expect(requestMemoryResources(f.memory).privateBytes).toBe(0);
  retireRequestMemory(f.memory);
  releaseRequestBuffer(received, REQUEST_SERVICE);
  releaseRequestBuffer(queued, REQUEST_SERVICE);
  releaseRequestBuffer(queued, REQUEST_CLIENT);
  expect(requestBudgetBytes(f.budget)).toBe(settled);
});

test("late inline and private allocations are refused after successful retirement", () => {
  const f = connection();
  retireRequestMemory(f.memory);
  const before = requestBudgetBytes(f.budget);
  expect(() => f.allocator.allocate(1024)).toThrow("Filesystem connection incarnation is closed");
  expect(() => f.allocator.allocate(0, 70_000)).toThrow(
    "Filesystem connection incarnation is closed",
  );
  expect(counters(f.memory)).toEqual(EMPTY);
  expect(requestBudgetBytes(f.budget)).toBe(before);
});

test("retirement with an errno keeps private debt until a matching release", () => {
  const f = connection();
  const warm = f.allocator.allocate(1024);
  release(warm);
  const baseline = requestBudgetBytes(f.budget);
  const live = f.allocator.allocate(1024, 70_000);
  retireRequestMemory(f.memory, 29);
  expect(requestMemoryRetirementError(f.memory)).toBe(29);
  expect(requestBudgetBytes(f.budget)).toBe(baseline + 70_000);
  expect(requestMemoryResources(f.memory).privateBytes).toBe(70_000);
  releaseRequestBuffer(live, REQUEST_SERVICE);
  expect(requestBudgetBytes(f.budget)).toBe(baseline);
  releaseRequestBuffer(live, REQUEST_CLIENT);
  releaseRequestBuffer(live, REQUEST_SERVICE);
  expect(requestBudgetBytes(f.budget)).toBe(baseline);
});

test("a stale generation never refunds private bytes", () => {
  const f = connection();
  const buffer = f.allocator.allocate(1024, 70_000);
  retireRequestMemory(f.memory);
  Atomics.store(new Int32Array(f.revocation), 0, 2);
  const replacement = f.pool.take(new SharedArrayBuffer(4));
  const allocator = new FilesystemRequestAllocator(replacement);
  const next = allocator.allocate(1024, 70_000);
  const held = requestBudgetBytes(f.budget);
  release(buffer);
  expect(requestBudgetBytes(f.budget)).toBe(held);
  expect(requestMemoryResources(replacement).privateBytes).toBe(70_000);
  release(next);
});

test("pool reuse retains the new control word and stranded debt", () => {
  const f = connection();
  const stranded = f.allocator.allocate(0, 70_000);
  retireRequestMemory(f.memory, 29);
  Atomics.store(new Int32Array(f.revocation), 0, 2);
  const replacement = f.pool.take(new SharedArrayBuffer(4));
  expect(replacement.data).not.toBe(f.memory.data);
  expect(requestMemoryResources(replacement).privateBytes).toBe(0);
  release(stranded);
});

test("receivers bind the payload to the header and reject malformed brands", () => {
  const f = connection();
  const buffer = f.allocator.allocate(1024, 70_000);
  const receive = (payload?: unknown) =>
    receiveRequestBuffer(
      f.memory,
      buffer.id,
      f.memory.generation,
      buffer.offset,
      buffer.length,
      payload,
    );
  expect(errnoOf(() => receive())).toBe(28);
  expect(errnoOf(() => receive(new SharedArrayBuffer(70_000)))).toBe(28);
  expect(errnoOf(() => receive(new Uint8Array(70_000)))).toBe(28);
  expect(errnoOf(() => receive({ byteLength: 70_000 }))).toBe(28);
  expect(errnoOf(() => receive(new ArrayBuffer(69_999)))).toBe(28);
  expect(errnoOf(() => receive(new ArrayBuffer(70_001)))).toBe(28);
  const received = receive(new ArrayBuffer(70_000));
  expect(Object.isFrozen(received)).toBe(true);
  expect(received.privateBytes).toBe(70_000);
  expect(Object.values(received).some((value) => value instanceof ArrayBuffer)).toBe(false);
  release(buffer);

  const inline = f.allocator.allocate(1024);
  expect(
    errnoOf(() =>
      receiveRequestBuffer(
        f.memory,
        inline.id,
        f.memory.generation,
        inline.offset,
        inline.length,
        new ArrayBuffer(70_000),
      ),
    ),
  ).toBe(28);
  Atomics.store(requestCells(inline), 7, PAGE);
  expect(
    errnoOf(() =>
      receiveRequestBuffer(
        f.memory,
        inline.id,
        f.memory.generation,
        inline.offset,
        inline.length,
        new ArrayBuffer(PAGE),
      ),
    ),
  ).toBe(28);
  release(inline);
});

test("request lengths are validated against the actual input view", () => {
  const f = connection();
  const buffer = f.allocator.allocate(16, 70_000);
  const view = new Uint8Array(70_000);
  const cells = requestCells(buffer);
  cells[1] = 100;
  cells[2] = 69_900;
  expect(requestLengths(buffer, view)).toEqual({ inputLength: 100, dataLength: 69_900 });
  cells[2] = 69_901;
  expect(errnoOf(() => requestLengths(buffer, view))).toBe(28);
  cells[1] = -1;
  cells[2] = 0;
  expect(errnoOf(() => requestLengths(buffer, view))).toBe(28);
  cells[1] = 0;
  cells[2] = -1;
  expect(errnoOf(() => requestLengths(buffer, view))).toBe(28);
  release(buffer);
});

test("the first-fit proof holds across seeded churn and adversarial holes", () => {
  const f = connection(8 * 2 ** 30);
  const live: FilesystemRequestBuffer[] = [];
  let seed = 0x2545f491;
  const next = (bound: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  for (let round = 0; round < 40_000; round++) {
    if (live.length < 1023 && next(5)) {
      live.push(f.allocator.allocate(next(PAGE + 1)));
      continue;
    }
    if (live.length) release(live.splice(next(live.length), 1)[0]!);
  }
  for (const buffer of live) release(buffer);
  live.length = 0;
  for (let index = 0; index < 1024; index++) live.push(f.allocator.allocate(PAGE));
  for (let index = live.length - 1; index >= 0; index -= 2) release(live.splice(index, 1)[0]!);
  for (let index = 0; index < 512; index++) live.push(f.allocator.allocate(PAGE - 16));
  expect(requestMemoryResources(f.memory).requests).toBe(1024);
  for (const buffer of live) release(buffer);
  expect(counters(f.memory)).toEqual(EMPTY);
  expect(requestMemoryResources(f.memory).connectionBytes).toBeLessThanOrEqual(
    REQUEST_ARENA_BYTES + REQUEST_CONTROL_BYTES,
  );
});

interface Posted {
  message: Record<string, unknown>;
  transfer: readonly unknown[] | undefined;
}
function stoppedClient(budget: SharedArrayBuffer, pool: FilesystemRequestPool) {
  const identity = createFilesystemIdentity();
  const posted: Posted[] = [];
  const port = {
    start() {},
    close() {},
    postMessage(message: Record<string, unknown>, transfer?: Iterable<unknown>) {
      posted.push({ message, transfer: transfer ? Array.from(transfer) : undefined });
    },
  } as unknown as MessagePort;
  const requests = pool.take(identity.revocations[0]!);
  const connection: FilesystemConnection = { ...identity, port, requestBudget: budget, requests };
  return { client: new FilesystemClient(connection), posted, requests, connection };
}

test("a stopped receiver cannot queue past the namespace budget", () => {
  const budget = createRequestBudget(undefined, 131_200);
  const pool = new FilesystemRequestPool(budget, REQUEST_ARENA_BYTES);
  const f = stoppedClient(budget, pool);
  const first = f.client.submit("writeFile", ["/a"], new Uint8Array(70_000));
  expect(f.posted).toHaveLength(1);
  const retained = requestBudgetBytes(budget);
  expect(() => f.client.submit("writeFile", ["/b"], new Uint8Array(70_000))).toThrow(
    "filesystem request memory quota exhausted",
  );
  expect(f.posted).toHaveLength(1);
  expect(requestBudgetBytes(budget)).toBe(retained);
  first.release();
  expect(requestMemoryResources(f.requests).requests).toBe(1);
});

test("two connections in one namespace share the private reservation", () => {
  const budget = createRequestBudget(undefined, 131_200);
  const pool = new FilesystemRequestPool(budget, REQUEST_ARENA_BYTES);
  const first = stoppedClient(budget, pool);
  const second = stoppedClient(budget, pool);
  first.client.submit("writeFile", ["/a"], new Uint8Array(70_000));
  expect(() => second.client.submit("writeFile", ["/b"], new Uint8Array(70_000))).toThrow(
    "filesystem request memory quota exhausted",
  );
  expect(second.posted).toHaveLength(0);
});

test("private transfers carry a detached transferable, not a view", () => {
  const budget = createRequestBudget(undefined, 8 * MiB);
  const pool = new FilesystemRequestPool(budget, REQUEST_ARENA_BYTES);
  const f = stoppedClient(budget, pool);
  const data = new Uint8Array(70_000).fill(3);
  const completion = f.client.submit("writeFile", ["/a"], data, 200_000);
  const { message, transfer } = f.posted[0]!;
  const payload = message.payload as ArrayBuffer;
  expect(payload).toBeInstanceOf(ArrayBuffer);
  expect(transfer).toEqual([payload]);
  const packed = pack({ operation: "writeFile", args: ["/a"], publication: undefined });
  expect(completion.cells[1]).toBe(packed.length);
  expect(completion.cells[2]).toBe(70_000);
  expect(completion.cells[7]).toBe(packed.length + 70_000);
  expect(payload.byteLength).toBe(packed.length + 70_000);
  expect(completion.buffer.length).toBe(32 + PAGE);
  expect(new Uint8Array(payload).subarray(packed.length, packed.length + 2)).toEqual(
    new Uint8Array([3, 3]),
  );
  expect(data[0]).toBe(3);
  completion.release();
});

test("inputs at the inline threshold stay inline and one byte more becomes private", () => {
  const budget = createRequestBudget(undefined, 8 * MiB);
  const pool = new FilesystemRequestPool(budget, REQUEST_ARENA_BYTES);
  const f = stoppedClient(budget, pool);
  const packed = pack({ operation: "writeFile", args: ["/a"], publication: undefined }).length;
  const inline = f.client.submit("writeFile", ["/a"], new Uint8Array(PAGE - packed));
  expect(f.posted[0]!.message.payload).toBeUndefined();
  expect(f.posted[0]!.transfer).toBeUndefined();
  expect(inline.buffer.length).toBe(32 + PAGE);
  const large = f.client.submit("writeFile", ["/a"], new Uint8Array(PAGE - packed + 1));
  expect(f.posted[1]!.message.payload).toBeInstanceOf(ArrayBuffer);
  expect(large.buffer.privateBytes).toBe(PAGE + 1);
  inline.release();
  large.release();
});

test("malformed response capacity is refused before admission", () => {
  const budget = createRequestBudget(undefined, 8 * MiB);
  const pool = new FilesystemRequestPool(budget, REQUEST_ARENA_BYTES);
  const f = stoppedClient(budget, pool);
  for (const capacity of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1])
    expect(errnoOf(() => f.client.submit("read", [1, 1, 0], undefined, capacity))).toBe(28);
  expect(f.posted).toHaveLength(0);
  expect(requestMemoryResources(f.requests).requests).toBe(0);
});

test("a failed post rolls back both ownership bits and the private charge", () => {
  const budget = createRequestBudget(undefined, 8 * MiB);
  const pool = new FilesystemRequestPool(budget, REQUEST_ARENA_BYTES);
  const f = stoppedClient(budget, pool);
  const warm = f.client.submit("stat", [1]);
  warm.release();
  releaseRequestBuffer(warm.buffer, REQUEST_SERVICE);
  const baseline = requestBudgetBytes(budget);
  f.connection.port.postMessage = () => {
    throw new DOMException("simulated clone refusal", "DataCloneError");
  };
  expect(() => f.client.submit("writeFile", ["/a"], new Uint8Array(70_000))).toThrow(
    "simulated clone refusal",
  );
  expect(requestMemoryResources(f.requests)).toMatchObject({
    requests: 0,
    pendingBytes: 0,
    privateBytes: 0,
  });
  expect(requestBudgetBytes(budget)).toBe(baseline);
});

class ProbeBackend extends MemoryBackend {
  held: Uint8Array | undefined;
  readonly prepareEntered = Promise.withResolvers<void>();
  readonly prepareGate = Promise.withResolvers<void>();
  readonly executeEntered = Promise.withResolvers<void>();
  readonly executeGate = Promise.withResolvers<void>();
  gatePrepare = false;
  dirtyOnce = false;
  dirtyEntered = Promise.withResolvers<void>();
  dirtyGate = Promise.withResolvers<void>();
  prepare(operation: string, _args: any[], data: Uint8Array): void | Promise<void> {
    if (!this.gatePrepare || operation !== "gated") return;
    // The service prepares again after this resolves; gate only the first preparation.
    this.gatePrepare = false;
    this.held = data;
    this.prepareEntered.resolve();
    return this.prepareGate.promise;
  }
  waitForDirtyCapacity(_changed: number, _cancelled: () => boolean): Promise<void> {
    this.dirtyEntered.resolve();
    return this.dirtyGate.promise;
  }
  override execute(operation: string, args: any[], data: Uint8Array): unknown {
    switch (operation) {
      case "gated":
        return new Uint8Array([1]);
      case "dirty":
        if (this.dirtyOnce) {
          this.dirtyOnce = false;
          throw new DirtyCapacityError(false);
        }
        return new Uint8Array([2]);
      case "heldExecute":
        this.executeEntered.resolve();
        return this.executeGate.promise.then(() => new Uint8Array([3]));
      case "echo-subview":
        this.held = data;
        return data.subarray(1024, 1024 + 2048);
      case "echo-full":
        this.held = data;
        return data;
      case "echo-other":
        return new Uint8Array(4096).fill(8);
      case "fail-after-input":
        this.held = data;
        throw new FilesystemError(5);
      default:
        return super.execute(operation, args, data);
    }
  }
}
function served(backend: MemoryBackend = new ProbeBackend()) {
  const service = new FilesystemService(backend);
  const root = createFilesystemConnection();
  service.connect(root.server);
  const pairs = [root];
  const connect = (identity: ReturnType<typeof createFilesystemIdentity>) => {
    const pair = connectFilesystemIdentity(identity, root.pool);
    pairs.push(pair);
    service.connect(pair.server);
    return pair.client;
  };
  const client = new FilesystemClient(root.client, { connect });
  const clients = [client];
  const memory = root.client.requests;
  return {
    backend: backend as ProbeBackend,
    service,
    root,
    client,
    memory,
    peer() {
      const peer = new FilesystemClient(client.fork());
      clients.push(peer);
      return peer;
    },
    session(identity: FilesystemConnection = root.client) {
      const sessions = Reflect.get(service, "sessions") as Set<{
        connection: FilesystemConnection;
        requests: FilesystemRequestMemory;
        responses: Map<number, { kind: string; bytes?: Uint8Array }>;
        pending: Map<number, FilesystemRequestBuffer>;
        privateInputs: Map<number, Uint8Array>;
      }>;
      for (const session of sessions) if (session.requests === identity.requests) return session;
      for (const session of sessions)
        if (session.requests.control === identity.requests.control) return session;
      throw new Error("session missing");
    },
    cleanup() {
      for (const each of clients) each.dispose();
      service.dispose();
      for (const pair of pairs) {
        pair.client.port.close();
        pair.server.port.close();
      }
    },
  };
}
function bytesOfInput(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1021) bytes[index] = index % 251;
  return bytes;
}
async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
const privateOf = (memory: FilesystemRequestMemory) => requestMemoryResources(memory).privateBytes;

test("a 70 MiB write with metadata keeps the arena small", async () => {
  const f = served(new MemoryBackend());
  try {
    const data = bytesOfInput(70 * MiB + 3);
    await f.client.asyncCall("writeFile", ["/huge"], data);
    const read: Uint8Array = await f.client.asyncCall("readFile", ["/huge"]);
    expect(Buffer.compare(read, data)).toBe(0);
    expect(requestMemoryResources(f.memory).connectionBytes).toBeLessThan(MiB);
    expect(requestMemoryResources(f.memory)).toMatchObject({
      requests: 0,
      pendingBytes: 0,
      privateBytes: 0,
    });
  } finally {
    f.cleanup();
  }
}, 30000);

test("two concurrent 40 MiB inputs are held at once without shared backing", async () => {
  const f = served();
  try {
    const first = bytesOfInput(40 * MiB);
    const second = bytesOfInput(40 * MiB).fill(7, 0, 16);
    f.backend.gatePrepare = true;
    const held = f.client.submit("gated", [], first);
    await f.backend.prepareEntered.promise;
    const other = f.client.submit("writeFile", ["/second"], second);
    expect(privateOf(f.memory)).toBeGreaterThanOrEqual(80 * MiB);
    await other.value();
    other.release();
    f.backend.prepareGate.resolve();
    await held.value();
    held.release();
    await nextTurn();
    expect(requestMemoryResources(f.memory)).toMatchObject({ privateBytes: 0, requests: 0 });
    expect(requestMemoryResources(f.memory).connectionBytes).toBeLessThan(MiB);
  } finally {
    f.backend.prepareGate.resolve();
    f.cleanup();
  }
}, 30000);

test("older blocks keep their prefix and bytes as a private request arrives", () => {
  const f = connection();
  const older = f.allocator.allocate(1024);
  requestBytes(older).fill(9);
  const large = f.allocator.allocate(1024, 8 * MiB);
  expect(new Uint8Array(f.memory.data).length).toBeLessThan(MiB);
  expect(requestBytes(older)[0]).toBe(9);
  expect(requestBytes(older)[1023]).toBe(9);
  release(large);
  release(older);
});

test("gated preparation holds the view and the charge through cancel", async () => {
  const f = served();
  try {
    f.backend.gatePrepare = true;
    const completion = f.client.submit("gated", [], new Uint8Array(70_000));
    await f.backend.prepareEntered.promise;
    expect(privateOf(f.memory)).toBeGreaterThanOrEqual(70_000);
    expect(f.session().privateInputs.size).toBe(1);
    completion.cancel();
    completion.release();
    await nextTurn();
    expect(privateOf(f.memory)).toBeGreaterThanOrEqual(70_000);
    expect(f.session().privateInputs.size).toBe(1);
    expect(f.backend.held?.length).toBe(70_000);
    f.backend.prepareGate.resolve();
    await until(() => privateOf(f.memory) === 0, "private refund");
    expect(f.session().privateInputs.size).toBe(0);
  } finally {
    f.backend.prepareGate.resolve();
    f.cleanup();
  }
});

test("a dirty capacity retry retains the private input until it settles", async () => {
  const f = served();
  try {
    f.backend.dirtyOnce = true;
    const completion = f.client.submit("dirty", [], new Uint8Array(70_000));
    await f.backend.dirtyEntered.promise;
    expect(privateOf(f.memory)).toBeGreaterThanOrEqual(70_000);
    expect(f.session().privateInputs.size).toBe(1);
    f.backend.dirtyGate.resolve();
    await completion.value();
    completion.release();
    await until(() => privateOf(f.memory) === 0, "dirty private refund");
    expect(f.session().privateInputs.size).toBe(0);
  } finally {
    f.backend.dirtyGate.resolve();
    f.cleanup();
  }
});

test("stopping while parked keeps the charge until the work is joined", async () => {
  const f = served();
  const peer = f.peer();
  try {
    f.backend.gatePrepare = true;
    const completion = peer.submit("gated", [], new Uint8Array(70_000));
    await f.backend.prepareEntered.promise;
    const memory = peer.connection.requests;
    expect(privateOf(memory)).toBeGreaterThanOrEqual(70_000);
    expect(completion.ready).toBe(false);
    const session = f.session(peer.connection);
    peer.dispose();
    reapFilesystem(peer.connection);
    f.service.sweep();
    await nextTurn();
    expect(isRevoked(peer.connection)).toBe(true);
    expect(requestMemoryRetired(memory)).toBe(false);
    expect(privateOf(memory)).toBeGreaterThanOrEqual(70_000);
    expect(session.pending.size).toBe(0);
    expect(session.privateInputs.size).toBe(1);
    f.backend.prepareGate.resolve();
    await until(() => requestMemoryRetired(memory), "retirement");
    expect(session.privateInputs.size).toBe(0);
  } finally {
    f.backend.prepareGate.resolve();
    f.cleanup();
  }
});

test("an admitted client section fences retirement and refunds any late private bytes", async () => {
  const f = served();
  const peer = f.peer();
  try {
    const memory = peer.connection.requests;
    const allocator = Reflect.get(peer, "requests") as FilesystemRequestAllocator;
    const exit = peer.beginTransfer();
    revokeFilesystem(peer.connection);
    f.service.sweep();
    await nextTurn();
    expect(requestMemoryRetired(memory)).toBe(false);
    const late = allocator.allocate(1024, 70_000);
    expect(privateOf(memory)).toBe(70_000);
    const charged = requestBudgetBytes(memory.budget);
    exit();
    await until(() => requestMemoryRetired(memory), "retirement");
    expect(requestBudgetBytes(memory.budget)).toBe(charged - 70_000);
    expect(() => allocator.allocate(1024)).toThrow();
    expect(() => allocator.allocate(0, 70_000)).toThrow();
    release(late);
    expect(requestBudgetBytes(memory.budget)).toBe(charged - 70_000);
  } finally {
    f.cleanup();
  }
});

test("receipt of a private input does not refund until the request settles", async () => {
  const f = served();
  try {
    const completion = f.client.submit("heldExecute", [], new Uint8Array(70_000));
    await f.backend.executeEntered.promise;
    expect(privateOf(f.memory)).toBeGreaterThanOrEqual(70_000);
    f.backend.executeGate.resolve();
    await completion.value();
    completion.release();
    await until(() => privateOf(f.memory) === 0, "post-settle refund");
  } finally {
    f.backend.executeGate.resolve();
    f.cleanup();
  }
});

for (const [name, operation, length] of [
  ["subview", "echo-subview", 2048],
  ["full alias", "echo-full", 70_000],
] as const) {
  test(`an overflowing ${name} of the input gets its own right-sized backing`, async () => {
    const f = served();
    try {
      const data = new Uint8Array(70_000);
      for (let index = 0; index < data.length; index++) data[index] = index % 256;
      const completion = f.client.submit(operation, [], data);
      await until(() => completion.ready, "overflow response");
      expect(completion.cells[0]).toBe(State.Overflow);
      expect(completion.cells[2]).toBe(length);
      const response = f.session().responses.get(completion.id);
      expect(response?.bytes?.length).toBe(length);
      expect(response?.bytes?.buffer).not.toBe(f.backend.held!.buffer);
      expect(response?.bytes?.buffer.byteLength).toBe(length);
      expect(f.session().privateInputs.size).toBe(0);
      const value: Uint8Array = await completion.value();
      expect(value.length).toBe(length);
      expect(value[0]).toBe(name === "subview" ? 1024 % 256 : 0);
      await nextTurn();
      completion.release();
      await until(() => privateOf(f.memory) === 0, "alias refund");
      expect(f.session().responses.size).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  test(`a retained ${name} survives client-first discard and refunds both charges`, async () => {
    const f = served();
    try {
      const completion = f.client.submit(operation, [], new Uint8Array(70_000).fill(4));
      await until(() => completion.ready, "overflow response");
      const before = requestBudgetBytes(f.memory.budget);
      const charged = completion.buffer.privateBytes;
      completion.release();
      await until(() => f.session().responses.size === 0, "discard");
      await until(() => privateOf(f.memory) === 0, "private refund");
      expect(requestBudgetBytes(f.memory.budget)).toBe(before - charged - length);
    } finally {
      f.cleanup();
    }
  });
}

test("a quota failure while copying an alias reports errno 48 and releases everything", async () => {
  const f = served();
  try {
    const budget = new BigInt64Array(f.memory.budget);
    const headroom = BigInt(requestBudgetBytes(f.memory.budget) + 70_000 + 4096);
    Atomics.store(budget, 1, headroom + 1024n);
    const completion = f.client.submit("echo-full", [], new Uint8Array(70_000));
    const failure = await completion.value().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FilesystemError);
    expect((failure as FilesystemError).errno).toBe(48);
    completion.release();
    await until(() => privateOf(f.memory) === 0, "failed alias refund");
    expect(f.session().responses.size).toBe(0);
  } finally {
    f.cleanup();
  }
});

test("an allocation failure while copying an alias releases its response charge", async () => {
  const f = served();
  const native = Uint8Array.prototype.slice;
  try {
    const before = requestBudgetBytes(f.memory.budget);
    Uint8Array.prototype.slice = function (this: Uint8Array) {
      Uint8Array.prototype.slice = native;
      throw new RangeError("simulated copy allocation refusal");
    };
    const completion = f.client.submit("echo-subview", [], new Uint8Array(70_000));
    const failure = await completion.value().catch((error: unknown) => error);
    expect((failure as FilesystemError).errno).toBe(48);
    completion.release();
    await until(() => privateOf(f.memory) === 0, "failed copy refund");
    expect(requestBudgetBytes(f.memory.budget)).toBeLessThanOrEqual(before + BLOCK);
  } finally {
    Uint8Array.prototype.slice = native;
    f.cleanup();
  }
});

test("a non-aliased overflow keeps the backend result without a copy", async () => {
  const f = served();
  try {
    const completion = f.client.submit("echo-other", [], new Uint8Array(70_000));
    await until(() => completion.ready, "overflow response");
    const response = f.session().responses.get(completion.id);
    expect(response?.bytes?.buffer.byteLength).toBe(4096);
    completion.release();
    await until(() => f.session().responses.size === 0, "discard");
  } finally {
    f.cleanup();
  }
});

test("explicit oversized response capacity keeps physical blocks bounded and results complete", async () => {
  const f = served(new MemoryBackend());
  try {
    const data = bytesOfInput(200_000);
    await f.client.asyncCall("writeFile", ["/page"], data);
    const whole = f.client.submit("readFile", ["/page"], undefined, 1_000_000);
    expect(whole.buffer.length).toBe(32 + PAGE);
    expect(Buffer.compare(await whole.value(), data)).toBe(0);
    whole.release();

    const root: number = await f.client.asyncCall("preopen", ["/"]);
    const path = await f.client.asyncCall("resolve", [root, "page"]);
    const read = f.client.submit("read", [path.node, 200_000, 0], undefined, 400_000);
    expect(read.buffer.length).toBe(32 + PAGE);
    expect(Buffer.compare(await read.value(), data)).toBe(0);
    read.release();

    const outer = f.client.submit("readFile", ["/page"]);
    await until(() => outer.ready, "outer overflow");
    const part = f.client.submit("take", [outer.id, 0, 100_000], undefined, 300_000);
    expect(part.buffer.length).toBe(32 + PAGE);
    const slice: Uint8Array = await part.value();
    expect(slice.length).toBe(100_000);
    expect(Buffer.compare(slice, data.subarray(0, 100_000))).toBe(0);
    part.release();
    outer.release();
    await nextTurn();

    await f.client.asyncCall("mkdirp", ["/listing"]);
    for (let index = 0; index < 900; index++)
      await f.client.asyncCall(
        "writeFile",
        [`/listing/entry-${index}-${"n".repeat(180)}`],
        new Uint8Array([1]),
      );
    const directory: number = (await f.client.asyncCall("resolve", [root, "listing"])).node;
    const pageBytes = 500_000;
    const big = f.client.submit("readdirPage", [directory, 0n, pageBytes], undefined, pageBytes);
    expect(big.buffer.length).toBe(32 + PAGE);
    const listed: Uint8Array = await big.value();
    expect(listed.length).toBeGreaterThan(PAGE);
    big.release();
    const bounded = f.client.submit("readdirPage", [directory, 0n, pageBytes], undefined, PAGE);
    expect(Buffer.compare(listed, await bounded.value())).toBe(0);
    bounded.release();

    const cursor = await f.client.asyncCall("walkOpen", [
      directory,
      { include: [], exclude: [], excludeDirectories: [], hidden: true, maxDepth: null },
    ]);
    const options = { grant: false, maxEntries: 128 };
    const walk = f.client.submit("walkPage", [cursor, options], undefined, 4_000_000);
    expect(walk.buffer.length).toBe(32 + PAGE);
    const page = await walk.value();
    expect(pack(page).length).toBeLessThanOrEqual(PAGE);
    expect(page.entries.length).toBeGreaterThan(0);
    walk.release();
    await f.client.asyncCall("walkClose", [cursor]);
  } finally {
    f.cleanup();
  }
}, 30000);

function postRaw(
  connection: FilesystemConnection,
  buffer: FilesystemRequestBuffer,
  payload?: unknown,
  transfer?: Transferable[],
): void {
  const message = {
    id: buffer.id,
    generation: buffer.memory.generation,
    offset: buffer.offset,
    length: buffer.length,
    ...(payload === undefined ? {} : { payload }),
  };
  connection.port.postMessage(message, transfer ?? []);
}

test("a mismatched payload closes the transport without a per-message refund", async () => {
  const f = served();
  const peer = f.peer();
  try {
    const memory = peer.connection.requests;
    const allocator = Reflect.get(peer, "requests") as FilesystemRequestAllocator;
    const buffer = allocator.allocate(1024, 70_000);
    const charged = requestBudgetBytes(memory.budget);
    const wrong = new ArrayBuffer(69_999);
    postRaw(peer.connection, buffer, wrong, [wrong]);
    await until(() => !!requestTransportError(memory), "protocol close");
    expect(requestTransportError(memory)?.reason).toBe("protocol");
    // Only retirement settles the abandoned credit, and a late release cannot repeat it.
    await until(() => requestMemoryRetired(memory), "retirement");
    expect(requestBudgetBytes(memory.budget)).toBe(charged - 70_000);
    release(buffer);
    expect(requestBudgetBytes(memory.budget)).toBe(charged - 70_000);
  } finally {
    f.cleanup();
  }
});

test("a missing payload closes the transport as a protocol failure", async () => {
  const f = served();
  const peer = f.peer();
  try {
    const memory = peer.connection.requests;
    const allocator = Reflect.get(peer, "requests") as FilesystemRequestAllocator;
    const buffer = allocator.allocate(1024, 70_000);
    postRaw(peer.connection, buffer);
    await until(() => !!requestTransportError(memory), "protocol close");
    expect(requestTransportError(memory)?.reason).toBe("protocol");
    release(buffer);
  } finally {
    f.cleanup();
  }
});

test("malformed lengths in private content complete with errno 28 and refund", async () => {
  const f = served();
  const peer = f.peer();
  try {
    const memory = peer.connection.requests;
    const allocator = Reflect.get(peer, "requests") as FilesystemRequestAllocator;
    const buffer = allocator.allocate(1024, 70_000);
    const cells = requestCells(buffer);
    cells[1] = 70_001;
    cells[2] = 0;
    const payload = new ArrayBuffer(70_000);
    postRaw(peer.connection, buffer, payload, [payload]);
    await until(() => Atomics.load(cells, 0) !== State.Pending, "completion");
    expect(Atomics.load(cells, 0)).toBe(State.Failed);
    expect(cells[3]).toBe(28);
    expect(requestTransportError(memory)).toBeUndefined();
    await until(() => privateOf(memory) === 0, "content refund");
    releaseRequestBuffer(buffer, REQUEST_CLIENT);
    expect(counters(memory)).toMatchObject({ requests: 0, privateBytes: 0, pendingBytes: 0 });
  } finally {
    f.cleanup();
  }
});

test("a duplicate pending private request is a protocol failure and earns no refund", async () => {
  const f = served();
  const peer = f.peer();
  try {
    const memory = peer.connection.requests;
    const allocator = Reflect.get(peer, "requests") as FilesystemRequestAllocator;
    f.backend.gatePrepare = true;
    const buffer = allocator.allocate(1024, 70_000);
    const packed = pack({ operation: "gated", args: [] });
    const payload = new ArrayBuffer(70_000);
    new Uint8Array(payload).set(packed);
    const cells = requestCells(buffer);
    cells[1] = packed.length;
    cells[2] = 70_000 - packed.length;
    postRaw(peer.connection, buffer, payload, [payload]);
    await f.backend.prepareEntered.promise;
    const charged = requestBudgetBytes(memory.budget);
    const second = new ArrayBuffer(70_000);
    postRaw(peer.connection, buffer, second, [second]);
    await until(() => !!requestTransportError(memory), "duplicate close");
    expect(requestTransportError(memory)?.reason).toBe("protocol");
    expect(requestBudgetBytes(memory.budget)).toBe(charged);
    release(buffer);
  } finally {
    f.backend.prepareGate.resolve();
    f.cleanup();
  }
});

test("a replayed private message after completion and block reuse is stale", async () => {
  const f = served();
  const peer = f.peer();
  try {
    const memory = peer.connection.requests;
    const allocator = Reflect.get(peer, "requests") as FilesystemRequestAllocator;
    const buffer = allocator.allocate(1024, 70_000);
    const cells = requestCells(buffer);
    const packed = pack({ operation: "echo-other", args: [] });
    const payload = new ArrayBuffer(70_000);
    new Uint8Array(payload).set(packed);
    cells[1] = packed.length;
    cells[2] = 70_000 - packed.length;
    postRaw(peer.connection, buffer, payload, [payload]);
    await until(() => Atomics.load(cells, 0) !== State.Pending, "completion");
    releaseRequestBuffer(buffer, REQUEST_CLIENT);
    peer.connection.port.postMessage({ discard: buffer.id });
    await until(() => requestMemoryResources(memory).requests === 0, "release");
    expect(privateOf(memory)).toBe(0);
    const reused = allocator.allocate(1024, 70_000);
    expect(reused.offset).toBe(buffer.offset);
    const charged = requestBudgetBytes(memory.budget);
    const replay = new ArrayBuffer(70_000);
    postRaw(peer.connection, buffer, replay, [replay]);
    await until(() => !!requestTransportError(memory), "stale close");
    expect(requestTransportError(memory)?.reason).toBe("protocol");
    await until(() => requestMemoryRetired(memory), "retirement");
    expect(requestBudgetBytes(memory.budget)).toBe(charged - 70_000);
    release(reused);
    expect(requestBudgetBytes(memory.budget)).toBe(charged - 70_000);
  } finally {
    f.cleanup();
  }
});
