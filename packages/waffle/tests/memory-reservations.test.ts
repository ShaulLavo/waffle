import {
  createSharedControlAllocator,
  consumedControlBytes,
  CONTROL_GRANT_BYTES,
  CONTROL_GRANT_STATE_BYTES,
} from "../memory/control.js";
import { expect, test } from "bun:test";
import {
  SharedMemoryLedger,
  SharedMemoryAdmissionError,
  bytes,
  pages,
  declareSharedMemoryPlatform,
  UNBOUNDED_ARENA_BYTES,
  BOUNDED_ARENA_BYTES,
  PAGE_BYTES,
  type ReservationAllocator,
  type ProcessPlan,
} from "../memory/reservations.js";
import { defaultSharedMemoryPlatform, validateDeclaration } from "../memory/platform.js";
import {
  parseModuleMemory,
  declareModuleMemory,
  moduleMemoryDeclarations,
} from "../memory/declarations.js";
import {
  FilesystemRequestPool,
  createRequestBudget,
  retireRequestMemory,
} from "../fs/request-memory.js";
import { startFailure } from "../proc/start-failure.js";
import { ProcessError } from "../proc/errors.js";
import { MemoryGroups } from "../group/state.js";
import { GroupOp } from "../group/protocol.js";
const counts = { fixedBuffer: true, sharedMemory: true, privateMemory: true };
/** The advertised filesystem cap beyond the root's own first segment: 95 segments of 16 MiB. */
const SEGMENT_CAPACITY = 95 * 16 * 1024 ** 2;
const bounded = (n = 6 * 1024 ** 3) =>
  declareSharedMemoryPlatform({ kind: "bounded", budgetBytes: bytes(n), counts });
const unlimited = declareSharedMemoryPlatform({ kind: "unbounded" });
const plan = (n = 1): ProcessPlan => ({
  pid: 1,
  executable: "fixture",
  guest: {
    kind: "declared",
    memories: [{ kind: "private", origin: "defined", maximumPages: pages(n) }],
  },
  group: "none",
  connection: false,
  controls: false,
});
const allocations: ReservationAllocator = {
  buffer(shape) {
    return shape.kind === "fixed-buffer"
      ? new SharedArrayBuffer(shape.length)
      : new SharedArrayBuffer(shape.initial, { maxByteLength: shape.maximum });
  },
  memory(shape) {
    const max = shape.kind === "fixed" ? shape.pages : shape.maximumPages;
    return new WebAssembly.Memory({
      initial: shape.kind === "fixed" ? max : 1,
      maximum: max,
      shared: true,
    });
  },
};

test("unbounded sizing and actual bounded arena reservations stay pinned", () => {
  const unbounded = new SharedMemoryLedger(unlimited).openRuntime(unlimited);
  expect(unbounded.sizing.arena).toEqual({
    bytes: bytes(UNBOUNDED_ARENA_BYTES),
    fallback: bytes(BOUNDED_ARENA_BYTES),
  });
  expect(unbounded.sizing.groupShape()).toEqual({ kind: "growable", maximumPages: pages(65_536) });
  const runtime = new SharedMemoryLedger(bounded()).openRuntime(bounded());
  const arena = runtime.arenas.create(null);
  expect(arena.maxByteLength).toBe(BOUNDED_ARENA_BYTES);
  expect(runtime.sizing.groupShape()).toEqual({ kind: "fixed", pages: pages(16_384) });
  expect(runtime.snapshot().reservedBytes).toBe(BOUNDED_ARENA_BYTES);
});

test("guest declaration charge creates no page Memory and credits only successful physical stop", () => {
  let memoryCalls = 0;
  const ledger = new SharedMemoryLedger(bounded(), {
    ...allocations,
    memory(shape) {
      memoryCalls++;
      return allocations.memory(shape);
    },
  });
  const runtime = ledger.openRuntime(bounded());
  const ticket = runtime.admit(plan(2));
  expect(memoryCalls).toBe(0);
  expect(runtime.snapshot().reservedBytes).toBe(2 * PAGE_BYTES);
  const launched = ticket.launched();
  ticket.abort();
  expect(runtime.snapshot().reservedBytes).toBe(2 * PAGE_BYTES);
  launched.stopped();
  launched.stopped();
  expect(runtime.snapshot().reservedBytes).toBe(0);
  const failed = runtime.admit(plan(3)).launched();
  failed.failed([new Error("terminate failed")]);
  failed.stopped();
  expect(runtime.snapshot().debtBytes).toBe(3 * PAGE_BYTES);
});

test("atomic admission reserves guest plus real arena headroom without constructing either", () => {
  let calls = 0;
  const platform = bounded(BOUNDED_ARENA_BYTES + PAGE_BYTES);
  const runtime = new SharedMemoryLedger(platform, {
    ...allocations,
    buffer(shape) {
      calls++;
      return allocations.buffer(shape);
    },
  }).openRuntime(platform);
  const ticket = runtime.admit({ ...plan(), connection: true });
  expect(calls).toBe(0);
  expect(runtime.snapshot().reservedBytes).toBe(BOUNDED_ARENA_BYTES + PAGE_BYTES);
  expect(() => runtime.admit(plan())).toThrow(SharedMemoryAdmissionError);
  ticket.abort();
  ticket.abort();
  expect(runtime.snapshot().reservedBytes).toBe(0);
});

test("abort after actual request pool reuse retains the arena charge", () => {
  const runtime = new SharedMemoryLedger(bounded()).openRuntime(bounded());
  const pool = new FilesystemRequestPool(createRequestBudget(), undefined, runtime.arenas);
  const revoked = new SharedArrayBuffer(4);
  const first = pool.take(revoked);
  retireRequestMemory(first);
  Atomics.store(new Int32Array(revoked), 0, 2);
  const ticket = runtime.admit({ ...plan(0), connection: true });
  const second = pool.take(new SharedArrayBuffer(4), undefined, ticket.arena);
  expect(second.data).toBe(first.data);
  ticket.abort();
  expect(runtime.snapshot().reservedBytes).toBe(BOUNDED_ARENA_BYTES);
});

test("exact group shapes are distinct and all addressable dirty pages are scrubbed on reuse", () => {
  const runtime = new SharedMemoryLedger(bounded()).openRuntime(bounded());
  const first = runtime.groups.create({ kind: "fixed", pages: pages(4) }, null);
  new Uint8Array(first.memory.buffer)[3 * PAGE_BYTES + 7] = 123;
  runtime.groups.retire(first);
  const other = runtime.groups.create({ kind: "fixed", pages: pages(3) }, null);
  expect(other.memory).not.toBe(first.memory);
  const reused = runtime.groups.create({ kind: "fixed", pages: pages(4) }, null);
  expect(reused.memory).toBe(first.memory);
  expect(new Uint8Array(reused.memory.buffer)[3 * PAGE_BYTES + 7]).toBe(0);
  reused.exposed = true;
  runtime.groups.retire(reused);
  expect(runtime.groups.create({ kind: "fixed", pages: pages(4) }, null).memory).not.toBe(
    reused.memory,
  );
});

test("bounded real groups grant logical pages without growing and clear stray writes", () => {
  const runtime = new SharedMemoryLedger(bounded()).openRuntime(bounded());
  const groups = new MemoryGroups({ maximumPages: 8 }, runtime.groups, runtime.sizing);
  const first = groups.admit(1, "fixture", "new");
  const launched = first.launch();
  const buffer = launched.request.memory.buffer;
  expect(buffer.byteLength).toBe(8 * PAGE_BYTES);
  new Uint8Array(buffer).fill(88, 3 * PAGE_BYTES, 4 * PAGE_BYTES);
  expect(groups.owner(first.group)?.request(first, GroupOp.GROW, 3)).toEqual([1]);
  expect(new Uint8Array(buffer)[3 * PAGE_BYTES]).toBe(0);
  expect(buffer.byteLength).toBe(8 * PAGE_BYTES);
  launched.transfer.forEach((port) => (port as MessagePort).close());
  first.stopped();
  expect(() => first.group.buffer()).toThrow(ProcessError);
});

test("module declarations use actual imported and defined byte limits and errno 48 maps to ENOMEM", () => {
  const source = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 4, 1, 1, 1, 2]);
  const module = new WebAssembly.Module(source);
  declareModuleMemory(module, source);
  expect(moduleMemoryDeclarations(module)).toEqual([
    { kind: "private", maximumPages: pages(2), origin: "defined" },
  ]);
  const runtime = new SharedMemoryLedger(bounded(PAGE_BYTES)).openRuntime(bounded(PAGE_BYTES));
  try {
    runtime.admit({
      ...plan(),
      guest: { kind: "declared", memories: moduleMemoryDeclarations(module)! },
    });
    throw new Error("admitted");
  } catch (error) {
    expect(error).toBeInstanceOf(ProcessError);
    expect(startFailure(error)).toMatchObject({ error: "ENOMEM", code: 12 });
  }
  expect(
    parseModuleMemory(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 0, 1]))[0]
      ?.maximumPages,
  ).toBe(pages(65_536));
});

test("one page ledger preserves awaiting reachability receipts across sequential runtimes", () => {
  const platform = bounded(PAGE_BYTES * 4);
  const ledger = new SharedMemoryLedger(platform);
  const first = ledger.openRuntime(platform);
  const retained = first.buffer("filesystem-root", {
    kind: "fixed-buffer",
    length: bytes(PAGE_BYTES * 3),
  });
  first.dispose();
  const second = ledger.openRuntime(platform);
  expect(second.snapshot().awaitingReleaseBytes).toBe(PAGE_BYTES * 3);
  expect(() => second.admit(plan(2))).toThrow(SharedMemoryAdmissionError);
  expect(retained.byteLength).toBe(PAGE_BYTES * 3);
});

test("guest shared controls have an enforced pre-allocation byte limit", () => {
  const grant = { kind: "bounded" as const, state: new SharedArrayBuffer(8), limit: 12 };
  const received: SharedArrayBuffer[] = [];
  const allocate = createSharedControlAllocator(grant, (buffer) => received.push(buffer));
  expect(allocate(8).byteLength).toBe(8);
  expect(() => allocate(5)).toThrow(ProcessError);
  expect(received).toHaveLength(1);
  expect(consumedControlBytes(grant)).toBe(8);
  expect(allocate(4).byteLength).toBe(4);
  expect(consumedControlBytes(grant)).toBe(12);
});

test("publication failure after native control allocation remains consumed debt", () => {
  const platform = bounded();
  const runtime = new SharedMemoryLedger(platform).openRuntime(platform);
  const ticket = runtime.admit({ ...plan(0), controls: true });
  const launched = ticket.launched();
  const allocate = createSharedControlAllocator(ticket.control, () => {
    throw new Error("postMessage failed");
  });
  expect(() => allocate(16)).toThrow("postMessage failed");
  expect(consumedControlBytes(ticket.control)).toBe(16);
  launched.stopped();
  expect(runtime.snapshot().debtBytes).toBe(16);
  expect(runtime.snapshot().reservedBytes).toBe(24); // The 8-byte grant state remains runtime-owned.
});

test("transferred backing survives its creator stop without returning consumed quota", () => {
  const platform = bounded();
  const runtime = new SharedMemoryLedger(platform).openRuntime(platform);
  const ticket = runtime.admit({ ...plan(0), controls: true });
  const launched = ticket.launched();
  const allocate = createSharedControlAllocator(ticket.control, (buffer) =>
    launched.controlAllocated(buffer),
  );
  const buffer = allocate(32);
  const inherited = structuredClone(buffer);
  new Uint8Array(buffer)[0] = 91;
  launched.stopped();
  expect(new Uint8Array(inherited)[0]).toBe(91);
  expect(runtime.snapshot().debtBytes).toBe(32);
  launched.stopped();
  expect(runtime.snapshot().debtBytes).toBe(32);
});

test("failed physical stop retains even unused guest control headroom", () => {
  const runtime = new SharedMemoryLedger(bounded()).openRuntime(bounded());
  const ticket = runtime.admit({ ...plan(0), controls: true });
  ticket.launched().failed([new Error("Worker.terminate failed")]);
  expect(runtime.snapshot().debtBytes).toBe(CONTROL_GRANT_BYTES);
});

test("a simulated 6 GiB pool admits concurrent guests, requests, and active fixed groups", () => {
  const platform = bounded();
  let declared = 0;
  const simulated: ReservationAllocator = {
    buffer(shape) {
      const n = shape.kind === "fixed-buffer" ? shape.length : shape.maximum;
      if (declared + n > 6 * 1024 ** 3) throw new RangeError("simulated physical reservation pool");
      declared += n;
      return allocations.buffer(shape);
    },
    memory(shape) {
      const n = (shape.kind === "fixed" ? shape.pages : shape.maximumPages) * PAGE_BYTES;
      if (declared + n > 6 * 1024 ** 3) throw new RangeError("simulated physical reservation pool");
      declared += n;
      return allocations.memory(shape);
    },
  };
  const runtime = new SharedMemoryLedger(platform, simulated).openRuntime(platform);
  const root = runtime.buffer("filesystem-root", {
    kind: "fixed-buffer",
    length: bytes(64 * 1024 ** 2),
  });
  // The data segments are admitted as one promise. Nothing is constructed for them here.
  const declaredBeforePromise = declared;
  runtime.dataCapacity(root, bytes(SEGMENT_CAPACITY));
  expect(declared).toBe(declaredBeforePromise);
  const pool = new FilesystemRequestPool(createRequestBudget(), undefined, runtime.arenas);
  const tickets = Array.from({ length: 4 }, (_, pid) =>
    runtime.admit({ ...plan(8192), pid, controls: true, connection: true }),
  );
  const requests = tickets.map((ticket) =>
    pool.take(new SharedArrayBuffer(4), undefined, ticket.arena),
  );
  const running = tickets.map((ticket) => ticket.launched());
  const groups = new MemoryGroups({ maximumPages: 256 }, runtime.groups, runtime.sizing);
  const first = groups.admit(20, "a", "new"),
    second = groups.admit(21, "b", "new");
  const firstRequest = first.launch(),
    secondRequest = second.launch();
  expect(groups.owner(first.group)?.request(first, GroupOp.GROW, 2)).toEqual([1]);
  expect(groups.owner(second.group)?.request(second, GroupOp.GROW, 3)).toEqual([1]);
  for (const port of firstRequest.transfer.concat(secondRequest.transfer))
    if (port instanceof MessagePort) port.close();
  expect(runtime.snapshot().reservedBytes).toBeLessThan(6 * 1024 ** 3);
  expect(
    runtime.snapshot().holders.filter((holder) => holder.label === "guest-memory"),
  ).toHaveLength(4);
  expect(requests).toHaveLength(4);
  expect(
    runtime.snapshot().holders.filter((holder) => holder.label === "filesystem-segment"),
  ).toEqual([
    {
      label: "filesystem-segment",
      shape: { kind: "capacity-promise", bytes: bytes(SEGMENT_CAPACITY) },
      scope: "runtime",
      state: "live",
      declaredBytes: SEGMENT_CAPACITY,
      grownBytes: null,
    },
  ]);
  expect(root.byteLength).toBe(64 * 1024 ** 2);
  first.stopped();
  second.stopped();
  running.forEach((ticket) => ticket.stopped());
});

test("the filesystem's extra capacity is one promise with the charge the segment maxima had", () => {
  // No fixed buffer counts on this platform. The promise is charged in full regardless, as the
  // 95 growable segment maxima it replaces were.
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(2 * 1024 ** 3),
    counts: { fixedBuffer: false, sharedMemory: true, privateMemory: false },
  });
  const constructed: unknown[] = [];
  const observed: ReservationAllocator = {
    buffer(shape) {
      constructed.push(shape);
      return allocations.buffer(shape);
    },
    memory: allocations.memory,
  };
  const collectors: { receive: (id: number) => void; ids: Map<object, number[]> }[] = [];
  const ledger = new SharedMemoryLedger(platform, observed, (receive) => {
    const ids = new Map<object, number[]>();
    collectors.push({ receive, ids });
    return { register: (target, id) => void ids.set(target, (ids.get(target) ?? []).concat(id)) };
  });
  const runtime = ledger.openRuntime(platform);
  const root = runtime.buffer("filesystem-root", {
    kind: "fixed-buffer",
    length: bytes(PAGE_BYTES),
  });
  expect(runtime.snapshot().reservedBytes).toBe(0);
  constructed.length = 0;
  const withdraw = runtime.dataCapacity(root, bytes(SEGMENT_CAPACITY));
  expect(constructed).toEqual([]);
  expect(SEGMENT_CAPACITY).toBe(1_593_835_520);
  expect(runtime.snapshot().reservedBytes).toBe(SEGMENT_CAPACITY);
  const promise = () =>
    runtime.snapshot().holders.filter((holder) => holder.label === "filesystem-segment");
  expect(promise()).toEqual([
    {
      label: "filesystem-segment",
      shape: { kind: "capacity-promise", bytes: bytes(SEGMENT_CAPACITY) },
      scope: "runtime",
      state: "live",
      declaredBytes: SEGMENT_CAPACITY,
      grownBytes: null,
    },
  ]);
  // It is its own holder: the root's record and ownership are untouched, nothing is a growable
  // buffer, and admission sees the whole amount before any consumer starts.
  expect(runtime.ownsBuffer("filesystem-root", root)).toBe(true);
  expect(runtime.snapshot().holders.some((holder) => holder.shape.kind === "growable-buffer")).toBe(
    false,
  );
  expect(runtime.snapshot().availableBytes).toBe(2 * 1024 ** 3 - SEGMENT_CAPACITY);
  // A second promise that does not fit is refused whole and records nothing.
  expect(() => runtime.dataCapacity(root, bytes(SEGMENT_CAPACITY))).toThrow(
    SharedMemoryAdmissionError,
  );
  expect(promise()).toHaveLength(1);
  expect(runtime.snapshot().reservedBytes).toBe(SEGMENT_CAPACITY);
  // Only this runtime's live root can carry one.
  expect(() => runtime.dataCapacity(new SharedArrayBuffer(8), bytes(1))).toThrow(TypeError);
  const control = runtime.buffer("control", { kind: "fixed-buffer", length: bytes(8) });
  expect(() => runtime.dataCapacity(control, bytes(1))).toThrow(TypeError);
  // Construction that fails afterwards withdraws it in the same unwind, exactly once.
  withdraw();
  withdraw();
  expect(promise()).toEqual([]);
  expect(runtime.snapshot().reservedBytes).toBe(0);
  // A kept promise follows the runtime to awaiting-collection, and ends with the page's last
  // reference to the root. That receipt is local reachability, nothing more.
  runtime.dataCapacity(root, bytes(SEGMENT_CAPACITY));
  runtime.dispose();
  expect(promise().map((holder) => holder.state)).toEqual(["awaiting-collection"]);
  expect(ledger.snapshot().awaitingReleaseBytes).toBe(SEGMENT_CAPACITY);
  for (const id of collectors[0]!.ids.get(root) ?? []) collectors[0]!.receive(id);
  expect(promise()).toEqual([]);
  expect(ledger.snapshot().reservedBytes).toBe(0);
});

test("a growable buffer or shared memory is charged at its declared maximum, not what it holds", () => {
  // Safari reserves a growable SharedArrayBuffer's maxByteLength and a shared memory's maximum
  // up front. The ledger counts the same way: a zero initial length is not zero cost.
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(6 * 1024 ** 3),
    counts: { fixedBuffer: false, sharedMemory: true, privateMemory: false },
  });
  const runtime = new SharedMemoryLedger(platform).openRuntime(platform);
  const arena = runtime.arenas.create(null);
  expect(arena.byteLength).toBe(0);
  expect(runtime.snapshot().reservedBytes).toBe(BOUNDED_ARENA_BYTES);
  const group = runtime.groups.create({ kind: "growable", maximumPages: pages(4096) }, null);
  expect(group.memory.buffer.byteLength).toBe(PAGE_BYTES);
  expect(runtime.snapshot().reservedBytes).toBe(BOUNDED_ARENA_BYTES + 4096 * PAGE_BYTES);
  const charged = runtime
    .snapshot()
    .holders.map(({ label, declaredBytes, grownBytes }) => ({ label, declaredBytes, grownBytes }));
  expect(charged).toEqual([
    { label: "request-arena", declaredBytes: BOUNDED_ARENA_BYTES, grownBytes: 0 },
    { label: "memory-group", declaredBytes: 4096 * PAGE_BYTES, grownBytes: PAGE_BYTES },
  ]);
});

test("shared imports and absent maxima are parsed, and memory64 fails closed", () => {
  const name = [1, 101, 1, 109];
  const imported = new Uint8Array(
    [0, 97, 115, 109, 1, 0, 0, 0, 2, 9, 1].concat(name, [2, 3, 1, 2]),
  );
  expect(parseModuleMemory(imported)).toEqual([
    { kind: "shared", origin: "imported", initialPages: pages(1), maximumPages: pages(2) },
  ]);
  expect(() =>
    parseModuleMemory(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 0])),
  ).toThrow(SharedMemoryAdmissionError);
});

test("finalization is a reachability receipt and cannot erase failed-stop debt", () => {
  const registered: { target: WeakRef<object>; id: number }[] = [];
  let collect: (id: number) => void = () => {};
  const platform = bounded(PAGE_BYTES * 2);
  const ledger = new SharedMemoryLedger(platform, allocations, (receive) => {
    collect = receive;
    return {
      register(target, id) {
        registered.push({ target: new WeakRef(target), id });
      },
    };
  });
  const first = ledger.openRuntime(platform);
  const buffer = first.buffer("filesystem-root", {
    kind: "fixed-buffer",
    length: bytes(PAGE_BYTES),
  });
  first.dispose();
  const second = ledger.openRuntime(platform);
  expect(second.snapshot().awaitingReleaseBytes).toBe(PAGE_BYTES);
  expect(() => second.admit(plan(2))).toThrow(SharedMemoryAdmissionError);
  expect(registered[0]?.target.deref()).toBe(buffer);
  collect(registered[0]!.id);
  expect(second.snapshot().awaitingReleaseBytes).toBe(0);
  const failed = second.admit(plan(1)).launched();
  failed.failed([new Error("native stop failed")]);
  second.dispose();
  for (const receipt of registered) collect(receipt.id);
  expect(second.snapshot().debtBytes).toBe(PAGE_BYTES);
});

test("F3 native counted refusal refunds and lowers the cap without constructing a probe Worker", () => {
  const NativeWorker = globalThis.Worker;
  let probes = 0;
  globalThis.Worker = new Proxy(NativeWorker, {
    construct() {
      probes++;
      throw new Error("probe forbidden");
    },
  });
  try {
    const platform = bounded(PAGE_BYTES * 4);
    const runtime = new SharedMemoryLedger(platform, {
      ...allocations,
      buffer() {
        throw new RangeError("native counted refusal");
      },
    }).openRuntime(platform);
    const running = runtime.admit(plan(1)).launched();
    expect(() =>
      runtime.buffer("filesystem-root", { kind: "fixed-buffer", length: bytes(PAGE_BYTES) }),
    ).toThrow(SharedMemoryAdmissionError);
    expect(runtime.snapshot()).toMatchObject({
      budgetBytes: PAGE_BYTES * 4,
      effectiveBudgetBytes: PAGE_BYTES,
      reservedBytes: PAGE_BYTES,
      availableBytes: 0,
      contradictions: [
        {
          label: "filesystem-root",
          requestedBytes: PAGE_BYTES,
          totalChargedBytesAfterRefund: PAGE_BYTES,
        },
      ],
    });
    expect(runtime.check(plan())).toMatchObject({
      kind: "refused",
      error: { refusal: { kind: "budget", budget: PAGE_BYTES } },
    });
    running.stopped();
    expect(probes).toBe(0);
  } finally {
    globalThis.Worker = NativeWorker;
  }
});

test("F7 contradiction ceiling survives release and larger bounded or unbounded declarations", () => {
  const platform = bounded(PAGE_BYTES * 8);
  const ledger = new SharedMemoryLedger(platform, {
    ...allocations,
    buffer() {
      throw new RangeError("contradiction");
    },
  });
  const first = ledger.openRuntime(platform);
  const held = first.admit(plan(3)).launched();
  expect(() =>
    first.buffer("filesystem-root", { kind: "fixed-buffer", length: bytes(PAGE_BYTES) }),
  ).toThrow(SharedMemoryAdmissionError);
  const history = first.snapshot().contradictions;
  held.stopped();
  first.dispose();
  const larger = ledger.openRuntime(bounded(PAGE_BYTES * 16));
  expect(larger.snapshot()).toMatchObject({
    budgetBytes: PAGE_BYTES * 16,
    effectiveBudgetBytes: PAGE_BYTES * 3,
    availableBytes: PAGE_BYTES * 3,
    contradictions: history,
  });
  expect(larger.check(plan(4))).toMatchObject({
    kind: "refused",
    error: { refusal: { kind: "budget", budget: PAGE_BYTES * 3 } },
  });
  larger.dispose();
  const unbounded = ledger.openRuntime(unlimited);
  expect(unbounded.snapshot()).toMatchObject({
    budgetBytes: null,
    effectiveBudgetBytes: PAGE_BYTES * 3,
    availableBytes: PAGE_BYTES * 3,
    contradictions: history,
  });
  expect(unbounded.check(plan(4))).toMatchObject({
    kind: "refused",
    error: { refusal: { kind: "budget" } },
  });
  const second = unbounded.admit(plan(1)).launched();
  expect(() =>
    unbounded.buffer("filesystem-root", { kind: "fixed-buffer", length: bytes(PAGE_BYTES) }),
  ).toThrow(SharedMemoryAdmissionError);
  expect(unbounded.snapshot().effectiveBudgetBytes).toBe(PAGE_BYTES);
  expect(unbounded.snapshot().contradictions).toHaveLength(2);
  expect(history).toHaveLength(1);
  second.stopped();
  expect(unbounded.snapshot().availableBytes).toBe(PAGE_BYTES);
});

test("the omission default is issued once, refused as explicit input, and keeps a recorded cap", () => {
  expect(defaultSharedMemoryPlatform).toEqual({ kind: "unbounded", source: "default" });
  expect(Object.isFrozen(defaultSharedMemoryPlatform)).toBe(true);
  expect(validateDeclaration(unlimited)).toBe(unlimited);
  for (const input of [defaultSharedMemoryPlatform, null, { ...unlimited }])
    expect(() => validateDeclaration(input)).toThrow(TypeError);
  const platform = bounded(PAGE_BYTES * 8);
  const ledger = new SharedMemoryLedger(platform, {
    ...allocations,
    buffer() {
      throw new RangeError("contradiction");
    },
  });
  const first = ledger.openRuntime(platform);
  const held = first.admit(plan(3)).launched();
  expect(() =>
    first.buffer("filesystem-root", { kind: "fixed-buffer", length: bytes(PAGE_BYTES) }),
  ).toThrow(SharedMemoryAdmissionError);
  held.stopped();
  first.dispose();
  const omitted = ledger.openRuntime(defaultSharedMemoryPlatform);
  expect(omitted.snapshot()).toMatchObject({
    platform: defaultSharedMemoryPlatform,
    budgetBytes: null,
    effectiveBudgetBytes: PAGE_BYTES * 3,
    contradictions: [{ requestedBytes: PAGE_BYTES }],
  });
  expect(omitted.check(plan(4))).toMatchObject({
    kind: "refused",
    error: { refusal: { kind: "budget", budget: PAGE_BYTES * 3 } },
  });
  omitted.dispose();
});

for (const kind of ["fixed-buffer", "memory-group"] as const)
  test(`F8 uncounted ${kind} native refusal leaves counted debt cap and history alone`, () => {
    const platform = declareSharedMemoryPlatform({
      kind: "bounded",
      budgetBytes: bytes(PAGE_BYTES * 8),
      counts: { fixedBuffer: false, sharedMemory: false, privateMemory: true },
    });
    const runtime = new SharedMemoryLedger(platform, {
      buffer() {
        throw new RangeError("uncounted native refusal");
      },
      memory() {
        throw new RangeError("uncounted native refusal");
      },
    }).openRuntime(platform);
    const before = runtime.snapshot();
    const construct = () =>
      kind === "fixed-buffer"
        ? runtime.buffer("filesystem-root", { kind, length: bytes(PAGE_BYTES) })
        : runtime.groups.create({ kind: "fixed", pages: pages(1) }, null);
    const error: unknown = (() => {
      try {
        construct();
        return null;
      } catch (failure) {
        return failure;
      }
    })();
    expect(error).toMatchObject({
      refusal: {
        kind: "uncounted-platform",
        requestedBytes: PAGE_BYTES,
        cause: expect.any(RangeError),
      },
    });
    expect(runtime.snapshot()).toEqual(before);
  });

test("F6 reservation measurement-pending API is removed without deleting lifecycle settlement", async () => {
  const reservations = await Bun.file(new URL("../memory/reservations.ts", import.meta.url)).text();
  const broker = await Bun.file(new URL("../browser/process-broker.ts", import.meta.url)).text();
  expect(reservations).not.toMatch(
    /\bremeasure\b|readonly measurementError:|measurement pending|settled\(\): Promise<void>/,
  );
  expect(broker).not.toContain("reservations.settled()");
  expect(broker).toContain(".stopped()");
  expect(new SharedMemoryLedger(unlimited).openRuntime(unlimited)).not.toHaveProperty("settled");
});

test("trusted declarations are chosen without probing and remain explicitly declared", () => {
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = new Proxy(NativeWorker, {
    construct() {
      throw new Error("declaration must not probe");
    },
  });
  try {
    const platform = bounded();
    const runtime = new SharedMemoryLedger(platform).openRuntime(platform);
    expect(runtime.snapshot().platform.source).toBe("application");
    expect(runtime.snapshot().budgetBytes).toBe(6 * 1024 ** 3);
    expect(runtime.snapshot().effectiveBudgetBytes).toBe(6 * 1024 ** 3);
    expect(runtime.snapshot().contradictions).toEqual([]);
    runtime.dispose();
  } finally {
    globalThis.Worker = NativeWorker;
  }
});

test("a native unbounded arena refusal preserves the historical fallback ladder without a cap", () => {
  const attempts: number[] = [];
  const runtime = new SharedMemoryLedger(unlimited, {
    ...allocations,
    buffer(shape) {
      const maximum = shape.kind === "fixed-buffer" ? shape.length : shape.maximum;
      attempts.push(maximum);
      if (maximum === UNBOUNDED_ARENA_BYTES) throw new RangeError("per-object cap");
      return allocations.buffer(shape);
    },
  }).openRuntime(unlimited);
  expect(runtime.arenas.create(null).maxByteLength).toBe(BOUNDED_ARENA_BYTES);
  expect(attempts).toEqual([UNBOUNDED_ARENA_BYTES, BOUNDED_ARENA_BYTES]);
  expect(runtime.snapshot().effectiveBudgetBytes).toBeNull();
  expect(runtime.snapshot().contradictions).toEqual([]);
});

function runtimeWithContradictionCap(cap: number) {
  const platform = bounded(cap + PAGE_BYTES);
  let refuse = true;
  const ledger = new SharedMemoryLedger(platform, {
    ...allocations,
    buffer(shape) {
      if (refuse) throw new RangeError("counted contradiction");
      return allocations.buffer(shape);
    },
  });
  const first = ledger.openRuntime(platform);
  const running = first.admit(plan(cap / PAGE_BYTES)).launched();
  expect(() =>
    first.buffer("filesystem-root", { kind: "fixed-buffer", length: bytes(PAGE_BYTES) }),
  ).toThrow(SharedMemoryAdmissionError);
  refuse = false;
  running.stopped();
  first.dispose();
  return ledger.openRuntime(unlimited);
}

test("F7 a finite cap preserves bounded control admission and existing quota settlement after an unbounded declaration", () => {
  const perRoot = CONTROL_GRANT_BYTES + CONTROL_GRANT_STATE_BYTES;
  const cap = Math.ceil((2 * perRoot) / PAGE_BYTES) * PAGE_BYTES;
  const capacity = Math.floor(cap / perRoot);
  const runtime = runtimeWithContradictionCap(cap);
  const root: ProcessPlan = { ...plan(0), controls: true };
  const tickets = Array.from({ length: capacity }, () => runtime.admit(root));
  expect(tickets.map((ticket) => ticket.control.kind)).toEqual(
    Array.from({ length: capacity }, () => "bounded"),
  );
  expect(runtime.snapshot().reservedBytes).toBe(capacity * perRoot);
  expect(runtime.check(root)).toMatchObject({
    kind: "refused",
    error: { refusal: { kind: "budget", budget: cap } },
  });
  expect(() => runtime.admit(root)).toThrow(SharedMemoryAdmissionError);
  const first = tickets[0]!;
  const running = first.launched();
  const allocate = createSharedControlAllocator(first.control, (buffer) =>
    running.controlAllocated(buffer),
  );
  allocate(32);
  running.stopped();
  for (const ticket of tickets) ticket.abort();
  expect(runtime.snapshot()).toMatchObject({
    effectiveBudgetBytes: cap,
    debtBytes: 32,
    reservedBytes: capacity * CONTROL_GRANT_STATE_BYTES + 32,
  });
  expect(runtime.snapshot().contradictions).toHaveLength(1);
  const before = runtime.snapshot().reservedBytes;
  const disabled = runtime.admit(plan(0));
  expect(disabled.control.kind).toBe("unbounded");
  expect(runtime.snapshot().reservedBytes).toBe(before);
  disabled.abort();
  runtime.dispose();
});

test("F7 a finite cap still refuses undeclared guests after an unbounded declaration", () => {
  const runtime = runtimeWithContradictionCap(PAGE_BYTES);
  const unknown: ProcessPlan = { ...plan(0), guest: { kind: "undeclared" } };
  expect(runtime.check(unknown)).toMatchObject({
    kind: "refused",
    error: { refusal: { kind: "configuration", configuration: "undeclared-module-memory" } },
  });
  expect(() => runtime.admit(unknown)).toThrow(SharedMemoryAdmissionError);
  runtime.dispose();
  const uncapped = new SharedMemoryLedger(unlimited).openRuntime(unlimited);
  expect(uncapped.check(unknown)).toEqual({ kind: "admitted" });
  expect(uncapped.admit({ ...plan(0), controls: true }).control.kind).toBe("unbounded");
  uncapped.dispose();
});
