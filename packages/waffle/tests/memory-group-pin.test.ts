import { expect, test } from "bun:test";
import { GroupOp, PAGE_BYTES } from "../group/protocol.js";
import { MemoryGroups, type MemberLease } from "../group/state.js";

function fixture(options: ConstructorParameters<typeof MemoryGroups>[0] = {}) {
  const groups = new MemoryGroups(options);
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
