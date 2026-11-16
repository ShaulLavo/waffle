import { afterEach, expect, test } from "bun:test";
import { createGroupMember } from "../group/member.ts";
import {
  MEMBER_CELL_WORDS,
  WAIT_ADDR,
  WAIT_CLOSED,
  WAIT_EPOCH,
  WAIT_WIDTH,
} from "../group/protocol.ts";
import { MemoryGroups, type MemberLease } from "../group/state.ts";
import type { FutexFixtureRequest } from "./fixtures/group-futex-worker.ts";
import {
  SharedMemoryLedger,
  declareSharedMemoryPlatform,
  type ReservationAllocator,
} from "../memory/reservations.ts";

interface Message {
  event: string;
  result?: number | string;
  values?: number[];
  error?: string;
  stage?: string;
  epoch?: number;
  closed?: number;
  closedReads?: number;
  timeout?: number;
}
const workers: { worker: Worker; closed: Promise<void>; lease: MemberLease }[] = [];
const leases: MemberLease[] = [];
const gates: Int32Array[] = [];
const ports: MessagePort[] = [];
const nativeWaitCells: Int32Array[] = [];
afterEach(async () => {
  for (const { worker, lease } of workers) {
    try {
      worker.terminate();
    } finally {
      lease.stopRequested();
    }
  }
  for (const gate of gates) {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
  }
  for (const cells of nativeWaitCells) Atomics.notify(cells, 16, Infinity);
  for (const lease of leases) lease.abort();
  await Promise.all(workers.map(({ closed }) => closed));
  for (const lease of leases) lease.stopped();
  for (const port of ports) port.close();
  workers.length = leases.length = gates.length = 0;
  ports.length = 0;
  nativeWaitCells.length = 0;
});

function setup() {
  const groups = new MemoryGroups({ maximumPages: 4, members: 4 });
  let pid = 0;
  const reserve = (join: "new" | MemberLease = "new", admission?: () => boolean) => {
    const lease = groups.admit(
      ++pid,
      "futex",
      join === "new" ? "new" : join.group,
      null,
      admission,
    );
    leases.push(lease);
    return lease;
  };
  return { groups, reserve };
}

function launch(lease: MemberLease, options: Partial<Omit<FutexFixtureRequest, "request">> = {}) {
  const launched = lease.launch();
  ports.push(launched.request.port);
  const cells = new Int32Array(launched.request.reply);
  const worker = new Worker(new URL("./fixtures/group-futex-worker.ts", import.meta.url).href);
  const closed = new Promise<void>((resolve) =>
    worker.addEventListener("close", () => resolve(), { once: true }),
  );
  workers.push({ worker, closed, lease });
  const queue: Message[] = [];
  let notify: (() => void) | undefined;
  let failure: unknown;
  worker.onmessage = ({ data }: MessageEvent<Message>) => {
    queue.push(data);
    notify?.();
  };
  worker.onerror = (error) => {
    failure = error;
    notify?.();
  };
  const next = async (event: string): Promise<Message> => {
    for (;;) {
      if (failure) throw failure;
      const index = queue.findIndex((message) => message.event === event);
      if (index !== -1) return queue.splice(index, 1)[0]!;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  };
  const start = () =>
    worker.postMessage(
      { request: launched.request, addr: 64, width: 4, ...options },
      launched.transfer,
    );
  return { cells, worker, request: launched.request, next, start };
}

function gate() {
  const cells = new Int32Array(new SharedArrayBuffer(4));
  gates.push(cells);
  return {
    buffer: cells.buffer,
    release() {
      Atomics.store(cells, 0, 1);
      Atomics.notify(cells, 0);
    },
  };
}

/** Only a positive native notify count establishes an actual parked waiter. */
async function notifyWaiter(notify: () => number): Promise<number> {
  for (;;) {
    const count = notify();
    if (count) return count;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// (module (import "env" "memory" (memory 1 4 shared))
//   (func (export "notify") (param i32 i32) (result i32)
//     local.get 0 local.get 1 memory.atomic.notify))
const notifyModule = new WebAssembly.Module(
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 2, 16, 1, 3, 101, 110, 118, 6,
    109, 101, 109, 111, 114, 121, 2, 3, 1, 4, 3, 2, 1, 0, 7, 10, 1, 6, 110, 111, 116, 105, 102, 121,
    0, 0, 10, 12, 1, 10, 0, 32, 0, 32, 1, 254, 0, 2, 0, 11,
  ]),
);

for (const width of [4, 8] as const) {
  for (const source of ["js", "wasm"] as const) {
    test(`raw ${source} notify wakes the unchanged provider wait${width * 8}`, async () => {
      const { reserve } = setup();
      const f = launch(reserve(), { width });
      f.start();
      await f.next("ready");
      const native = new WebAssembly.Instance(notifyModule, { env: { memory: f.request.memory } })
        .exports.notify;
      if (typeof native !== "function") throw new Error("missing notify export");
      const notify =
        source === "js"
          ? () => Atomics.notify(new Int32Array(f.request.memory.buffer), 16, 1)
          : () => Number(native(64, 1));
      expect(await notifyWaiter(notify)).toBe(1);
      expect((await f.next("result")).result).toBe(0);
      expect(Atomics.load(f.cells, WAIT_EPOCH)).toBe(2);
    }, 10_000);
  }
  test(`provider wake counts a raw wait${width * 8}`, async () => {
    const { reserve } = setup();
    const f = launch(reserve(), { width, mode: "raw" });
    const member = createGroupMember(f.request, { checkActive() {} });
    try {
      f.start();
      await f.next("ready");
      expect(await notifyWaiter(() => member.imports.futex_wake!(64, 1))).toBe(1);
      expect((await f.next("result")).result).toBe("ok");
    } finally {
      member.dispose();
    }
  }, 10_000);

  test(`wait${width * 8} preserves not-equal and one real deadline`, async () => {
    const { reserve } = setup();
    const f = launch(reserve(), { width, mode: "statuses" });
    f.start();
    expect((await f.next("result")).values).toEqual([1, 2]);
    expect((await f.next("native-entry")).timeout).toBe(Infinity);
    expect((await f.next("native-entry")).timeout).toBe(1);
    expect(Atomics.load(f.cells, WAIT_EPOCH)).toBe(4);
  });

  test(`whole-group close wakes wait${width * 8}, with D1 limited to the exact address`, async () => {
    const { groups, reserve } = setup();
    const a = reserve(),
      b = reserve(a);
    const f = launch(a, { width });
    const other = launch(b, { width, addr: 80 });
    f.start();
    other.start();
    await f.next("ready");
    await other.next("ready");
    await f.next("pending");
    await other.next("pending");
    await f.next("native-entry");
    await other.next("native-entry");
    // These raw async registrations are synchronous. Teardown may wake a non-member here.
    const words = new Int32Array(f.request.memory.buffer);
    const raw = Atomics.waitAsync(words, 16, 0);
    const unrelated = Atomics.waitAsync(words, 24, 0);
    expect(raw.async && unrelated.async).toBe(true);
    a.stopRequested();
    expect(Atomics.load(f.cells, WAIT_CLOSED)).toBe(0);
    b.stopRequested();
    expect(Atomics.load(f.cells, WAIT_CLOSED)).toBe(1);
    expect(await raw.value).toBe("ok");
    expect((await f.next("stopped")).error).toContain("memory group member stopped");
    expect((await other.next("stopped")).error).toContain("memory group member stopped");
    expect(Atomics.notify(words, 24)).toBe(1);
    expect(await unrelated.value).toBe("ok");
    expect(() => groups.admit(99, "futex", a.group)).toThrow("admission is closed");
  }, 10_000);
}

/** waitAsync's async return establishes registration before any tested wake runs. */
async function nativeWakeBudgets(
  member: ReturnType<typeof createGroupMember>,
  buffer: SharedArrayBuffer,
): Promise<void> {
  const words = new Int32Array(buffer);
  nativeWaitCells.push(words);
  const raw32 = Atomics.waitAsync(words, 16, 0);
  const raw64 = Atomics.waitAsync(new BigInt64Array(buffer), 8, 0n);
  expect([raw32.async, raw64.async]).toEqual([true, true]);
  expect(member.imports.futex_watch!(64, 0, 0)).toBe(0);
  expect(member.imports.futex_watch!(64, 0, 4)).toBe(0);
  expect(member.imports.futex_wake!(64, 0)).toBe(0);
  expect([member.watchReady(1), member.watchReady(2)]).toEqual([false, false]);
  expect(member.imports.futex_wake!(64, 2)).toBe(2);
  expect(await Promise.all([raw32.value, raw64.value])).toEqual(["ok", "ok"]);
  expect([member.watchReady(1), member.watchReady(2)]).toEqual([false, false]);
  expect(member.imports.futex_wake!(64, 1)).toBe(1);
  expect([member.watchReady(1), member.watchReady(2)]).toEqual([true, false]);
  const lastRaw = Atomics.waitAsync(words, 16, 0);
  expect(lastRaw.async).toBe(true);
  expect(member.imports.futex_wake!(64, -1)).toBe(2);
  expect(await lastRaw.value).toBe("ok");
  expect(member.watchReady(2)).toBe(true);
  expect(member.imports.futex_wake!(64, -1)).toBe(0);
}

for (const width of [4, 8] as const) {
  for (const forced of [false, true]) {
    test(`provider wait${width * 8} and deterministic native/watch wake budgets, before-park gate=${forced}`, async () => {
      const { reserve } = setup();
      const pause = gate();
      const lease = reserve();
      const f = launch(lease, {
        width,
        ...(forced ? { stage: "after-entry", gate: pause.buffer } : {}),
      });
      const member = createGroupMember(f.request, { checkActive() {} });
      try {
        f.start();
        await f.next("native-entry");
        if (forced) await beforeParkWake(f, member, pause);
        // With no competing raw waiters or watches, this one consumed wake proves provider parking.
        expect(await notifyWaiter(() => member.imports.futex_wake!(64, 1))).toBe(1);
        expect((await f.next("result")).result).toBe(0);
        expect(Atomics.load(f.cells, WAIT_EPOCH)).toBe(2);
        await nativeWakeBudgets(member, lease.group.buffer());
      } finally {
        member.dispose();
      }
    });
  }
}

async function beforeParkWake(
  f: ReturnType<typeof launch>,
  member: ReturnType<typeof createGroupMember>,
  pause: ReturnType<typeof gate>,
): Promise<void> {
  const receipt = await f.next("gate");
  expect(receipt.stage).toBe("after-entry");
  expect(receipt.closed).toBe(0);
  expect(receipt.closedReads).toBe(1);
  expect(receipt.epoch).toBe(1);
  const cells = new Int32Array(f.request.memory.buffer);
  nativeWaitCells.push(cells);
  const raw = Atomics.waitAsync(cells, 16, 0);
  expect(raw.async).toBe(true);
  expect(member.imports.futex_watch!(64, 0, 0)).toBe(0);
  expect(member.imports.futex_watch!(64, 0, 4)).toBe(0);
  expect(member.imports.futex_wake!(64, 2)).toBe(2);
  expect(await raw.value).toBe("ok");
  // The provider is positively gated outside the queue: the second wake belongs to watch 1.
  expect([member.watchReady(1), member.watchReady(2)]).toEqual([true, false]);
  expect(member.imports.futex_unwatch!(1)).toBe(0);
  expect(member.imports.futex_unwatch!(2)).toBe(0);
  pause.release();
}

for (const width of [4, 8] as const) {
  test(`a real individual wait${width * 8} stop adds no wake to a live same-cell sibling`, async () => {
    const { reserve } = setup();
    const a = reserve(),
      b = reserve(a);
    const f = launch(a, { width }),
      g = launch(b, { width });
    const waker = createGroupMember(f.request, { checkActive() {} });
    try {
      f.start();
      g.start();
      await f.next("native-entry");
      await g.next("native-entry");
      const exited = new Promise<void>((resolve) =>
        f.worker.addEventListener("close", () => resolve(), { once: true }),
      );
      const ended = f.worker.terminate();
      a.stopRequested();
      await ended;
      await exited;
      a.stopped();
      expect(Atomics.load(g.cells, WAIT_EPOCH) & 1).toBe(1);
      expect(waker.imports.futex_wake!(64, 1)).toBe(1);
      expect((await g.next("result")).result).toBe(0);
    } finally {
      waker.dispose();
    }
  });
  test(`close before wait${width * 8} registration refuses native parking`, async () => {
    const { reserve } = setup();
    const lease = reserve(),
      f = launch(lease, { width });
    lease.stopRequested();
    f.start();
    expect((await f.next("stopped")).error).toContain("memory group member stopped");
    expect(Atomics.load(f.cells, WAIT_EPOCH)).toBe(2);
  });
}

test("old nine-word requests are refused rather than accepted with a fallback", () => {
  const { reserve } = setup();
  const f = launch(reserve());
  expect(() =>
    createGroupMember({ ...f.request, reply: new SharedArrayBuffer(36) }, { checkActive() {} }),
  ).toThrow("invalid memory group member cells");
});

test("reserved successor and retained pre-attempt failure block closure", () => {
  const { groups, reserve } = setup();
  const a = reserve(),
    b = reserve(a),
    successor = reserve(a);
  const f = launch(a),
    g = launch(b);
  a.stopRequested();
  b.failed();
  expect(Atomics.load(f.cells, WAIT_CLOSED)).toBe(0);
  successor.abort();
  expect(Atomics.load(f.cells, WAIT_CLOSED)).toBe(0);
  b.stopRequested();
  expect(Atomics.load(f.cells, WAIT_CLOSED)).toBe(1);
  expect(Atomics.load(g.cells, WAIT_CLOSED)).toBe(1);
  expect(groups.snapshot()[0]?.retained).toBe(1);
  expect(groups.budget.committed).toBeGreaterThan(0);
});

test("reserved leases stay launchable, and their abort retries the last terminal decision", () => {
  const { reserve } = setup();
  const a = reserve(),
    successor = reserve(a);
  const f = launch(a);
  a.stopRequested();
  expect(Atomics.load(f.cells, WAIT_CLOSED)).toBe(0);
  const next = launch(successor);
  successor.stopRequested();
  expect(Atomics.load(next.cells, WAIT_CLOSED)).toBe(1);
});

test("an exact exec rollback never reopens a terminal seal", () => {
  const { groups, reserve } = setup();
  const a = reserve();
  launch(a);
  const closing = a.closeAdmission();
  a.stopRequested();
  closing.rollback();
  expect(() => groups.admit(99, "futex", a.group)).toThrow("admission is closed");
});

test("staggered release preserves A's private record across slot reuse C and late old lease calls", async () => {
  const { groups, reserve } = setup();
  const a = reserve(),
    b = reserve(a);
  const f = launch(a),
    g = launch(b, { addr: 80 });
  f.start();
  g.start();
  await f.next("ready");
  await g.next("ready");
  await f.next("pending");
  await g.next("pending");
  await f.next("native-entry");
  await g.next("native-entry");
  a.stopRequested();
  a.stopped();
  expect(Atomics.load(f.cells, WAIT_CLOSED)).toBe(0);
  const c = reserve(b),
    h = launch(c, { addr: 96 });
  expect(c.index).toBe(a.index);
  expect(h.cells.buffer).not.toBe(f.cells.buffer);
  a.stopRequested();
  a.failed();
  a.stopped();
  h.start();
  await h.next("ready");
  await h.next("pending");
  await h.next("native-entry");
  b.stopRequested();
  b.stopped();
  expect(Atomics.load(f.cells, WAIT_CLOSED)).toBe(0);
  c.stopRequested();
  await Promise.all([f.next("stopped"), g.next("stopped"), h.next("stopped")]);
  c.stopped();
  expect(groups.snapshot()).toEqual([]);
  expect(Reflect.get(groups.owner(c.group)!, "retiredWaits")).toEqual([]);
}, 10_000);

for (const stage of ["address", "width", "epoch", "exit", "post-closed"] as const) {
  test(`retired pre-publication and repeat-wait race at ${stage}`, async () => {
    const { reserve } = setup();
    const a = reserve(),
      b = reserve(a);
    const pause = gate();
    const f = launch(a, { stage, gate: pause.buffer, repeat: stage === "post-closed" ? 2 : 1 });
    launch(b);
    f.start();
    await f.next("gate");
    a.stopped();
    expect(Atomics.load(f.cells, WAIT_CLOSED)).toBe(0);
    b.stopRequested();
    expect(Atomics.load(f.cells, WAIT_CLOSED)).toBe(1);
    pause.release();
    expect((await f.next("stopped")).error).toContain("memory group member stopped");
  }, 10_000);
}

test("a native wait throw clears the epoch before propagation", async () => {
  const { reserve } = setup();
  const f = launch(reserve(), { throwWait: true });
  f.start();
  expect((await f.next("stopped")).error).toContain("native wait injection");
  expect(Atomics.load(f.cells, WAIT_EPOCH)).toBe(2);
});

for (const epoch of [0x7ffffffe, -2]) {
  test(`real member epochs preserve entry/exit parity across ${epoch}`, async () => {
    const { reserve } = setup();
    const pause = gate();
    const f = launch(reserve(), { gate: pause.buffer, stage: "epoch" });
    Atomics.store(f.cells, WAIT_EPOCH, epoch);
    f.start();
    expect((await f.next("gate")).epoch).toBe((epoch + 1) | 0);
    Atomics.store(f.cells, WAIT_CLOSED, 1);
    pause.release();
    await f.next("stopped");
    expect(Atomics.load(f.cells, WAIT_EPOCH)).toBe((epoch + 2) | 0);
  });
}

test("unsigned high-address snapshots and both widths use an i32 byte location and fresh bounds", () => {
  const { groups, reserve } = setup();
  const a = reserve();
  const f = launch(a);
  const owner = groups.owner(a.group)!;
  const memory = Reflect.get(owner, "memory");
  const old = Object.getOwnPropertyDescriptor(memory, "buffer");
  const realNotify = Atomics.notify;
  const locations: number[] = [];
  // A small view stands in only for the byte-length descriptor. No 4 GiB allocation.
  Object.defineProperty(memory, "buffer", {
    configurable: true,
    get: () => ({ byteLength: 0x100000000 }),
  });
  const realInt32 = globalThis.Int32Array;
  globalThis.Int32Array = new Proxy(realInt32, { construct: () => new realInt32(1) });
  Atomics.notify = (_view, index) => {
    locations.push(index);
    return 0;
  };
  try {
    for (const width of [4, 8]) {
      Atomics.store(f.cells, WAIT_ADDR, 0x80000000);
      Atomics.store(f.cells, WAIT_WIDTH, width);
      Atomics.store(f.cells, WAIT_EPOCH, 1);
      Reflect.apply(Reflect.get(owner, "closeWait"), owner, [f.cells]);
    }
    expect(locations).toEqual([0x20000000, 0x20000000]);
    Object.defineProperty(memory, "buffer", { configurable: true, value: { byteLength: 64 } });
    Reflect.apply(Reflect.get(owner, "closeWait"), owner, [f.cells]);
    expect(locations).toHaveLength(2);
  } finally {
    globalThis.Int32Array = realInt32;
    Atomics.notify = realNotify;
    if (old) Object.defineProperty(memory, "buffer", old);
    else Reflect.deleteProperty(memory, "buffer");
  }
  expect(f.cells.byteLength).toBe(MEMBER_CELL_WORDS * 4);
});

test("incarnation controls add 16 counted bytes and retired records retain their collection charge", () => {
  const platform = declareSharedMemoryPlatform({ kind: "unbounded" });
  const receipts: { target: WeakRef<object>; id: number }[] = [];
  let collect: (id: number) => void = () => {};
  const runtime = new SharedMemoryLedger(platform, undefined, (receive) => {
    collect = receive;
    return {
      register(target, id) {
        receipts.push({ target: new WeakRef(target), id });
      },
    };
  }).openRuntime(platform);
  const groups = new MemoryGroups({ maximumPages: 4 }, runtime.groups, runtime.sizing);
  const a = groups.admit(1, "charge", "new"),
    b = groups.admit(2, "charge", a.group);
  leases.push(a, b);
  const before = runtime.snapshot().reservedBytes;
  const launched = a.launch();
  ports.push(launched.request.port);
  expect(launched.request.reply.byteLength).toBe(36 + 16);
  expect(runtime.snapshot().reservedBytes - before).toBe(52);
  const receipt = receipts.find((entry) => entry.target.deref() === launched.request.reply)!;
  expect(receipt).toBeDefined();
  a.stopped();
  expect(Reflect.get(groups.owner(a.group)!, "retiredWaits")).toHaveLength(1);
  expect(runtime.snapshot().reservedBytes - before).toBe(52);
  b.abort();
  expect(Reflect.get(groups.owner(a.group)!, "retiredWaits")).toEqual([]);
  // Inject the ledger's collection receipt, not a claim about physical/native collection.
  const charged = runtime.snapshot().reservedBytes;
  collect(receipt.id);
  expect(charged - runtime.snapshot().reservedBytes).toBe(52);
  runtime.dispose();
});

test("a refused 13-word control construction refunds its provisional reservation", () => {
  const platform = declareSharedMemoryPlatform({ kind: "unbounded" });
  const allocator: ReservationAllocator = {
    buffer(shape) {
      if (shape.kind === "fixed-buffer" && shape.length === MEMBER_CELL_WORDS * 4)
        throw new Error("control construction failed");
      return shape.kind === "fixed-buffer"
        ? new SharedArrayBuffer(shape.length)
        : new SharedArrayBuffer(shape.initial, { maxByteLength: shape.maximum });
    },
    memory(shape) {
      return new WebAssembly.Memory({
        initial: shape.kind === "fixed" ? shape.pages : 1,
        maximum: shape.kind === "fixed" ? shape.pages : shape.maximumPages,
        shared: true,
      });
    },
  };
  const runtime = new SharedMemoryLedger(platform, allocator).openRuntime(platform);
  const groups = new MemoryGroups({ maximumPages: 4 }, runtime.groups, runtime.sizing);
  const lease = groups.admit(1, "charge", "new");
  leases.push(lease);
  const before = runtime.snapshot().reservedBytes;
  expect(() => lease.launch()).toThrow("control construction failed");
  expect(runtime.snapshot().reservedBytes).toBe(before);
  lease.abort();
  runtime.dispose();
});
