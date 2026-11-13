import { afterEach, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import {
  bytes,
  pages,
  PAGE_BYTES,
  SharedMemoryLedger,
  SharedMemoryAdmissionError,
  declareSharedMemoryPlatform,
  type SharedGuestAlias,
  type SharedGuestBacking,
  type SharedGuestStop,
  type RuntimeReservations,
  type ProcessPlan,
} from "../memory/reservations.js";
import {
  CONTROL_GRANT_BYTES,
  CONTROL_GRANT_STATE_BYTES,
  createSharedControlAllocator,
} from "../memory/control.js";
import {
  createFilesystemIdentity,
  FilesystemSection,
  waitForFilesystemQuiescence,
  reapFilesystem,
} from "../fs/protocol.js";

const owner = { directory: "ledger-test-directory", pid: 1, generation: 1 };
const thread = { ...owner, tid: 1 };
const exit = { kind: "exited", code: 0, status: 0 } as const;
const heapBytes = 512 * PAGE_BYTES;
const workerBytes = CONTROL_GRANT_BYTES + CONTROL_GRANT_STATE_BYTES;
const platform = declareSharedMemoryPlatform({
  kind: "bounded",
  budgetBytes: bytes(512 * 1024 ** 2),
  counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
});
const shape = {
  initialPages: pages(17),
  actualMaximumPages: pages(512),
  sourceMaximumPages: pages(16_384),
};
const workers = new Set<Worker>();
const runtimes = new Set<RuntimeReservations>();
const resources = new Set<() => void>();

afterEach(async () => {
  for (const release of resources) release();
  resources.clear();
  for (const worker of workers) await worker.terminate();
  workers.clear();
  for (const runtime of runtimes) runtime.dispose();
  runtimes.clear();
});

function setup(ledger = new SharedMemoryLedger(platform)) {
  const runtime = ledger.openRuntime(platform);
  runtimes.add(runtime);
  const backing = runtime.sharedGuests.create({ owner, ...shape });
  return { ledger, runtime, backing };
}
function sharedBuffer(memory: WebAssembly.Memory): SharedArrayBuffer {
  const buffer = memory.buffer;
  if (!(buffer instanceof SharedArrayBuffer)) throw new TypeError("Shared Memory required");
  return buffer;
}
function plan(alias: SharedGuestAlias, service = false): ProcessPlan {
  return {
    pid: owner.pid,
    executable: "shared-guest-test",
    guest: { kind: "shared-alias", alias, owner },
    group: "none",
    controls: true,
    connection: service,
  };
}
function guest(backing: SharedGuestBacking, tid: number): SharedGuestAlias {
  return backing.alias({ kind: "guest", thread: { ...owner, tid } });
}
const workerSource = `
const { parentPort } = require("node:worker_threads");
const { FilesystemSection } = require(${JSON.stringify(new URL("../fs/protocol.ts", import.meta.url).pathname)});
let memory;
let section;
parentPort.on("message", message => {
  if (message === "idle") {
    section?.exit();
    section = undefined;
    memory = undefined;
    parentPort.postMessage("idle");
    return;
  }
  memory = message.memory;
  if (message.filesystem) {
    section = new FilesystemSection(message.filesystem);
    section.enter();
  }
  new Uint8Array(memory.buffer)[0] = 73;
  parentPort.postMessage(memory.buffer.byteLength);
});
`;
function message(worker: Worker): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Owned backing Worker deadline")), 5000);
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", receive);
      worker.off("error", failed);
      resources.delete(cleanup);
    };
    const finish = (error: Error | null, value?: unknown) => {
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const receive = (value: unknown) => finish(null, value);
    const failed = (error: Error) => finish(error);
    resources.add(cleanup);
    worker.once("message", receive);
    worker.once("error", failed);
  });
}
async function launched(runtime: RuntimeReservations, alias: SharedGuestAlias, service = false) {
  const ticket = runtime.admit(plan(alias, service));
  const worker = new Worker(workerSource, { eval: true });
  workers.add(worker);
  const running = ticket.launched();
  const borrowed = alias.transfer();
  const ready = message(worker);
  worker.postMessage({ memory: borrowed.memory });
  expect(await ready).toBe(shape.initialPages * PAGE_BYTES);
  const lifecycle: SharedGuestStop = {
    async idle() {
      const idle = message(worker);
      worker.postMessage("idle");
      expect(await idle).toBe("idle");
    },
    terminate: () => worker.terminate(),
    cleanup() {
      if (worker.threadId !== -1) throw new Error("Worker still alive after terminate");
      workers.delete(worker);
    },
  };
  return { worker, ticket, running, lifecycle, memory: borrowed.memory };
}
function serviceFence(backing: SharedGuestBacking, alias: SharedGuestAlias) {
  return backing.fence({ kind: "service", alias, drain() {}, filesystem() {}, dispose() {} });
}
function deferred() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

test("L1 native initial 17 grows to 512 under one 32 MiB charge and initial-first physical stop", async () => {
  const { runtime, backing } = setup();
  const service = backing.alias({ kind: "service", incarnation: 8 });
  const initial = guest(backing, 1);
  const child = guest(backing, 2);
  const serviceWorker = await launched(runtime, service, true);
  const initialWorker = await launched(runtime, initial);
  const childWorker = await launched(runtime, child);
  expect(serviceWorker.memory).toBe(initialWorker.memory);
  expect(initialWorker.memory).toBe(childWorker.memory);
  expect(runtime.snapshot().reservedBytes).toBe(heapBytes + 3 * workerBytes);
  expect(runtime.snapshot().sharedGuests[0]).toMatchObject({ ...shape, chargedBytes: heapBytes });
  expect(serviceWorker.memory.grow(495)).toBe(17);
  expect(serviceWorker.memory.buffer.byteLength).toBe(heapBytes);
  expect(() => serviceWorker.memory.grow(1)).toThrow(RangeError);
  expect(runtime.snapshot().reservedBytes).toBe(heapBytes + 3 * workerBytes);
  expect(
    runtime.snapshot().holders.find((holder) => holder.scope === "shared-guest"),
  ).toMatchObject({ declaredBytes: heapBytes, grownBytes: heapBytes });
  expect(() => initialWorker.running.stopped()).toThrow("physical stop");
  await initial.stop(initialWorker.lifecycle);
  expect(runtime.snapshot().reservedBytes).toBe(
    heapBytes + 2 * workerBytes + CONTROL_GRANT_STATE_BYTES,
  );
  expect(runtime.snapshot().sharedGuests[0]?.aliases.transferred).toBe(2);
  backing.seal(exit);
  await child.stop(childWorker.lifecycle);
  await serviceFence(backing, service);
  await service.stop(serviceWorker.lifecycle);
  expect(backing.retire()).toEqual({ kind: "awaiting-collection" });
  expect(runtime.snapshot().awaitingReleaseBytes).toBe(heapBytes);
  expect(runtime.snapshot().debtBytes).toBe(0);
});

test("L2 real asynchronous call, queued wait-buffer delivery, and ordered filesystem fence hold retirement", async () => {
  const { runtime, backing } = setup();
  const service = backing.alias({ kind: "service", incarnation: 3 });
  const initial = guest(backing, 1);
  const serviceWorker = await launched(runtime, service, true);
  const initialWorker = await launched(runtime, initial);
  const call = backing.continuation({ thread, sequence: 1 });
  const controlDelivery = backing.continuation({ thread, sequence: 2 });
  const old = sharedBuffer(serviceWorker.memory);
  serviceWorker.memory.grow(1);
  expect(serviceWorker.memory.buffer).not.toBe(old);
  const releaseWait = controlDelivery.retain(old);
  const response = deferred();
  const closing = call.settle(() => response.promise);
  const filesystem = createFilesystemIdentity(undefined, 1024 * 1024);
  const section = new FilesystemSection(filesystem);
  section.enter();
  resources.add(() => section.exit());
  const filesystemStarted = deferred();
  const events: string[] = [];
  backing.seal(exit);
  const releaseLateWait = controlDelivery.retain(structuredClone(old));
  await initial.stop(initialWorker.lifecycle);
  expect(backing.retire().kind).toBe("pending");
  const fence = backing.fence({
    kind: "service",
    alias: service,
    async drain() {
      events.push("drain-start");
      await closing;
      releaseWait();
      releaseWait();
      releaseLateWait();
      await controlDelivery.settle(() => {
        events.push("queued-control-retired");
      });
      events.push("drain-finished");
    },
    async filesystem() {
      events.push("filesystem-start");
      filesystemStarted.finish();
      await waitForFilesystemQuiescence(filesystem);
      reapFilesystem(filesystem);
      events.push("filesystem-finished");
    },
    dispose() {
      events.push("canonical-disposed");
    },
  });
  expect(() => service.stop(serviceWorker.lifecycle)).toThrow("safety fence");
  expect(backing.retire().kind).toBe("pending");
  expect(Atomics.load(new Int32Array(filesystem.revocations[0]!), 0)).toBe(0);
  response.finish();
  await closing;
  await filesystemStarted.promise;
  expect(events).toEqual([
    "drain-start",
    "queued-control-retired",
    "drain-finished",
    "filesystem-start",
  ]);
  expect(backing.retire().kind).toBe("pending");
  section.exit();
  resources.clear();
  await fence;
  expect(events.at(-1)).toBe("canonical-disposed");
  expect(Atomics.load(new Int32Array(filesystem.ownerStates), filesystem.owner)).toBe(2);
  await service.stop(serviceWorker.lifecycle);
  expect(backing.retire().kind).toBe("awaiting-collection");
});

test("L3 kill before transfer cancels reserved admission, never a launched possible recipient", async () => {
  const { runtime, backing } = setup();
  const initial = guest(backing, 1);
  const ticket = runtime.admit(plan(initial));
  expect(() => runtime.admit(plan(initial))).toThrow("already admitted");
  backing.seal(exit);
  expect(() => initial.transfer()).toThrow("sealed");
  ticket.abort();
  initial.abortBeforeTransfer();
  await backing.fence({ kind: "no-agent" });
  expect(backing.retire().kind).toBe("awaiting-collection");
  expect(runtime.snapshot().reservedBytes).toBe(heapBytes + CONTROL_GRANT_STATE_BYTES);
});

test("L3 uncertain transfer cannot abort, repeated failure retains only one heap holder", async () => {
  const { runtime, backing } = setup();
  const initial = guest(backing, 1);
  const worker = await launched(runtime, initial);
  expect(() => initial.abortBeforeTransfer()).toThrow("cannot abort");
  initial.failed(new Error("postMessage may have transferred"));
  initial.failed(new Error("duplicate transfer failure"));
  backing.fail(new Error("duplicate aggregate failure"));
  expect(backing.retire().kind).toBe("debt");
  expect(runtime.snapshot().debtBytes).toBe(heapBytes);
  await initial.stop(worker.lifecycle);
  expect(runtime.snapshot().debtBytes).toBe(heapBytes);
  expect(
    runtime.snapshot().holders.filter((holder) => holder.scope === "shared-guest"),
  ).toHaveLength(1);
});

test("L4 failed actual stop and fence retain heap once plus independent Worker-control debt", async () => {
  const { ledger, runtime, backing } = setup();
  const service = backing.alias({ kind: "service", incarnation: 7 });
  const initial = guest(backing, 1);
  const serviceWorker = await launched(runtime, service, true);
  const initialWorker = await launched(runtime, initial);
  const outstanding = backing.continuation({ thread, sequence: 1 });
  const allocate = createSharedControlAllocator(
    serviceWorker.ticket.control,
    serviceWorker.running.controlAllocated,
  );
  allocate(16);
  backing.seal(exit);
  const failure = backing.fence({
    kind: "service",
    alias: service,
    drain() {
      throw new Error("transport retirement failed");
    },
    filesystem() {
      throw new Error("must not run");
    },
    dispose() {
      throw new Error("must not run");
    },
  });
  const fenceError: unknown = await failure.catch((error: unknown) => error);
  expect(fenceError).toBeInstanceOf(Error);
  expect(backing.fence({ kind: "no-agent" })).toBe(failure);
  const stopped = initial.stop({
    ...initialWorker.lifecycle,
    async terminate() {
      await initialWorker.lifecycle.terminate();
      throw new Error("native termination failed");
    },
  });
  const stopError: unknown = await stopped.catch((error: unknown) => error);
  expect(stopError).toBeInstanceOf(AggregateError);
  expect(initial.stop(initialWorker.lifecycle)).toBe(stopped);
  expect(() => service.stop(serviceWorker.lifecycle)).toThrow("safety fence");
  expect(serviceWorker.worker.threadId).not.toBe(-1);
  expect(runtime.snapshot().sharedGuests[0]?.fence).toBe("failed");
  expect(runtime.snapshot().debtBytes).toBe(heapBytes + CONTROL_GRANT_BYTES);
  runtime.dispose();
  const fresh = ledger.openRuntime(platform);
  runtimes.add(fresh);
  expect(fresh.snapshot().debtBytes).toBe(heapBytes + 2 * CONTROL_GRANT_BYTES);
  await outstanding.settle(() => {});
  expect(fresh.snapshot().debtBytes).toBe(heapBytes + 2 * CONTROL_GRANT_BYTES);
  expect(backing.retire().kind).toBe("debt");
});

async function attemptUnfencedServiceStop(
  alias: SharedGuestAlias,
  worker: Worker,
  events: string[],
): Promise<unknown> {
  try {
    await alias.stop({
      idle() {
        events.push("idle-refused");
        throw new Error("Service still owns filesystem work");
      },
      terminate() {
        events.push("native-terminate");
        return worker.terminate();
      },
      cleanup() {
        events.push("cleanup");
      },
    });
  } catch (error) {
    return error;
  }
}

async function serviceDebtKeepsFilesystemOwner(dispose: boolean) {
  const { runtime, backing } = setup();
  const service = backing.alias({ kind: "service", incarnation: 12 });
  const running = await launched(runtime, service, true);
  const filesystem = createFilesystemIdentity(undefined, 1024 * 1024);
  const inside = message(running.worker);
  running.worker.postMessage({ memory: running.memory, filesystem });
  try {
    expect(await inside).toBe(shape.initialPages * PAGE_BYTES);
    expect(Atomics.load(new Int32Array(filesystem.sections), 0)).toBe(1);
    backing.seal(exit);
    if (dispose) runtime.dispose();
    else backing.fail(new Error("Independent guest stop failed"));
    const events: string[] = [];
    const error = await attemptUnfencedServiceStop(service, running.worker, events);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("requires its safety fence");
    expect(events).toEqual([]);
    expect(running.worker.threadId).not.toBe(-1);
    expect(Atomics.load(new Int32Array(filesystem.sections), 0)).toBe(1);
    expect(backing.retire().kind).toBe("debt");
    expect(runtime.snapshot().sharedGuests[0]?.fence).toBe("pending");
  } finally {
    if (running.worker.threadId !== -1) await running.lifecycle.idle();
    reapFilesystem(filesystem);
  }
}

for (const dispose of [false, true])
  test(`service safety before native stop survives ${dispose ? "runtime disposal" : "aggregate debt"}`, () =>
    serviceDebtKeepsFilesystemOwner(dispose));

test("L5 counted bounded constructor refusal refunds provisional holder and preserves contradiction cap", () => {
  const bounded = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(3 * 1024 ** 3),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
  });
  let constructions = 0;
  const ledger = new SharedMemoryLedger(bounded, undefined, undefined, () => {
    constructions++;
    throw new RangeError("counted shared Memory refusal");
  });
  const runtime = ledger.openRuntime(bounded);
  runtimes.add(runtime);
  const held = runtime.admit({
    pid: 9,
    executable: "ordinary",
    guest: {
      kind: "declared",
      memories: [{ kind: "private", origin: "defined", maximumPages: pages(1) }],
    },
    group: "none",
    controls: true,
    connection: false,
  });
  const charged = runtime.snapshot().reservedBytes;
  expect(() => runtime.sharedGuests.create({ owner, ...shape })).toThrow(
    SharedMemoryAdmissionError,
  );
  expect(constructions).toBe(1);
  expect(runtime.snapshot()).toMatchObject({
    reservedBytes: charged,
    effectiveBudgetBytes: charged,
    sharedGuests: [],
    platform: { kind: "bounded", source: "application" },
    contradictions: [
      { label: "guest-memory", requestedBytes: heapBytes, totalChargedBytesAfterRefund: charged },
    ],
  });
  held.abort();
  runtime.dispose();
  const fresh = ledger.openRuntime(platform);
  runtimes.add(fresh);
  expect(fresh.snapshot().effectiveBudgetBytes).toBe(charged);
  expect(fresh.snapshot().contradictions).toHaveLength(1);
});

test("same-ledger scope, directory, PID, exact alias and separate controls authenticate admission", () => {
  const { ledger, runtime, backing } = setup();
  const alias = guest(backing, 1);
  const original = plan(alias);
  const before = runtime.snapshot().reservedBytes;
  const fresh = ledger.openRuntime(platform);
  runtimes.add(fresh);
  expect(() => fresh.admit(original)).toThrow("scope mismatch");
  const other = new SharedMemoryLedger(platform).openRuntime(platform);
  runtimes.add(other);
  expect(() => other.admit(original)).toThrow("scope mismatch");
  expect(() => runtime.admit({ ...original, pid: 2 })).toThrow("scope mismatch");
  expect(() =>
    runtime.admit({
      ...original,
      guest: { kind: "shared-alias", alias, owner: { ...owner, directory: "stale-directory" } },
    }),
  ).toThrow("scope mismatch");
  expect(() =>
    runtime.admit({ ...original, guest: { kind: "shared-alias", alias: { ...alias }, owner } }),
  ).toThrow("scope mismatch");
  expect(() => runtime.admit({ ...original, controls: false })).toThrow("independent controls");
  expect(() => runtime.admit({ ...original, group: "join" })).toThrow("independent controls");
  expect(() => runtime.admit({ ...original, connection: true })).toThrow(
    "service-only connections",
  );
  expect(runtime.snapshot().reservedBytes).toBe(before);
  expect(runtime.check(original)).toEqual({ kind: "admitted" });
  const ticket = runtime.admit(original);
  expect(() => alias.transfer()).toThrow("launch before transfer");
  expect(() => alias.abortBeforeTransfer()).toThrow("cannot abort");
  ticket.abort();
  expect(() => runtime.admit(original)).toThrow("already admitted");
  expect(() => backing.alias({ kind: "guest", thread })).toThrow("already reserved");
});

test("shape and same-incarnation validation precede constructor, and budget refusal creates no heap", () => {
  const observed: unknown[] = [];
  const ledger = new SharedMemoryLedger(platform, undefined, undefined, (input) => {
    observed.push(input);
    return new WebAssembly.Memory({
      initial: input.initialPages,
      maximum: input.actualMaximumPages,
      shared: true,
    });
  });
  const runtime = ledger.openRuntime(platform);
  runtimes.add(runtime);
  expect(() => runtime.sharedGuests.create({ owner, ...shape, initialPages: pages(513) })).toThrow(
    "Incompatible",
  );
  expect(() =>
    runtime.sharedGuests.create({ owner, ...shape, sourceMaximumPages: pages(511) }),
  ).toThrow("Incompatible");
  expect(observed).toEqual([]);
  runtime.sharedGuests.create({ owner, ...shape });
  expect(observed).toEqual([shape]);
  expect(() => runtime.sharedGuests.create({ owner, ...shape })).toThrow(
    "incarnation already owns",
  );
  expect(observed).toHaveLength(1);
  const tiny = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(PAGE_BYTES),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
  });
  const constrained = ledger.openRuntime(tiny);
  runtimes.add(constrained);
  expect(() => constrained.sharedGuests.create({ owner: { ...owner, pid: 2 }, ...shape })).toThrow(
    SharedMemoryAdmissionError,
  );
  expect(observed).toHaveLength(1);
  expect(constrained.snapshot().sharedGuests).toHaveLength(1);
});

test("duplicate and stale calls cannot settle a successor or admit an unknown thread", async () => {
  const { runtime, backing } = setup();
  const initial = guest(backing, 1);
  const worker = await launched(runtime, initial);
  const call = backing.continuation({ thread, sequence: 7 });
  expect(() => backing.continuation({ thread, sequence: 7 })).toThrow("already admitted");
  expect(() => backing.continuation({ thread: { ...thread, tid: 99 }, sequence: 1 })).toThrow(
    "live thread alias",
  );
  expect(() =>
    backing.continuation({ thread: { ...thread, directory: "other" }, sequence: 1 }),
  ).toThrow("incarnation");
  let closes = 0;
  const pending = deferred();
  const first = call.settle(async () => {
    closes++;
    await pending.promise;
  });
  expect(
    call.settle(() => {
      throw new Error("duplicate close must not run");
    }),
  ).toBe(first);
  pending.finish();
  await first;
  expect(closes).toBe(1);
  expect(() => backing.continuation({ thread, sequence: 6 })).toThrow("already admitted");
  const successor = backing.continuation({ thread, sequence: 8 });
  await call.settle(() => {
    throw new Error("stale close must not run");
  });
  call.failed(new Error("stale failure after settlement"));
  expect(runtime.snapshot().sharedGuests[0]?.continuations.active).toBe(1);
  expect(runtime.snapshot().sharedGuests[0]?.phase).toBe("live");
  await successor.settle(() => {});
  await initial.stop(worker.lifecycle);
});

test("retained wait-reference release failure and unfinished runtime disposal never become release", async () => {
  const { ledger, runtime, backing } = setup();
  const initial = guest(backing, 1);
  const worker = await launched(runtime, initial);
  const call = backing.continuation({ thread, sequence: 1 });
  const release = call.retain(sharedBuffer(worker.memory));
  backing.seal(exit);
  const error: unknown = await call.settle(() => {}).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(runtime.snapshot().sharedGuests[0]?.continuations).toEqual({ active: 0, retained: 1 });
  release();
  release();
  expect(backing.retire().kind).toBe("debt");
  await initial.stop(worker.lifecycle);
  runtime.dispose();
  const fresh = ledger.openRuntime(platform);
  runtimes.add(fresh);
  expect(fresh.snapshot().debtBytes).toBe(heapBytes);
  const next = fresh.sharedGuests.create({ owner, ...shape });
  expect(next.id).not.toBe(backing.id);
  expect(() => fresh.admit(plan(initial))).toThrow("scope mismatch");
  call.failed(new Error("late wait release failure"));
  expect(fresh.snapshot().sharedGuests.find((entry) => entry.id === next.id)?.phase).toBe("live");
  fresh.dispose();
  expect(fresh.snapshot().sharedGuests.every((entry) => entry.phase === "debt")).toBe(true);
  expect(fresh.snapshot().debtBytes).toBe(2 * heapBytes);
});

test("successful stop is cached before reentrant hooks and no-entry Workers can roll back", async () => {
  const { runtime, backing } = setup();
  const alias = guest(backing, 1);
  const ticket = runtime.admit(plan(alias));
  const worker = new Worker(workerSource, { eval: true });
  workers.add(worker);
  ticket.launched();
  backing.seal(exit);
  let stops = 0;
  const lifecycle: SharedGuestStop = {
    async idle() {
      expect(alias.stop(lifecycle)).toBe(stopping);
      const reply = message(worker);
      worker.postMessage("idle");
      expect(await reply).toBe("idle");
    },
    terminate() {
      stops++;
      return worker.terminate();
    },
    cleanup() {
      workers.delete(worker);
    },
  };
  const stopping = alias.stop(lifecycle);
  expect(alias.stop(lifecycle)).toBe(stopping);
  const receipt = await stopping;
  expect(receipt.alias).toBe(alias.id);
  expect(stops).toBe(1);
  await backing.fence({ kind: "no-agent" });
  expect(backing.retire().kind).toBe("awaiting-collection");
});

test("weak Memory and old/current SAB receipts share one holder, ignore duplicates, and never erase debt", async () => {
  const registrations: { id: number; target: WeakRef<object>; heap: boolean }[] = [];
  let collect: (id: number) => void = () => {};
  const ledger = new SharedMemoryLedger(platform, undefined, (receive) => {
    collect = receive;
    return {
      register(target, id) {
        registrations.push({
          id,
          target: new WeakRef(target),
          heap:
            target instanceof WebAssembly.Memory ||
            (target instanceof SharedArrayBuffer &&
              target.byteLength >= shape.initialPages * PAGE_BYTES),
        });
      },
    };
  });
  const { runtime, backing } = setup(ledger);
  await retireWithCapturedBuffers(runtime, backing);
  const heapReceipts = registrations.filter((item) => item.heap);
  expect(heapReceipts.length).toBeGreaterThanOrEqual(3);
  expect(runtime.snapshot().awaitingReleaseBytes).toBe(heapBytes);
  const first = heapReceipts[0]!;
  collect(first.id);
  collect(first.id);
  expect(runtime.snapshot().awaitingReleaseBytes).toBe(heapBytes);
  for (const item of heapReceipts) collect(item.id);
  expect(runtime.snapshot().sharedGuests).toEqual([]);
  const next = runtime.sharedGuests.create({ owner, ...shape });
  next.fail(new Error("retained original incarnation"));
  for (const item of registrations) {
    collect(item.id);
    collect(item.id);
  }
  expect(runtime.snapshot().debtBytes).toBe(heapBytes);
  expect(runtime.snapshot().sharedGuests[0]?.phase).toBe("debt");
});

async function retireWithCapturedBuffers(
  runtime: RuntimeReservations,
  backing: SharedGuestBacking,
) {
  const service = backing.alias({ kind: "service", incarnation: 4 });
  const initial = guest(backing, 1);
  const worker = await launched(runtime, initial);
  const serviceWorker = await launched(runtime, service, true);
  const call = backing.continuation({ thread, sequence: 1 });
  const release = call.retain(sharedBuffer(worker.memory));
  worker.memory.grow(1);
  const releaseCurrent = call.retain(sharedBuffer(worker.memory));
  release();
  releaseCurrent();
  await call.settle(() => {});
  backing.seal(exit);
  await initial.stop(worker.lifecycle);
  await serviceFence(backing, service);
  await service.stop(serviceWorker.lifecycle);
  expect(backing.retire().kind).toBe("awaiting-collection");
}

test("failure recording the final grown buffer retains the same heap debt without a contradiction refund", async () => {
  let refuseReceipt = false;
  const ledger = new SharedMemoryLedger(platform, undefined, () => ({
    register() {
      if (refuseReceipt) throw new Error("weak receipt registration failed");
    },
  }));
  const { runtime, backing } = setup(ledger);
  const service = backing.alias({ kind: "service", incarnation: 1 });
  const initial = guest(backing, 1);
  const serviceWorker = await launched(runtime, service, true);
  const initialWorker = await launched(runtime, initial);
  serviceWorker.memory.grow(1);
  backing.seal(exit);
  await initial.stop(initialWorker.lifecycle);
  await serviceFence(backing, service);
  await service.stop(serviceWorker.lifecycle);
  refuseReceipt = true;
  expect(() => backing.retire()).toThrow("receipt registration failed");
  expect(backing.retire().kind).toBe("debt");
  expect(runtime.snapshot()).toMatchObject({ debtBytes: heapBytes, contradictions: [] });
  runtime.dispose();
  expect(runtime.snapshot().sharedGuests).toHaveLength(1);
  expect(runtime.snapshot().debtBytes).toBe(heapBytes);
});

test("post-allocation receipt failure is sticky debt, not a refundable native constructor refusal", () => {
  const ledger = new SharedMemoryLedger(platform, undefined, () => ({
    register() {
      throw new RangeError("receipt infrastructure failed after construction");
    },
  }));
  const runtime = ledger.openRuntime(platform);
  runtimes.add(runtime);
  expect(() => runtime.sharedGuests.create({ owner, ...shape })).toThrow("receipt infrastructure");
  expect(runtime.snapshot()).toMatchObject({
    reservedBytes: heapBytes,
    debtBytes: heapBytes,
    contradictions: [],
    effectiveBudgetBytes: 512 * 1024 ** 2,
  });
  runtime.dispose();
  expect(ledger.openRuntime(platform).snapshot().debtBytes).toBe(heapBytes);
});

test("uncounted shared Memory refusal does not lower the existing policy cap", () => {
  const uncounted = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(heapBytes),
    counts: { fixedBuffer: true, sharedMemory: false, privateMemory: true },
  });
  let attempts = 0;
  const ledger = new SharedMemoryLedger(uncounted, undefined, undefined, () => {
    attempts++;
    throw new RangeError("uncounted native refusal");
  });
  const runtime = ledger.openRuntime(uncounted);
  runtimes.add(runtime);
  const before = runtime.snapshot();
  expect(() => runtime.sharedGuests.create({ owner, ...shape })).toThrow(
    SharedMemoryAdmissionError,
  );
  expect(runtime.snapshot()).toEqual(before);
  expect(attempts).toBe(1);
});
