import { afterEach, expect, spyOn, test } from "bun:test";
import { GroupOp, PAGE_BYTES } from "../group/protocol.js";
import { MemoryGroups, type MemberLease, type MemoryGroupPolicyOptions } from "../group/state.js";
import { SharedMemoryLedger, bytes, declareSharedMemoryPlatform } from "../memory/reservations.js";

const leases = new Set<MemberLease>();
afterEach(() => {
  for (const lease of leases) lease.stopped();
  leases.clear();
});

function setup(options: MemoryGroupPolicyOptions = {}, groups = new MemoryGroups(options)) {
  const join = (pid: number, parent?: MemberLease) => {
    const lease = groups.admit(pid, "member-cap", parent?.group ?? "new");
    leases.add(lease);
    lease.launch().request.port.close();
    return lease;
  };
  const op = (lease: MemberLease, code: number, a = 0, b = 0) =>
    groups.owner(lease.group)!.request(lease, code, a, b);
  const snapshot = (lease: MemberLease) => groups.owner(lease.group)!.snapshot();
  return { groups, join, op, snapshot };
}

test("memberPages normalizes from the configured maximum and validates explicit caps", () => {
  expect(new MemoryGroups().policy.memberPages).toBe(65536);
  for (const maximumPages of [8, 32768]) {
    const groups = new MemoryGroups({ maximumPages });
    expect(groups.policy.memberPages).toBe(maximumPages);
    expect(groups.policy.budgetBytes).toBe(2 * 1024 ** 3);
    expect(Object.isFrozen(groups.policy)).toBe(true);
  }
  expect(new MemoryGroups({ maximumPages: 8, memberPages: undefined }).policy.memberPages).toBe(8);
  expect(new MemoryGroups({ maximumPages: 8, memberPages: 8 }).policy.memberPages).toBe(8);
  for (const memberPages of [0, -1, 1.5, NaN, Infinity, 9])
    expect(() => new MemoryGroups({ maximumPages: 8, memberPages })).toThrow(RangeError);
  expect(() => new MemoryGroups({ maximumPages: 0 })).toThrow(RangeError);
  expect(() => new MemoryGroups({ stackBytes: 17 })).toThrow(RangeError);
});

test("two members jointly reach their cap; refusal preserves ownership and free holes", () => {
  const { groups, join, op, snapshot } = setup({ maximumPages: 32, memberPages: 6 });
  const a = join(1),
    b = join(2, a);
  expect(op(a, GroupOp.GROW, 2)).toEqual([1]);
  expect(op(b, GroupOp.GROW, 4)).toEqual([3]);
  const [, region] = op(a, GroupOp.CREATE, 2 * PAGE_BYTES, PAGE_BYTES);
  op(a, GroupOp.DETACH, region!);
  const before = snapshot(a);
  const committed = groups.budget.committed;
  expect(before.memberPages).toBe(6);
  expect(op(a, GroupOp.GROW, 1)).toEqual([-48]);
  expect(snapshot(a)).toEqual(before);
  expect(groups.budget.committed).toBe(committed);
  b.stopped();
  b.stopped();
  expect(snapshot(a).memberPages).toBe(2);
  const c = join(3, a);
  expect(op(c, GroupOp.GROW, 4)).toEqual([3]);
  expect(snapshot(a).memberPages).toBe(6);
  expect(groups.budget.committed).toBe(committed);
});

test("failed tail placement leaves the cap available for a smaller successful chunk", () => {
  const { groups, join, op, snapshot } = setup({ maximumPages: 8, memberPages: 8 });
  const a = join(1),
    b = join(2, a);
  expect(op(a, GroupOp.GROW, 3)).toEqual([1]);
  const before = snapshot(a);
  const committed = groups.budget.committed;
  expect(op(b, GroupOp.GROW, 5)).toEqual([-48]);
  expect(snapshot(a)).toEqual(before);
  expect(groups.budget.committed).toBe(committed);
  expect(op(b, GroupOp.GROW, 4)).toEqual([4]);
  expect(snapshot(a).memberPages).toBe(7);
});

test("a native growth refusal returns the backing charge without consuming the member cap", () => {
  const { groups, join, op, snapshot } = setup({ maximumPages: 16, memberPages: 4 });
  const a = join(1);
  const before = snapshot(a);
  const grow = spyOn(WebAssembly.Memory.prototype, "grow").mockImplementationOnce(() => {
    throw new RangeError("injected native growth refusal");
  });
  try {
    expect(op(a, GroupOp.GROW, 2)).toEqual([-48]);
  } finally {
    grow.mockRestore();
  }
  expect(snapshot(a)).toEqual(before);
  expect(groups.budget.committed).toBe(PAGE_BYTES);
  expect(op(a, GroupOp.GROW, 4)).toEqual([1]);
  expect(snapshot(a).memberPages).toBe(4);
});

test("failed physical stop and cancellation retain the member's charge until actual stop", () => {
  const { groups, join, op, snapshot } = setup({ maximumPages: 16, memberPages: 4 });
  const a = join(1),
    b = join(2, a);
  expect(op(b, GroupOp.GROW, 4)).toEqual([1]);
  b.failed();
  b.abort();
  expect(snapshot(a)).toMatchObject({ memberPages: 4, retained: 1, freeBytes: 0 });
  expect(op(a, GroupOp.GROW, 1)).toEqual([-48]);
  const reserved = groups.admit(3, "member-cap", a.group);
  reserved.abort();
  expect(snapshot(a).memberPages).toBe(4);
  b.stopped();
  expect(snapshot(a)).toMatchObject({ memberPages: 0, retained: 0 });
  expect(op(a, GroupOp.GROW, 4)).toEqual([1]);
});

test("shared regions and their arenas consume backing but no member pages", () => {
  const { groups, join, op, snapshot } = setup({ maximumPages: 16, memberPages: 2 });
  const a = join(1);
  expect(op(a, GroupOp.CREATE, 4 * PAGE_BYTES, PAGE_BYTES)[0]).toBe(0);
  expect(op(a, GroupOp.CREATE, 16, 16)[0]).toBe(0);
  expect(snapshot(a)).toMatchObject({ memberPages: 0, committedBytes: 6 * PAGE_BYTES });
  expect(op(a, GroupOp.GROW, 2)).toEqual([6]);
  expect(op(a, GroupOp.GROW, 1)).toEqual([-48]);
  expect(op(a, GroupOp.CREATE, PAGE_BYTES, PAGE_BYTES)[0]).toBe(0);
  expect(snapshot(a).memberPages).toBe(2);
  expect(groups.budget.committed).toBe(9 * PAGE_BYTES);
});

test("dirty large region holes are cleared across the full recycled pages", () => {
  const { join, op } = setup();
  const a = join(1);
  const [, handle, addr] = op(a, GroupOp.CREATE, 2 * PAGE_BYTES, PAGE_BYTES);
  new Uint8Array(a.group.buffer(), addr!, 2 * PAGE_BYTES).fill(91);
  expect(op(a, GroupOp.DETACH, handle!)).toEqual([0]);
  const [, , again] = op(a, GroupOp.CREATE, PAGE_BYTES + 1, PAGE_BYTES);
  expect(again).toBe(addr!);
  expect(new Uint8Array(a.group.buffer(), again!, 2 * PAGE_BYTES).every((byte) => byte === 0)).toBe(
    true,
  );
});

test("a dirty member chunk reused as a large region is cleared", () => {
  const { join, op } = setup();
  const a = join(1),
    b = join(2, a);
  const [page] = op(b, GroupOp.GROW, 2);
  new Uint8Array(a.group.buffer(), page! * PAGE_BYTES, 2 * PAGE_BYTES).fill(93);
  b.stopped();
  const [, , addr] = op(a, GroupOp.CREATE, 2 * PAGE_BYTES, PAGE_BYTES);
  expect(addr).toBe(page! * PAGE_BYTES);
  expect(new Uint8Array(a.group.buffer(), addr!, 2 * PAGE_BYTES).every((byte) => byte === 0)).toBe(
    true,
  );
});

test("dirty suballocations in a live small arena are cleared without clearing their neighbor", () => {
  const { join, op } = setup();
  const a = join(1);
  const [, first, addr] = op(a, GroupOp.CREATE, 32, 16);
  const [, , neighbor] = op(a, GroupOp.CREATE, 32, 16);
  new Uint8Array(a.group.buffer(), addr!, 32).fill(94);
  new Uint8Array(a.group.buffer(), neighbor!, 32).fill(95);
  op(a, GroupOp.DETACH, first!);
  const [, , again] = op(a, GroupOp.CREATE, 32, 16);
  expect(again).toBe(addr!);
  expect(new Uint8Array(a.group.buffer(), again!, 32).every((byte) => byte === 0)).toBe(true);
  expect(new Uint8Array(a.group.buffer(), neighbor!, 32).every((byte) => byte === 95)).toBe(true);
});

test("logical region growth clears dirty fixed backing, including page padding", () => {
  const platform = declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(16 * 1024 ** 2),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
  });
  const reservations = new SharedMemoryLedger(platform).openRuntime(platform);
  const groups = new MemoryGroups({ maximumPages: 8 }, reservations.groups, reservations.sizing);
  const { join, op } = setup({}, groups);
  const a = join(1);
  new Uint8Array(a.group.buffer(), PAGE_BYTES, 2 * PAGE_BYTES).fill(96);
  const [, , addr] = op(a, GroupOp.CREATE, PAGE_BYTES + 1, PAGE_BYTES);
  expect(addr).toBe(PAGE_BYTES);
  expect(new Uint8Array(a.group.buffer(), addr!, 2 * PAGE_BYTES).every((byte) => byte === 0)).toBe(
    true,
  );
});

test("fresh large-region growth does not clear the reserved span", () => {
  const { join, op } = setup();
  const a = join(1);
  const fill = spyOn(Uint8Array.prototype, "fill");
  let result: number[];
  try {
    result = op(a, GroupOp.CREATE, 512 * PAGE_BYTES, PAGE_BYTES);
    expect(fill).not.toHaveBeenCalled();
  } finally {
    fill.mockRestore();
  }
  expect(result[0]).toBe(0);
  const view = new Uint8Array(a.group.buffer(), result[2]!, 512 * PAGE_BYTES);
  expect(view[0]).toBe(0);
  expect(view[view.length - 1]).toBe(0);
});
