import { expect, test } from "bun:test";
import { GroupOp, PAGE_BYTES } from "../group/protocol.js";
import { MemoryGroups } from "../group/state.js";

function worker() {
  const worker = new Worker(new URL("./fixtures/memory-group-abi-worker.ts", import.meta.url).href);
  const result = new Promise<unknown>((resolve, reject) => {
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = reject;
  });
  return { worker, result };
}

test("full-width group pin crosses the real port, survives creator stop and settles an unpin race", async () => {
  const groups = new MemoryGroups({ pins: 1 });
  const a = groups.admit(1, "d", "new");
  const b = groups.admit(2, "d", a.group);
  const c = groups.admit(3, "d", a.group);
  const owner = groups.owner(a.group)!;
  Reflect.set(Reflect.get(owner, "pinIds"), "next", 0xffffffff);
  const sender = worker();
  const first = worker();
  const second = worker();
  try {
    const launched = a.launch();
    sender.worker.postMessage({ request: launched.request, mode: "group-pin" }, launched.transfer);
    const report = await sender.result;
    expect(report).toMatchObject({
      created: 0,
      pinned: 0,
      detached: 0,
      pin: 0xffffffff,
      routed: 0,
      repeated: -8,
      route: -8,
      accept: -8,
    });
    await sender.worker.terminate();
    a.stopped();
    expect(owner.snapshot()).toMatchObject({ regions: 1, pins: 1, holds: 0 });
    const charged = groups.budget.committed;
    const gate = new SharedArrayBuffer(8);
    const controls = new Int32Array(gate);
    const one = b.launch();
    const two = c.launch();
    first.worker.postMessage(
      { request: one.request, mode: "unpin", pin: 0xffffffff, gate },
      one.transfer,
    );
    second.worker.postMessage(
      { request: two.request, mode: "unpin", pin: 0xffffffff, gate },
      two.transfer,
    );
    for (let attempt = 0; Atomics.load(controls, 0) !== 2 && attempt < 100; attempt++)
      await Bun.sleep(5);
    expect(Atomics.load(controls, 0)).toBe(2);
    Atomics.store(controls, 1, 1);
    Atomics.notify(controls, 1);
    expect(await Promise.all([first.result, second.result])).toEqual(
      expect.arrayContaining([0, -8]),
    );
    expect(owner.snapshot()).toMatchObject({
      regions: 0,
      pins: 0,
      holds: 0,
      freeBytes: PAGE_BYTES,
    });
    expect(groups.budget.committed).toBe(charged);
  } finally {
    await Promise.all([
      sender.worker.terminate(),
      first.worker.terminate(),
      second.worker.terminate(),
    ]);
    a.stopped();
    b.stopped();
    c.stopped();
  }
  expect(groups.budget.committed).toBe(0);
});

test("handover commits before its reply, so creator stop in that window leaves a group pin", async () => {
  const groups = new MemoryGroups();
  const a = groups.admit(1, "d", "new");
  const b = groups.admit(2, "d", a.group);
  b.launch().request.port.close();
  const owner = groups.owner(a.group)!;
  const dispatch: unknown = Reflect.get(owner, "dispatch");
  if (typeof dispatch !== "function") throw new Error("owner dispatch is missing");
  let committedBeforeReply = false;
  const launched = a.launch();
  // This raw-port model has no running Worker. It can release the creator synchronously
  // at the commit boundary without claiming that a live guest physically stopped.
  const [, handle, addr] = owner.request(a, GroupOp.CREATE, PAGE_BYTES, PAGE_BYTES);
  const [, pin] = owner.request(a, GroupOp.PIN, handle!);
  new DataView(a.group.buffer()).setUint32(addr!, pin!, true);
  expect(owner.request(a, GroupOp.DETACH, handle!)).toEqual([0]);
  Reflect.set(owner, "dispatch", function (...args: unknown[]) {
    const result: unknown = Reflect.apply(dispatch, owner, args);
    if (args[1] !== GroupOp.ROUTE_GROUP) return result;
    // answer() has not published this request's reply yet.
    expect(Atomics.load(new Int32Array(launched.request.reply), 0)).toBe(0);
    expect(owner.snapshot()).toMatchObject({ regions: 1, holds: 0, pins: 1 });
    a.stopped();
    committedBeforeReply = true;
    return result;
  });
  try {
    launched.request.port.postMessage({ seq: 1, op: GroupOp.ROUTE_GROUP, args: [pin!, 0, 0, 0] });
    // Wait for the owner commit, not an acknowledgment-dependent guest action.
    for (let attempt = 0; !committedBeforeReply && attempt < 100; attempt++) await Bun.sleep(5);
    expect(committedBeforeReply).toBe(true);
    const [, attached] = owner.request(b, GroupOp.ATTACH, handle!);
    expect(attached).toBe(addr);
    const id = new DataView(b.group.buffer()).getUint32(addr!, true);
    expect(owner.request(b, GroupOp.UNPIN, id)).toEqual([0]);
    expect(owner.request(b, GroupOp.DETACH, handle!)).toEqual([0]);
    expect(owner.snapshot()).toMatchObject({ regions: 0, pins: 0, holds: 0 });
  } finally {
    Reflect.set(owner, "dispatch", dispatch);
    launched.request.port.close();
    a.stopped();
    b.stopped();
  }
});

test("a retained or replaced incarnation's captured port cannot mutate its surviving group", async () => {
  const groups = new MemoryGroups();
  const a = groups.admit(1, "d", "new");
  const b = groups.admit(2, "d", a.group);
  b.launch().request.port.close();
  const launched = a.launch();
  const reply = new Int32Array(launched.request.reply);
  const owner = groups.owner(a.group)!;
  const [, handle] = owner.request(a, GroupOp.CREATE, 32, 16);
  const [, staged] = owner.request(a, GroupOp.PIN, handle!);
  const [, pin] = owner.request(a, GroupOp.PIN, handle!);
  expect(owner.request(a, GroupOp.ROUTE_GROUP, pin!)).toEqual([0]);
  try {
    a.failed();
    const before = owner.snapshot();
    launched.request.port.postMessage({
      seq: 50,
      op: GroupOp.ROUTE_GROUP,
      args: [staged, 0, 0, 0],
    });
    launched.request.port.postMessage({ seq: 51, op: GroupOp.UNPIN, args: [pin, 0, 0, 0] });
    await Bun.sleep(20);
    expect(Atomics.load(reply, 0)).toBe(0);
    expect(owner.snapshot()).toEqual(before);
    a.stopped();
    const replacement = groups.admit(1, "d", b.group);
    replacement.launch().request.port.close();
    try {
      expect(replacement.index).toBe(a.index);
      const replaced = owner.snapshot();
      launched.request.port.postMessage({ seq: 52, op: GroupOp.UNPIN, args: [pin, 0, 0, 0] });
      await Bun.sleep(20);
      expect(Atomics.load(reply, 0)).toBe(0);
      expect(owner.snapshot()).toEqual(replaced);
      expect(owner.request(replacement, GroupOp.UNPIN, pin!)).toEqual([0]);
    } finally {
      replacement.stopped();
    }
  } finally {
    launched.request.port.close();
    a.stopped();
    b.stopped();
  }
});
