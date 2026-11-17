import { afterEach, beforeEach, expect, test } from "bun:test";
import { GroupOp, PAGE_BYTES, WAIT_EPOCH } from "../group/protocol.js";
import { MemoryGroups, type MemberLease } from "../group/state.js";

// Plan group-futex-retirement, gap 1. Bun has no Web Locks, so these tests install a manual
// lock manager and check the owner's bookkeeping; the browser regression test
// (tests/running-member-reuse-browser-runner.ts) checks real threads.
interface Pending {
  readonly callback: (lock: Lock | null) => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  aborted: boolean;
}

class ManualLocks {
  readonly pending = new Map<string, Pending>();
  request(name: string, options: LockOptions, callback: (lock: Lock | null) => unknown) {
    return new Promise((resolve, reject) => {
      const entry: Pending = { callback, resolve, reject, aborted: false };
      options.signal?.addEventListener("abort", () => {
        entry.aborted = true;
        this.pending.delete(name);
        reject(new DOMException("aborted", "AbortError"));
      });
      this.pending.set(name, entry);
    });
  }
  /** The agent's thread exited: the owner's request is granted. */
  grant(name: string): void {
    const entry = this.pending.get(name);
    if (!entry) throw new Error(`no pending request for ${name}`);
    this.pending.delete(name);
    entry.resolve(entry.callback({ name, mode: "exclusive" } as Lock));
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
  const join = () => {
    const lease = groups.admit(pid++, "d", anchor.group);
    const { request } = lease.launch();
    request.port.close();
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

test("group end abandons unproven exits, and a late grant changes nothing", () => {
  const { groups, join, op, stop, end } = group();
  const busy = join();
  op(busy.lease, GroupOp.GROW, 1);
  stop(busy.lease);
  const name = busy.request.exitLock!;
  const pending = locks.pending.get(name)!;
  end();
  expect(groups.snapshot()).toEqual([]);
  expect(pending.aborted).toBe(true);
  expect(pending.callback({ name, mode: "exclusive" } as Lock)).toBeUndefined();
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
