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
  const op = (lease: MemberLease, code: number, a = 0, b = 0, c = 0, d = 0) =>
    groups.owner(lease.group)!.request(lease, code, a, b, c, d);
  const snapshot = (lease: MemberLease) => groups.owner(lease.group)!.snapshot();
  return { groups, join, op, snapshot };
}

const AGAIN = -6,
  BADF = -8,
  INVAL = -28;
const MEMORY = 1,
  MODULE = 2;

function publishing(options: ConstructorParameters<typeof MemoryGroups>[0] = {}) {
  const fixture = setup(options);
  const { op, snapshot } = fixture;
  // Freed chunks stay charged on the free list until the group ends, so compare live bytes.
  const counters = (lease: MemberLease) => {
    const { regions, holds, pins, published, committedBytes, freeBytes } = snapshot(lease);
    return { regions, holds, pins, published, liveBytes: committedBytes - freeBytes };
  };
  const createMemory = (lease: MemberLease, maximum = 1) => {
    const [, data, base] = op(lease, GroupOp.CREATE, Math.max(maximum, 1) * PAGE_BYTES, PAGE_BYTES);
    const [, cell, cellAddress] = op(lease, GroupOp.CREATE, 16, 16);
    return { data: data!, base: base!, cell: cell!, cellAddress: cellAddress! };
  };
  const publishMemory = (lease: MemberLease, maximum = 1) => {
    const memory = createMemory(lease, maximum);
    const [status, token] = op(lease, GroupOp.PUBLISH, MEMORY, memory.data, memory.cell, maximum);
    expect(status).toBe(0);
    return { ...memory, token: token! };
  };
  return { ...fixture, counters, createMemory, publishMemory };
}

/** Moves a private identity counter close to a boundary without allocating billions of ids. */
function setCounter(owner: object, name: string, next: number): void {
  Reflect.set(Reflect.get(owner, name), "next", next);
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

test("handle exhaustion refuses before any byte or slot is charged, and never wraps", () => {
  const { groups, join, op, counters } = publishing();
  const member = join(1);
  const owner = groups.owner(member.group)!;
  const [, first] = op(member, GroupOp.CREATE, 32, 16);
  setCounter(owner, "handles", 0xffffffff);
  expect(op(member, GroupOp.CREATE, 32, 16)[1]).toBe(0xffffffff);
  const before = counters(member);
  const charged = groups.budget.committed;
  expect(op(member, GroupOp.CREATE, 4 * PAGE_BYTES, PAGE_BYTES)[0]).toBe(AGAIN);
  expect(counters(member)).toEqual(before);
  expect(groups.budget.committed).toBe(charged);
  expect(op(member, GroupOp.ATTACH, first!)[0]).toBe(0);
});

test("pin exhaustion refuses without a metadata slot", () => {
  const { groups, join, op, counters } = publishing();
  const member = join(1);
  const [, handle] = op(member, GroupOp.CREATE, 32, 16);
  setCounter(groups.owner(member.group)!, "pinIds", 0x100000000);
  const before = counters(member);
  expect(op(member, GroupOp.PIN, handle!)[0]).toBe(AGAIN);
  expect(counters(member)).toEqual(before);
});

test("a publication token is a separate identity from its regions' handles", () => {
  const { groups, join, op, publishMemory } = publishing();
  const a = join(1),
    b = join(2, a);
  setCounter(groups, "tokens", 7000);
  const published = publishMemory(a);
  expect(published.token).toBe(7000);
  expect(op(b, GroupOp.OPEN, published.data, MEMORY)[0]).toBe(BADF);
  expect(op(b, GroupOp.ATTACH, published.token)[0]).toBe(BADF);
});

test("withdraw then republish mints a fresh token and the old one stays stale", () => {
  const { join, op, publishMemory } = publishing();
  const a = join(1),
    b = join(2, a);
  const first = publishMemory(a);
  expect(op(a, GroupOp.WITHDRAW, first.token)[0]).toBe(0);
  const [status, second] = op(a, GroupOp.PUBLISH, MEMORY, first.data, first.cell, 1);
  expect(status).toBe(0);
  expect(second).toBeGreaterThan(first.token);
  expect(op(b, GroupOp.OPEN, first.token, MEMORY)[0]).toBe(BADF);
  expect(op(a, GroupOp.WITHDRAW, first.token)[0]).toBe(BADF);
});

test("a wrong kind takes no hold, and the owner decides kind before any byte is read", () => {
  const { join, op, counters, publishMemory } = publishing();
  const a = join(1),
    b = join(2, a);
  const published = publishMemory(a);
  const before = counters(a);
  expect(op(b, GroupOp.OPEN, published.token, MODULE)[0]).toBe(BADF);
  expect(counters(a)).toEqual(before);
});

test("tokens above the signed boundary work, and exhaustion refuses before any reference", () => {
  const { groups, join, op, counters, createMemory, publishMemory } = publishing();
  const a = join(1),
    b = join(2, a);
  for (const value of [0x7fffffff, 0x80000000, 0xffffffff]) {
    setCounter(groups, "tokens", value);
    const published = publishMemory(a);
    expect(published.token).toBe(value);
    expect(op(b, GroupOp.OPEN, published.token, MEMORY)[0]).toBe(0);
  }
  const memory = createMemory(a);
  const before = counters(a);
  expect(op(a, GroupOp.PUBLISH, MEMORY, memory.data, memory.cell, 1)[0]).toBe(AGAIN);
  expect(counters(a)).toEqual(before);
});

test("a token from another group on this page names nothing", () => {
  const { join, op, publishMemory } = publishing();
  const left = join(1),
    right = join(2);
  const published = publishMemory(left);
  publishMemory(right);
  expect(op(right, GroupOp.OPEN, published.token, MEMORY)[0]).toBe(BADF);
  expect(op(right, GroupOp.WITHDRAW, published.token)[0]).toBe(BADF);
});

test("a refused publish changes no reference", () => {
  const { join, op, counters, createMemory } = publishing();
  const sender = join(1),
    other = join(2, sender);
  const { data, cell } = createMemory(sender);
  const before = counters(sender);
  expect(op(sender, GroupOp.PUBLISH, 0, data, cell, 1)[0]).toBe(INVAL);
  expect(op(sender, GroupOp.PUBLISH, MEMORY, data, data, 1)[0]).toBe(INVAL);
  expect(op(sender, GroupOp.PUBLISH, MEMORY, data, 999999, 1)[0]).toBe(BADF);
  expect(op(sender, GroupOp.PUBLISH, MEMORY, 999999, cell, 1)[0]).toBe(BADF);
  expect(op(other, GroupOp.PUBLISH, MEMORY, data, cell, 1)[0]).toBe(BADF);
  expect(counters(sender)).toEqual(before);
});

test("duplicate publishes are distinct publications, each withdrawn once", () => {
  const { join, op, createMemory } = publishing();
  const sender = join(1),
    reader = join(2, sender);
  const { data, cell } = createMemory(sender);
  const first = op(sender, GroupOp.PUBLISH, MEMORY, data, cell, 1)[1]!;
  const second = op(sender, GroupOp.PUBLISH, MEMORY, data, cell, 1)[1]!;
  expect(second).not.toBe(first);
  expect(op(sender, GroupOp.WITHDRAW, first)[0]).toBe(0);
  expect(op(sender, GroupOp.WITHDRAW, first)[0]).toBe(BADF);
  expect(op(reader, GroupOp.OPEN, second, MEMORY)[0]).toBe(0);
  expect(op(sender, GroupOp.WITHDRAW, second)[0]).toBe(0);
});

test("only the publishing incarnation may withdraw, even from its reused slot", () => {
  const { join, op, counters, publishMemory } = publishing({ members: 2 });
  const survivor = join(1),
    sender = join(2, survivor);
  const published = publishMemory(sender);
  const before = counters(survivor);
  expect(op(survivor, GroupOp.WITHDRAW, published.token)[0]).toBe(BADF);
  sender.stopped();
  const replacement = join(3, survivor);
  expect(replacement.index).toBe(sender.index);
  expect(op(replacement, GroupOp.WITHDRAW, published.token)[0]).toBe(BADF);
  expect(counters(survivor)).toEqual({ ...before, holds: before.holds - 2 });
});

test("open takes every hold in one step and reports the owner's exact extents", () => {
  const { join, op, counters, publishMemory } = publishing();
  const sender = join(1),
    reader = join(2, sender);
  const published = publishMemory(sender, 3);
  const before = counters(sender);
  expect(op(reader, GroupOp.OPEN, published.token, MEMORY)).toEqual([
    0,
    published.data,
    published.base,
    3 * PAGE_BYTES,
    published.cell,
    published.cellAddress,
    16,
    3,
  ]);
  expect(counters(sender).holds).toBe(before.holds + 2);
  expect(op(reader, GroupOp.DETACH, published.cell)[0]).toBe(0);
  expect(op(reader, GroupOp.DETACH, published.data)[0]).toBe(0);
  expect(counters(sender)).toEqual(before);
});

test("a module publication reports a zero companion and holds no extra region", () => {
  const { join, op, counters } = publishing();
  const sender = join(1),
    reader = join(2, sender);
  const before = counters(sender);
  const [, region, addr] = op(sender, GroupOp.CREATE, 64, 16);
  const [, token] = op(sender, GroupOp.PUBLISH, MODULE, region!, 0, 8);
  expect(op(sender, GroupOp.DETACH, region!)[0]).toBe(0);
  expect(counters(sender).holds).toBe(before.holds);
  expect(counters(sender).published).toBe(before.published + 1);
  expect(op(reader, GroupOp.OPEN, token!, MODULE)).toEqual([0, region!, addr!, 64, 0, 0, 0, 8]);
  expect(op(reader, GroupOp.DETACH, region!)[0]).toBe(0);
  expect(op(sender, GroupOp.WITHDRAW, token!)[0]).toBe(0);
  expect(counters(sender)).toEqual(before);
});

test("the publication limit counts publications and refuses before any change", () => {
  const { join, op, counters, createMemory, publishMemory, groups } = publishing({
    publications: 2,
  });
  expect(groups.policy.publications).toBe(2);
  expect(new MemoryGroups().policy).toMatchObject({ publications: 4096, regions: 4096 });
  const member = join(1);
  publishMemory(member);
  publishMemory(member);
  const memory = createMemory(member);
  const before = counters(member);
  expect(op(member, GroupOp.PUBLISH, MEMORY, memory.data, memory.cell, 1)[0]).toBe(AGAIN);
  expect(counters(member)).toEqual(before);
});

test("a Memory uses two regions, so the region limit caps Memories at half", () => {
  const { join, op, publishMemory } = publishing({ regions: 4 });
  const member = join(1);
  publishMemory(member);
  publishMemory(member);
  expect(op(member, GroupOp.CREATE, 16, 16)[0]).toBe(AGAIN);
});

test("a published region survives its last hold, then frees and zeroes after withdrawal", () => {
  const { join, op, snapshot, publishMemory } = publishing();
  const a = join(1);
  const published = publishMemory(a);
  for (const address of [published.base, published.cellAddress])
    new Int32Array(a.group.buffer(), address, 4)[1] = 9;
  expect(op(a, GroupOp.DETACH, published.cell)[0]).toBe(0);
  expect(op(a, GroupOp.DETACH, published.data)[0]).toBe(0);
  expect(snapshot(a)).toMatchObject({ regions: 2, holds: 0, published: 1 });
  expect(op(a, GroupOp.WITHDRAW, published.token)[0]).toBe(0);
  expect(snapshot(a)).toMatchObject({ regions: 0, holds: 0, published: 0 });
  const [, , again] = op(a, GroupOp.CREATE, 16, 16);
  expect([published.base, published.cellAddress]).toContain(again!);
  expect(new Int32Array(a.group.buffer(), again!, 4)[1]).toBe(0);
});

test("a member's stop before publishing reclaims all its staging", () => {
  const { join, counters, createMemory } = publishing();
  const survivor = join(1),
    stopping = join(2, survivor);
  const before = counters(survivor);
  createMemory(stopping);
  expect(counters(survivor).regions).toBe(before.regions + 2);
  stopping.stopped();
  expect(counters(survivor)).toEqual(before);
});

test("a publisher's stop leaves a complete, attachable publication", () => {
  const { join, op, snapshot, publishMemory } = publishing();
  const survivor = join(1),
    stopping = join(2, survivor);
  const published = publishMemory(stopping);
  stopping.stopped();
  expect(snapshot(survivor)).toMatchObject({ regions: 2, holds: 0, published: 1 });
  expect(op(survivor, GroupOp.OPEN, published.token, MEMORY)[0]).toBe(0);
  expect(op(survivor, GroupOp.DETACH, published.cell)[0]).toBe(0);
  expect(op(survivor, GroupOp.DETACH, published.data)[0]).toBe(0);
  expect(op(survivor, GroupOp.WITHDRAW, published.token)[0]).toBe(BADF);
  expect(snapshot(survivor)).toMatchObject({ regions: 2, published: 1 });
});

test("a stopped opener's holds return at its physical stop", () => {
  const { join, op, counters, publishMemory } = publishing();
  const sender = join(1),
    opener = join(2, sender);
  const published = publishMemory(sender);
  const before = counters(sender);
  expect(op(opener, GroupOp.OPEN, published.token, MEMORY)[0]).toBe(0);
  expect(counters(sender).holds).toBe(before.holds + 2);
  opener.stopped();
  expect(counters(sender)).toEqual(before);
});

test("the retained ended owner holds nothing, and repeated stops change nothing", () => {
  const { groups, join, op, publishMemory } = publishing();
  const first = join(1),
    second = join(2, first);
  const owner = groups.owner(first.group)!;
  const published = publishMemory(first);
  op(second, GroupOp.CREATE, 32, 16);
  op(second, GroupOp.OPEN, published.token, MEMORY);
  second.stopped();
  first.stopped();
  const ended = owner.snapshot();
  expect([ended.regions, ended.holds, ended.pins, ended.watches, ended.published]).toEqual([
    0, 0, 0, 0, 0,
  ]);
  expect(groups.snapshot()).toEqual([]);
  expect(groups.budget.committed).toBe(0);
  first.stopped();
  second.stopped();
  expect(groups.budget.committed).toBe(0);
  expect(owner.snapshot().published).toBe(0);
  // Arena metadata is retired too, so the ended owner keeps no page references.
  expect(Reflect.get(owner, "arenas")).toEqual([]);
});

test("a failed stop keeps publications and budget charged until it settles", () => {
  const { groups, join, publishMemory } = publishing();
  const a = join(1),
    b = join(2, a);
  publishMemory(a);
  const owner = groups.owner(a.group)!;
  a.stopped();
  const charge = groups.budget.committed;
  b.failed();
  expect(owner.snapshot()).toMatchObject({ published: 1, retained: 1 });
  expect(groups.budget.committed).toBe(charge);
  expect(groups.snapshot()).toHaveLength(1);
  b.stopped();
  expect(owner.snapshot()).toMatchObject({ published: 0, regions: 0 });
  expect(groups.budget.committed).toBe(0);
});
