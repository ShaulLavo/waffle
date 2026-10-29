import { expect, test } from "bun:test";
import { GroupOp, PAGE_BYTES } from "../group/protocol.js";
import { MemoryGroups, type MemberLease } from "../group/state.js";
import { ProcessError } from "../proc/errors.js";

const MiB = 1024 * 1024;

function setup(options: ConstructorParameters<typeof MemoryGroups>[0] = {}) {
  const groups = new MemoryGroups({ stackBytes: 64 * 1024, ...options });
  const launched = new Set<MemberLease>();
  const join = (pid: number, to: MemberLease | "new" = "new") => {
    const lease = groups.admit(pid, "d", to === "new" ? "new" : to.group);
    lease.launch().request.port.close();
    launched.add(lease);
    return lease;
  };
  const op = (lease: MemberLease, code: number, a = 0, b = 0) =>
    groups.owner(lease.group)!.request(lease, code, a, b);
  const snapshot = (lease: MemberLease) => groups.owner(lease.group)!.snapshot();
  return { groups, join, op, snapshot };
}

function errno(fn: () => unknown): number {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProcessError) return error.errno;
    throw error;
  }
  return 0;
}

test("W1 counts the leader and pending reservations, and returns capacity once", () => {
  const { groups, join } = setup({ members: 3 });
  const leader = join(1);
  const pending = groups.admit(2, "d", leader.group);
  join(3, leader);
  expect(errno(() => groups.admit(4, "d", leader.group))).toBe(6);
  pending.abort();
  pending.abort();
  const late = groups.admit(5, "d", leader.group);
  expect(errno(() => groups.admit(6, "d", leader.group))).toBe(6);
  expect(groups.owner(leader.group)!.snapshot().reserved).toBe(1);
  late.abort();
  expect(errno(() => groups.admit(7, "d", leader.group))).toBe(0);
});

test("joining another directory is rejected without reserving", () => {
  const { groups, join } = setup({ members: 4 });
  const leader = join(1);
  expect(errno(() => groups.admit(2, "elsewhere", leader.group))).toBe(28);
  expect(groups.owner(leader.group)!.snapshot().members).toBe(1);
});

test("W3 charges committed backing across groups and rejects without partial growth", () => {
  const { groups, join, op } = setup({ budgetBytes: 4 * MiB });
  const first = join(1),
    second = join(2);
  expect(groups.budget.committed).toBe(2 * PAGE_BYTES);
  expect(op(first, GroupOp.GROW, 32)[0]).toBeGreaterThan(0);
  expect(op(second, GroupOp.GROW, 32)[0]).toBe(-48);
  expect(groups.budget.rejected).toEqual({ bytes: 32 * PAGE_BYTES, committed: 34 * PAGE_BYTES });
  expect(op(second, GroupOp.GROW, 29)[0]).toBeGreaterThan(0);
  expect(groups.budget.committed).toBe(63 * PAGE_BYTES);
  expect(op(second, GroupOp.CREATE, 2 * PAGE_BYTES, 16)[0]).toBe(-48);
  first.stopped();
  expect(groups.budget.committed).toBe(30 * PAGE_BYTES);
  second.stopped();
  expect(groups.budget.committed).toBe(0);
  expect(groups.snapshot()).toEqual([]);
});

test("the address-space maximum is separate from the budget", () => {
  const { join, op } = setup({ maximumPages: 8 });
  const member = join(1);
  expect(op(member, GroupOp.GROW, 8)[0]).toBe(-48);
  expect(op(member, GroupOp.GROW, 7)[0]).toBe(1);
});

test("regions free after the last hold and their bytes are reused zeroed", () => {
  const { join, op, snapshot } = setup();
  const a = join(1);
  const b = join(2, a);
  const [status, handle, addr] = op(a, GroupOp.CREATE, 8, 8);
  expect(status).toBe(0);
  expect(addr! % PAGE_BYTES).toBe(0);
  expect(op(b, GroupOp.ATTACH, handle!)).toEqual([0, addr!, 8]);
  new Int32Array(a.group.buffer(), addr!, 2)[1] = 42;
  expect(op(a, GroupOp.DETACH, handle!)[0]).toBe(0);
  expect(op(a, GroupOp.DETACH, handle!)[0]).toBe(-8);
  expect(snapshot(a).regions).toBe(1);
  expect(op(b, GroupOp.DETACH, handle!)[0]).toBe(0);
  expect(snapshot(a)).toMatchObject({ regions: 0, holds: 0, freeBytes: PAGE_BYTES });
  const [, , again] = op(a, GroupOp.CREATE, 8, 8);
  expect(again).toBe(addr!);
  expect(new Int32Array(a.group.buffer(), again!, 2)[1]).toBe(0);
});

test("transit pins have one owner and settle exactly once", () => {
  const { join, op, snapshot } = setup();
  const a = join(1),
    b = join(2, a),
    c = join(3, a);
  const [, handle] = op(a, GroupOp.CREATE, 64, 16);
  const [, pin] = op(a, GroupOp.PIN, handle!);
  expect(op(b, GroupOp.ACCEPT, pin!)[0]).toBe(-8);
  expect(op(a, GroupOp.ROUTE, pin!, 99)[0]).toBe(-71);
  expect(op(a, GroupOp.ROUTE, pin!, 2)[0]).toBe(0);
  expect(op(a, GroupOp.UNPIN, pin!)[0]).toBe(-8);
  // The receiver hands its unread delivery to a surviving consumer.
  expect(op(b, GroupOp.ROUTE, pin!, 3)[0]).toBe(0);
  b.stopped();
  expect(snapshot(a).pins).toBe(1);
  const [status, accepted] = op(c, GroupOp.ACCEPT, pin!);
  expect([status, accepted]).toEqual([0, handle!]);
  expect(op(c, GroupOp.ACCEPT, pin!)[0]).toBe(-8);
  expect(snapshot(a)).toMatchObject({ pins: 0, holds: 2 });
  expect(op(b, GroupOp.PIN, handle!)[0]).toBe(-71);
});

test("a receiver's confirmed death releases its unread pins and frees the region", () => {
  const { join, op, snapshot } = setup();
  const a = join(1),
    b = join(2, a);
  const [, handle] = op(a, GroupOp.CREATE, 64, 16);
  const [, pin] = op(a, GroupOp.PIN, handle!);
  op(a, GroupOp.ROUTE, pin!, 2);
  op(a, GroupOp.DETACH, handle!);
  expect(snapshot(a)).toMatchObject({ regions: 1, pins: 1 });
  b.stopped();
  expect(snapshot(a)).toMatchObject({ regions: 0, pins: 0, holds: 0 });
});

test("a publisher's death releases its staged pins", () => {
  const { join, op, snapshot } = setup();
  const a = join(1),
    b = join(2, a);
  const [, handle] = op(b, GroupOp.CREATE, 64, 16);
  op(b, GroupOp.PIN, handle!);
  b.stopped();
  expect(snapshot(a)).toMatchObject({ regions: 0, pins: 0 });
});

test("W4: a failed physical stop retains capacity, memory and pins", () => {
  const { groups, join, op, snapshot } = setup({ members: 2 });
  const a = join(1),
    b = join(2, a);
  const grown = op(b, GroupOp.GROW, 4)[0]!;
  const [, handle] = op(a, GroupOp.CREATE, 64, 16);
  const [, pin] = op(a, GroupOp.PIN, handle!);
  op(a, GroupOp.ROUTE, pin!, 2);
  const committed = groups.budget.committed;
  b.failed();
  expect(snapshot(a)).toMatchObject({ members: 1, retained: 1, pins: 1, freeBytes: 0 });
  expect(errno(() => groups.admit(3, "d", a.group))).toBe(6);
  expect(op(b, GroupOp.GROW, 1)[0]).toBe(-71);
  expect(op(a, GroupOp.GROW, 4)[0]).not.toBe(grown);
  expect(groups.unsettled()).toBe(2);
  a.stopped();
  expect(groups.snapshot()).toHaveLength(1);
  expect(groups.budget.committed).toBeGreaterThan(committed);
  b.stopped();
  expect(groups.snapshot()).toEqual([]);
  expect(groups.budget.committed).toBe(0);
});

test("a stale incarnation cannot release its replacement", () => {
  const { groups, join, snapshot } = setup({ members: 2 });
  const a = join(1),
    old = join(2, a);
  old.stopped();
  const replacement = join(3, a);
  expect(replacement.index).toBe(old.index);
  old.stopped();
  old.failed();
  old.abort();
  expect(snapshot(a)).toMatchObject({ members: 2, retained: 0, pids: [1, 3] });
  expect(errno(() => groups.admit(4, "d", a.group))).toBe(6);
});

test("an exited member's chunks are reused and committed backing stays flat", () => {
  const { groups, join, op } = setup();
  const leader = join(1);
  const first = join(2, leader);
  const page = op(first, GroupOp.GROW, 8)[0]!;
  new Uint8Array(leader.group.buffer(), page * PAGE_BYTES, 8)[3] = 9;
  first.stopped();
  const committed = groups.budget.committed;
  const second = join(3, leader);
  expect(op(second, GroupOp.GROW, 8)[0]).toBe(page);
  expect(new Uint8Array(leader.group.buffer(), page * PAGE_BYTES, 8)[3]).toBe(0);
  expect(groups.budget.committed).toBe(committed);
});

test("repeated spawn/send/kill returns region, pin and backing counters to baseline", () => {
  const { groups, join, op, snapshot } = setup({ members: 4 });
  const leader = join(1);
  const [, mailbox] = op(leader, GroupOp.CREATE, 16, 16);
  const baseline = () => {
    const { regions, pins, holds, members } = snapshot(leader);
    return { regions, pins, holds, members };
  };
  const before = baseline();
  let committed = 0;
  for (let round = 0; round < 50; round++) {
    const worker = join(100 + round, leader);
    op(worker, GroupOp.GROW, 2);
    const [, handle] = op(leader, GroupOp.CREATE, 512 * 1024, 16);
    const [, pin] = op(leader, GroupOp.PIN, handle!);
    op(leader, GroupOp.ROUTE, pin!, 100 + round);
    op(leader, GroupOp.DETACH, handle!);
    // Small sends and a failed publication in the same round.
    const [, small] = op(leader, GroupOp.PIN, mailbox!);
    op(leader, GroupOp.ROUTE, small!, 100 + round);
    const [, aborted] = op(leader, GroupOp.PIN, mailbox!);
    op(leader, GroupOp.UNPIN, aborted!);
    worker.stopped();
    expect(baseline()).toEqual(before);
    if (round === 1) committed = groups.budget.committed;
    if (round > 1) expect(groups.budget.committed).toBe(committed);
  }
});
