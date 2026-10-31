import {
  createSharedControlAllocator,
  consumedControlBytes,
  CONTROL_GRANT_BYTES,
} from "../memory/control.js";
import { expect, test } from "bun:test";
import {
  SharedMemoryLedger,
  SharedMemoryAdmissionError,
  bytes,
  pages,
  declareSharedMemoryPlatform,
  DESKTOP_ARENA_BYTES,
  BOUNDED_ARENA_BYTES,
  PAGE_BYTES,
  type ReservationAllocator,
  type ProcessPlan,
} from "../memory/reservations.js";
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

test("desktop sizing and actual bounded arena reservations stay pinned", () => {
  const unbounded = new SharedMemoryLedger(unlimited).openRuntime(unlimited);
  expect(unbounded.sizing.arena).toEqual({
    bytes: bytes(DESKTOP_ARENA_BYTES),
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

test("a failed remeasurement never converts a bounded page to unbounded", async () => {
  const platform = bounded();
  const runtime = new SharedMemoryLedger(
    platform,
    {
      ...allocations,
      buffer() {
        throw new RangeError("native pool exhausted");
      },
    },
    async () => {
      throw new Error("probe failed");
    },
  ).openRuntime(platform);
  expect(() => runtime.arenas.create(null)).toThrow(SharedMemoryAdmissionError);
  await runtime.settled();
  expect(runtime.snapshot().platform.kind).toBe("bounded");
  expect(runtime.snapshot().measurementError).toBe("probe failed");
  expect(runtime.snapshot().reservedBytes).toBe(0);
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
  const segments = Array.from({ length: 95 }, () =>
    runtime.buffer("filesystem-segment", {
      kind: "growable-buffer",
      initial: 0,
      maximum: bytes(16 * 1024 ** 2),
    }),
  );
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
  expect(segments).toHaveLength(95);
  expect(root.byteLength).toBe(64 * 1024 ** 2);
  first.stopped();
  second.stopped();
  running.forEach((ticket) => ticket.stopped());
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
  const ledger = new SharedMemoryLedger(
    platform,
    allocations,
    async () => platform,
    (receive) => {
      collect = receive;
      return {
        register(target, id) {
          registered.push({ target: new WeakRef(target), id });
        },
      };
    },
  );
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
