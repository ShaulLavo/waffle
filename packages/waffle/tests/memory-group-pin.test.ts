import { expect, test } from "bun:test";
import { GroupOp, PAGE_BYTES } from "../group/protocol.js";
import { MemoryGroups, type MemberLease } from "../group/state.js";
import { SharedMemoryLedger, bytes, declareSharedMemoryPlatform } from "../memory/reservations.js";

function fixture(
  options: ConstructorParameters<typeof MemoryGroups>[0] = {},
  groups = new MemoryGroups(options),
) {
  const leases: MemberLease[] = [];
  const reserve = (pid: number, parent?: MemberLease) => {
    const lease = groups.admit(pid, "d", parent?.group ?? "new");
    leases.push(lease);
    return lease;
  };
  const join = (pid: number, parent?: MemberLease) => {
    const lease = reserve(pid, parent);
    lease.launch().request.port.close();
    return lease;
  };
  const owner = (lease: MemberLease) => groups.owner(lease.group)!;
  const op = (lease: MemberLease, code: number, a = 0, b = 0) =>
    owner(lease).request(lease, code, a, b);
  return {
    groups,
    reserve,
    join,
    owner,
    op,
    [Symbol.dispose]() {
      for (const lease of leases) lease.stopped();
    },
  };
}

test("a group pin survives its creator and a surviving member unpins it once", () => {
  using f = fixture();
  const a = f.join(1);
  const b = f.join(2, a);
  const [, handle, addr] = f.op(a, GroupOp.CREATE, PAGE_BYTES, PAGE_BYTES);
  const [, pin] = f.op(a, GroupOp.PIN, handle!);
  const bytes = new Uint8Array(a.group.buffer(), addr!, PAGE_BYTES);
  bytes[0] = 73;
  expect(f.op(a, GroupOp.DETACH, handle!)).toEqual([0]);
  const before = f.owner(a).snapshot();
  expect(f.op(a, GroupOp.ROUTE_GROUP, pin!)).toEqual([0]);
  expect(f.owner(a).snapshot()).toEqual(before);
  a.stopped();
  expect(f.owner(b).snapshot()).toMatchObject({ regions: 1, pins: 1, holds: 0 });
  expect(bytes[0]).toBe(73);
  expect(f.op(b, GroupOp.UNPIN, pin!)).toEqual([0]);
  expect(f.op(b, GroupOp.UNPIN, pin!)).toEqual([-8]);
  expect(f.op(b, GroupOp.ATTACH, handle!)).toEqual([-8]);
  expect(f.owner(b).snapshot()).toMatchObject({ regions: 0, pins: 0, holds: 0 });
  expect(f.op(b, GroupOp.CREATE, PAGE_BYTES, PAGE_BYTES)[2]).toBe(addr);
  expect(bytes[0]).toBe(0);
});

test("group conversion rejects unknown, foreign-owned, consumed and repeated pins without mutation", () => {
  using f = fixture();
  const a = f.join(1);
  const b = f.join(2, a);
  const [, handle] = f.op(a, GroupOp.CREATE, 32, 16);
  const [, pin] = f.op(a, GroupOp.PIN, handle!);
  const before = f.owner(a).snapshot();
  for (const id of [0, 100, 0xffffffff]) {
    expect(f.op(a, GroupOp.ROUTE_GROUP, id)).toEqual([-8]);
    expect(f.owner(a).snapshot()).toEqual(before);
  }
  expect(f.op(b, GroupOp.ROUTE_GROUP, pin!)).toEqual([-8]);
  expect(f.owner(a).snapshot()).toEqual(before);
  expect(f.op(a, GroupOp.ROUTE, pin!, b.pid)).toEqual([0]);
  expect(f.op(a, GroupOp.ROUTE_GROUP, pin!)).toEqual([-8]);
  expect(f.owner(a).snapshot()).toEqual(before);
  expect(f.op(b, GroupOp.ACCEPT, pin!)[0]).toBe(0);
  const accepted = f.owner(a).snapshot();
  expect(f.op(b, GroupOp.ROUTE_GROUP, pin!)).toEqual([-8]);
  expect(f.owner(a).snapshot()).toEqual(accepted);
  const [, groupPin] = f.op(a, GroupOp.PIN, handle!);
  expect(f.op(a, GroupOp.ROUTE_GROUP, groupPin!)).toEqual([0]);
  const converted = f.owner(a).snapshot();
  expect(f.op(a, GroupOp.ROUTE_GROUP, groupPin!)).toEqual([-8]);
  expect(f.op(b, GroupOp.ROUTE_GROUP, groupPin!)).toEqual([-8]);
  for (const pid of [b.pid, 999]) expect(f.op(a, GroupOp.ROUTE, groupPin!, pid)).toEqual([-8]);
  expect(f.op(a, GroupOp.ACCEPT, groupPin!)).toEqual([-8]);
  expect(f.op(b, GroupOp.ACCEPT, groupPin!)).toEqual([-8]);
  expect(f.owner(a).snapshot()).toEqual(converted);
  expect(f.op(a, GroupOp.UNPIN, groupPin!)).toEqual([0]);
  const unpinned = f.owner(a).snapshot();
  expect(f.op(a, GroupOp.ROUTE_GROUP, groupPin!)).toEqual([-8]);
  expect(f.owner(a).snapshot()).toEqual(unpinned);
});

test("group-local numeric pin ids never select another group's state, including collisions", () => {
  using f = fixture();
  const a = f.join(1);
  const foreign = f.join(2);
  const [, handle] = f.op(a, GroupOp.CREATE, 32, 16);
  const [, pin] = f.op(a, GroupOp.PIN, handle!);
  const untouched = f.owner(a).snapshot();
  expect(f.op(foreign, GroupOp.ROUTE_GROUP, pin!)).toEqual([-8]);
  expect(f.op(foreign, GroupOp.UNPIN, pin!)).toEqual([-8]);
  expect(f.owner(a).snapshot()).toEqual(untouched);
  const [, otherHandle] = f.op(foreign, GroupOp.CREATE, 32, 16);
  const [, otherPin] = f.op(foreign, GroupOp.PIN, otherHandle!);
  expect(otherPin).toBe(pin);
  expect(f.op(foreign, GroupOp.ROUTE_GROUP, pin!)).toEqual([0]);
  expect(f.op(foreign, GroupOp.UNPIN, pin!)).toEqual([0]);
  expect(f.owner(a).snapshot()).toEqual(untouched);
  expect(f.op(a, GroupOp.ROUTE_GROUP, pin!)).toEqual([0]);
  expect(f.op(foreign, GroupOp.UNPIN, pin!)).toEqual([-8]);
  expect(f.owner(a).snapshot()).toEqual(untouched);
  expect(f.op(a, GroupOp.UNPIN, pin!)).toEqual([0]);
});

test("conversion consumes no id or quota and preserves exhaustion refusal", () => {
  using f = fixture({ pins: 1 });
  const a = f.join(1);
  const b = f.join(2, a);
  const [, handle] = f.op(a, GroupOp.CREATE, 32, 16);
  Reflect.set(Reflect.get(f.owner(a), "pinIds"), "next", 0xfffffffe);
  const [, pin] = f.op(a, GroupOp.PIN, handle!);
  expect(pin).toBe(0xfffffffe);
  const before = f.owner(a).snapshot();
  const charged = f.groups.budget.committed;
  expect(f.op(a, GroupOp.ROUTE_GROUP, pin!)).toEqual([0]);
  expect(f.op(a, GroupOp.PIN, handle!)).toEqual([-6]);
  expect(f.owner(a).snapshot()).toEqual(before);
  expect(f.groups.budget.committed).toBe(charged);
  expect(f.op(b, GroupOp.UNPIN, pin!)).toEqual([0]);
  const [, last] = f.op(a, GroupOp.PIN, handle!);
  expect(last).toBe(0xffffffff);
  expect(f.op(a, GroupOp.ROUTE_GROUP, last!)).toEqual([0]);
  expect(f.op(b, GroupOp.UNPIN, last!)).toEqual([0]);
  const exhausted = f.owner(a).snapshot();
  expect(f.op(a, GroupOp.PIN, handle!)).toEqual([-6]);
  expect(f.op(a, GroupOp.ROUTE_GROUP, pin!)).toEqual([-8]);
  expect(f.owner(a).snapshot()).toEqual(exhausted);
  expect(f.groups.budget.committed).toBe(charged);
});

test("creator and member deaths preserve group pins through slot reuse and last reservation abort", () => {
  using f = fixture({ members: 3 });
  const a = f.join(1);
  const b = f.join(2, a);
  const pending = f.reserve(3, a);
  const [, handle] = f.op(a, GroupOp.CREATE, 32, 16);
  const [, pin] = f.op(a, GroupOp.PIN, handle!);
  expect(f.op(a, GroupOp.ROUTE_GROUP, pin!)).toEqual([0]);
  a.stopped();
  const replacement = f.join(4, b);
  expect(replacement.index).toBe(a.index);
  const before = f.owner(b).snapshot();
  expect(f.op(a, GroupOp.ROUTE_GROUP, pin!)).toEqual([-71]);
  expect(f.op(a, GroupOp.UNPIN, pin!)).toEqual([-71]);
  expect(f.op(pending, GroupOp.UNPIN, pin!)).toEqual([-71]);
  a.stopped();
  a.failed();
  a.abort();
  expect(f.owner(b).snapshot()).toEqual(before);
  b.stopped();
  replacement.stopped();
  expect(f.owner(pending).snapshot()).toMatchObject({ reserved: 1, pins: 1, regions: 1 });
  expect(f.groups.budget.committed).toBeGreaterThan(0);
  pending.abort();
  expect(f.owner(pending).snapshot()).toMatchObject({ pins: 0, regions: 0, holds: 0 });
  expect(f.groups.snapshot()).toEqual([]);
  expect(f.groups.budget.committed).toBe(0);
});

test("retained callers gain no authority, survivors may unpin, and retained debt delays group end", () => {
  using f = fixture();
  const a = f.join(1);
  const b = f.join(2, a);
  const [, handle] = f.op(a, GroupOp.CREATE, 32, 16);
  const [, staged] = f.op(a, GroupOp.PIN, handle!);
  const [, pin] = f.op(a, GroupOp.PIN, handle!);
  expect(f.op(a, GroupOp.ROUTE_GROUP, pin!)).toEqual([0]);
  a.failed();
  const before = f.owner(b).snapshot();
  expect(f.op(a, GroupOp.ROUTE_GROUP, staged!)).toEqual([-71]);
  expect(f.op(a, GroupOp.UNPIN, pin!)).toEqual([-71]);
  expect(f.op(b, GroupOp.ROUTE_GROUP, staged!)).toEqual([-8]);
  expect(f.op(b, GroupOp.UNPIN, staged!)).toEqual([-8]);
  expect(f.owner(b).snapshot()).toEqual(before);
  expect(f.op(b, GroupOp.UNPIN, pin!)).toEqual([0]);
  const [, last] = f.op(b, GroupOp.CREATE, 32, 16);
  const [, lastPin] = f.op(b, GroupOp.PIN, last!);
  expect(f.op(b, GroupOp.ROUTE_GROUP, lastPin!)).toEqual([0]);
  b.stopped();
  expect(f.owner(a).snapshot()).toMatchObject({ retained: 1, pins: 2, regions: 2 });
  expect(f.groups.budget.committed).toBeGreaterThan(0);
  a.stopped();
  expect(f.owner(a).snapshot()).toMatchObject({ retained: 0, pins: 0, regions: 0 });
  expect(f.groups.budget.committed).toBe(0);
});

test("member release before handover drops the staged pin", () => {
  using f = fixture();
  const a = f.join(1);
  const b = f.join(2, a);
  const [, handle] = f.op(a, GroupOp.CREATE, 32, 16);
  const [, pin] = f.op(a, GroupOp.PIN, handle!);
  a.stopped();
  expect(f.op(a, GroupOp.ROUTE_GROUP, pin!)).toEqual([-71]);
  expect(f.op(b, GroupOp.UNPIN, pin!)).toEqual([-8]);
  expect(f.owner(b).snapshot()).toMatchObject({ regions: 0, holds: 0, pins: 0 });
});

test("member routing still accepts reserved targets, which gain conversion authority only at launch", () => {
  using f = fixture();
  const a = f.join(1);
  const reserved = f.reserve(2, a);
  const [, handle] = f.op(a, GroupOp.CREATE, 32, 16);
  const [, pin] = f.op(a, GroupOp.PIN, handle!);
  expect(f.op(a, GroupOp.ROUTE, pin!, reserved.pid)).toEqual([0]);
  const before = f.owner(a).snapshot();
  expect(f.op(reserved, GroupOp.ROUTE_GROUP, pin!)).toEqual([-71]);
  expect(f.op(a, GroupOp.ROUTE_GROUP, pin!)).toEqual([-8]);
  expect(f.owner(a).snapshot()).toEqual(before);
  reserved.launch().request.port.close();
  expect(f.op(reserved, GroupOp.ROUTE_GROUP, pin!)).toEqual([0]);
  expect(f.op(a, GroupOp.UNPIN, pin!)).toEqual([0]);
});

test("unpin preserves independent publications and logical high water, not physical reservation return", () => {
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(16 * 1024 ** 2),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
  });
  const reservations = new SharedMemoryLedger(platform).openRuntime(platform);
  using f = fixture(
    {},
    new MemoryGroups({ maximumPages: 8 }, reservations.groups, reservations.sizing),
  );
  const a = f.join(1);
  const b = f.join(2, a);
  const [, handle] = f.op(a, GroupOp.CREATE, PAGE_BYTES, PAGE_BYTES);
  const owner = f.owner(a);
  const [status, token] = owner.request(a, GroupOp.PUBLISH, 1, handle!, 0, 0);
  expect(status).toBe(0);
  const [, pin] = f.op(a, GroupOp.PIN, handle!);
  expect(f.op(a, GroupOp.DETACH, handle!)).toEqual([0]);
  const before = owner.snapshot();
  const physical = reservations.snapshot();
  const charged = f.groups.budget.committed;
  expect(f.op(a, GroupOp.ROUTE_GROUP, pin!)).toEqual([0]);
  expect(owner.snapshot()).toEqual(before);
  expect(reservations.snapshot()).toEqual(physical);
  expect(f.op(b, GroupOp.UNPIN, pin!)).toEqual([0]);
  expect(owner.snapshot()).toMatchObject({
    regions: 1,
    published: 1,
    holds: 0,
    pins: 0,
    memberPages: 0,
  });
  expect(f.op(b, GroupOp.WITHDRAW, token!)).toEqual([-8]);
  expect(f.op(a, GroupOp.WITHDRAW, token!)).toEqual([0]);
  expect(owner.snapshot()).toMatchObject({
    regions: 0,
    freeBytes: PAGE_BYTES,
    committedBytes: before.committedBytes,
  });
  expect(f.groups.budget.committed).toBe(charged);
  expect(reservations.snapshot()).toEqual(physical);
  // Exposed backing stays reserved after W3 returns to zero; no GC receipt is asserted.
  a.group.buffer();
  a.stopped();
  b.stopped();
  expect(owner.snapshot().committedBytes).toBe(before.committedBytes);
  expect(f.groups.budget.committed).toBe(0);
  expect(reservations.snapshot().reservedBytes).toBeGreaterThan(0);
});
