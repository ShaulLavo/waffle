import { afterEach, beforeEach, expect, test } from "bun:test";
import type { GroupMemorySource, ReservationSizing, WasmPages } from "../memory/reservations.js";
import { GroupOp, PAGE_BYTES, WAIT_EPOCH } from "../group/protocol.js";
import { MemoryGroups, type MemberLease } from "../group/state.js";

// Plan group-futex-retirement, gap 1. Bun has no Web Locks, so these tests install a manual
// lock manager and check the owner's bookkeeping; the browser regression test
// (tests/running-member-reuse-browser-runner.ts) checks real threads.
interface Pending {
  readonly callback: (lock: Lock | null) => unknown;
  readonly resolve: (value: unknown) => void;
}

class ManualLocks {
  readonly pending = new Map<string, Pending>();
  request(name: string, callback: (lock: Lock | null) => unknown) {
    return new Promise((resolve) => this.pending.set(name, { callback, resolve }));
  }
  /** The agent's thread exited: the owner's request is granted. Returns what it holds. */
  grant(name: string): unknown {
    const entry = this.pending.get(name);
    if (!entry) throw new Error(`no pending request for ${name}`);
    this.pending.delete(name);
    const held = entry.callback({ name, mode: "exclusive" } as Lock);
    entry.resolve(held);
    return held;
  }
}

let locks: ManualLocks;
beforeEach(() => {
  locks = new ManualLocks();
  Object.defineProperty(globalThis.navigator, "locks", { value: locks, configurable: true });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis.navigator, "locks");
});

function group() {
  const groups = new MemoryGroups({ stackBytes: 64 * 1024, maximumPages: 16 });
  const anchor = groups.admit(1, "d", "new");
  anchor.launch().request.port.close();
  const owner = groups.owner(anchor.group)!;
  let pid = 2;
  const join = (keepPort = false) => {
    const lease = groups.admit(pid++, "d", anchor.group);
    const { request } = lease.launch();
    if (!keepPort) request.port.close();
    return { lease, request };
  };
  const op = (lease: MemberLease, code: number, a = 0, b = 0) => owner.request(lease, code, a, b);
  const stop = (lease: MemberLease) => {
    lease.stopRequested();
    lease.stopped();
  };
  const end = () => stop(anchor);
  return { groups, owner, join, op, stop, end };
}

test("a busy member's chunk is withheld until its exit lock is granted", () => {
  const { owner, join, op, stop, end } = group();
  const busy = join(),
    keeper = join();
  expect(busy.request.exitLock).toMatch(/^waffle-group-exit-/);
  expect(keeper.request.exitLock).not.toBe(busy.request.exitLock);
  const [page] = op(busy.lease, GroupOp.GROW, 2);
  stop(busy.lease);
  expect(owner.snapshot()).toMatchObject({ exiting: 1, quarantinedBytes: 2 * PAGE_BYTES });
  expect(locks.pending.has(busy.request.exitLock!)).toBe(true);
  expect(op(keeper.lease, GroupOp.GROW, 2)[0]).not.toBe(page);
  locks.grant(busy.request.exitLock!);
  expect(owner.snapshot()).toMatchObject({ exiting: 0, quarantinedBytes: 0 });
  expect(op(keeper.lease, GroupOp.GROW, 2)[0]).toBe(page!);
  stop(keeper.lease);
  locks.grant(keeper.request.exitLock!);
  end();
});

test("a member parked in a closed futex wait is reused at once, with no lock request", () => {
  const { owner, join, op, stop, end } = group();
  const sleeper = join(),
    keeper = join();
  const [page] = op(sleeper.lease, GroupOp.GROW, 1);
  // The member's published wait record: odd epoch, as group/member.ts writes before parking.
  Atomics.store(new Int32Array(sleeper.request.reply), WAIT_EPOCH, 1);
  stop(sleeper.lease);
  expect(owner.snapshot()).toMatchObject({ exiting: 0, quarantinedBytes: 0 });
  expect(locks.pending.has(sleeper.request.exitLock!)).toBe(false);
  expect(op(keeper.lease, GroupOp.GROW, 1)[0]).toBe(page!);
  stop(keeper.lease);
  locks.grant(keeper.request.exitLock!);
  end();
});

test("a region an exiting member held stays allocated after its last live holder leaves", () => {
  const { owner, join, op, stop, end } = group();
  const busy = join(),
    keeper = join();
  const [, handle] = op(busy.lease, GroupOp.CREATE, 2 * PAGE_BYTES, PAGE_BYTES);
  expect(op(keeper.lease, GroupOp.ATTACH, handle!)[0]).toBe(0);
  stop(busy.lease);
  expect(op(keeper.lease, GroupOp.DETACH, handle!)[0]).toBe(0);
  expect(owner.snapshot()).toMatchObject({ regions: 1, exiting: 1 });
  const free = owner.snapshot().freeBytes;
  locks.grant(busy.request.exitLock!);
  expect(owner.snapshot()).toMatchObject({ regions: 0, exiting: 0 });
  expect(owner.snapshot().freeBytes).toBe(free + 2 * PAGE_BYTES);
  stop(keeper.lease);
  locks.grant(keeper.request.exitLock!);
  end();
});

/** A bounded-mode source: one fixed backing, recording what is retired and how. */
function fixedSource() {
  const retired: { exposed: boolean }[] = [];
  const source: GroupMemorySource = {
    control: (length) => new SharedArrayBuffer(length),
    create: () => ({
      kind: "fixed",
      memory: new WebAssembly.Memory({ initial: 16, maximum: 16, shared: true }),
      pages: 16 as WasmPages,
      exposed: false,
    }),
    retire: (backing) => retired.push({ exposed: backing.exposed }),
    failed() {},
  };
  const sizing = {
    arena: { bytes: 0, fallback: null },
    groupShape: () => ({ kind: "fixed", pages: 16 }),
  } as unknown as ReservationSizing;
  const groups = new MemoryGroups({ stackBytes: 64 * 1024, maximumPages: 16 }, source, sizing);
  return { groups, retired };
}

test("a group whose last member stops busy returns its fixed backing once the exit is proven", () => {
  const { groups, retired } = fixedSource();
  const only = groups.admit(1, "d", "new");
  const { request } = only.launch();
  request.port.close();
  expect(groups.owner(only.group)!.request(only, GroupOp.GROW, 1)[0]).toBeGreaterThan(0);
  only.stopRequested();
  only.stopped();
  expect(groups.snapshot()).toEqual([]);
  expect(retired).toEqual([]);
  locks.grant(request.exitLock!);
  expect(retired).toEqual([{ exposed: false }]);
});

test("a group whose last member never proves its exit keeps its backing out of the pool", () => {
  const { groups, retired } = fixedSource();
  const only = groups.admit(1, "d", "new");
  only.launch().request.port.close();
  only.stopRequested();
  only.stopped();
  expect(groups.snapshot()).toEqual([]);
  expect(retired).toEqual([]);
});

test("a granted exit lock is released at once only when the agent provably took it", async () => {
  const { join, stop, end } = group();
  const quiet = join(),
    started = join(true);
  // The agent's first request: browser/worker.ts sends none before taking its exit lock.
  started.request.port.postMessage({ seq: 1, op: GroupOp.GROW, args: [1, 0, 0, 0] });
  const reply = new Int32Array(started.request.reply);
  while (Atomics.load(reply, 0) !== 1) await Bun.sleep(1);
  started.request.port.close();
  stop(quiet.lease);
  stop(started.lease);
  // No request arrived from `quiet`: it may not have taken its lock yet, so the owner keeps it.
  expect(locks.grant(quiet.request.exitLock!)).toBeInstanceOf(Promise);
  expect(locks.grant(started.request.exitLock!)).toBeUndefined();
  end();
});

test("without a lock manager the owner issues no exit lock and reuses at stop", () => {
  Reflect.deleteProperty(globalThis.navigator, "locks");
  const { owner, join, op, stop, end } = group();
  const busy = join(),
    keeper = join();
  expect(busy.request.exitLock).toBeUndefined();
  const [page] = op(busy.lease, GroupOp.GROW, 1);
  stop(busy.lease);
  expect(owner.snapshot()).toMatchObject({ exiting: 0, quarantinedBytes: 0 });
  expect(op(keeper.lease, GroupOp.GROW, 1)[0]).toBe(page!);
  stop(keeper.lease);
  end();
});
