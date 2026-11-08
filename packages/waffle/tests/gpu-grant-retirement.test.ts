import { afterEach, expect, spyOn, test } from "bun:test";
import { GpuService } from "../browser/gpu/service.js";
import { GpuScheduler, type GpuConnection } from "../browser/gpu/scheduler.js";
import { RecordRing } from "../browser/gpu/ring.js";
import type { GraphicsOpen } from "../browser/display/protocol.js";
import type { GpuServiceReply } from "../browser/display/service-protocol.js";
import {
  command,
  deferred,
  graphicsOpen as open,
  handle,
  ROOT,
  settle,
  words,
} from "./fixtures/gpu/core-fixture.js";
import { gpuObjectKinds } from "../browser/gpu/generated/tables.js";
import type { ServiceAccess } from "../browser/display/service-readers.js";
import { serviceAccess, serviceReaderOwner } from "./fixtures/gpu/service-access.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function write(open: GraphicsOpen, name: string, fields: unknown) {
  const writer = new RecordRing(open.commands, 8).tryAcquireWriter();
  if (writer.kind !== "acquired") throw new Error("writer missing");
  try {
    expect(writer.writer.tryWrite(command(name, fields)).kind).toBe("written");
  } finally {
    writer.writer.release();
  }
}
function taskService(root: object, access: ServiceAccess = serviceAccess()) {
  const tasks: (() => void)[] = [];
  const replies: GpuServiceReply[] = [];
  const connections: GpuConnection[] = [];
  const original = globalThis.MessageChannel;
  class Tasks extends original {
    constructor() {
      super();
      this.port2.postMessage = () => {
        tasks.push(() => this.port1.onmessage?.(new MessageEvent("message", { data: null })));
      };
    }
  }
  const add = GpuScheduler.prototype.add;
  const observer = spyOn(GpuScheduler.prototype, "add").mockImplementation(function (
    this: GpuScheduler,
    connection,
  ) {
    connections.push(connection);
    return add.call(this, connection);
  });
  cleanups.push(() => observer.mockRestore());
  let service: GpuService;
  globalThis.MessageChannel = Tasks;
  try {
    service = new GpuService((message) => replies.push(message), { root, access });
  } finally {
    globalThis.MessageChannel = original;
  }
  const turn = async () => {
    tasks.shift()?.();
    await settle();
  };
  cleanups.push(async () => {
    const disposal = service.dispose();
    for (let n = 0; n < 20 && tasks.length; n++) await turn();
    await Promise.resolve(disposal).catch(() => {});
    tasks.length = 0;
  });
  return { service, replies, connections, turn };
}

for (const cleanupFails of [false, true])
  test(`map-fill revoke joins the actual outer stack and separate ack task (${cleanupFails})`, async () => {
    const mapped = deferred<void>();
    const holder: { rig?: ReturnType<typeof taskService> } = {};
    const currentRig = () => {
      if (!holder.rig) throw new Error("service not created");
      return holder.rig;
    };
    let inside = false,
      destroyed = 0,
      ranges = 0,
      premature = false,
      cleanupInside = false;
    const nativeHistory: string[] = [];
    const buffer = {
      mapAsync() {
        return mapped.promise;
      },
      getMappedRange() {
        inside = true;
        ranges++;
        nativeHistory.push("range");
        currentRig().connections[0]!.completions.finishRetirement(5);
        currentRig().service.receive({ type: "revoke", grant: 1 });
        premature ||= currentRig().replies.some((reply) => reply.type === "retired");
        cleanupInside ||= destroyed > 0;
        // Even a reentrant task dispatch cannot clean up an admitted map-fill frame.
        void currentRig().turn();
        expect(destroyed).toBe(0);
        expect(currentRig().replies.some((reply) => reply.type === "retired")).toBe(false);
        inside = false;
        return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
      },
    };
    const device = {
      lost: new Promise(() => {}),
      addEventListener() {},
      removeEventListener() {},
      createBuffer() {
        return buffer;
      },
      destroy() {
        cleanupInside ||= inside;
        destroyed++;
        nativeHistory.push("destroy");
        currentRig().service.receive({ type: "revoke", grant: 1 });
        currentRig().service.receive({ type: "revoke", grant: 2 });
        expect(currentRig().replies.some((reply) => reply.type === "retired")).toBe(false);
        if (cleanupFails) throw new Error("owned cleanup failure");
      },
    };
    const rig = (holder.rig = taskService({
      requestAdapter: async () => ({ requestDevice: async () => device }),
    }));
    const original = open(),
      peer = open(2);
    currentRig().service.receive({ type: "open", grant: 1, open: original, surfaces: [] });
    currentRig().service.receive({ type: "open", grant: 2, open: peer, surfaces: [] });
    write(original, "instance.request_adapter", {
      receiver: ROOT,
      result: handle(2),
      token: 1,
      options: null,
    });
    await rig.turn();
    write(original, "adapter.request_device", {
      receiver: handle(2),
      result: handle(3),
      token: 2,
      descriptor: null,
    });
    await rig.turn();
    write(original, "device.create_buffer", {
      receiver: handle(3),
      result: handle(4),
      descriptor: { next_in_chain: [], label: "", usage: 1n, size: 8n, mapped_at_creation: false },
    });
    write(original, "buffer.map_async", {
      receiver: handle(4),
      token: 3,
      mode: 1,
      offset: 0n,
      size: 8n,
    });
    write(peer, "instance.request_adapter", {
      receiver: ROOT,
      result: handle(2),
      token: 1,
      options: null,
    });
    await rig.turn();
    expect(Atomics.load(new Int32Array(peer.commands), 2)).toBeGreaterThan(0);
    mapped.resolve();
    await settle();
    expect(ranges).toBe(1);
    expect(premature).toBe(false);
    expect(cleanupInside).toBe(false);
    expect(destroyed).toBe(0);
    expect(currentRig().replies.some((reply) => reply.type === "retired")).toBe(false);
    await rig.turn();
    expect(destroyed).toBe(1);
    expect(currentRig().replies.some((reply) => reply.type === "retired")).toBe(false);
    await rig.turn();
    expect(
      rig.replies.filter((reply) => reply.type === "retired" && reply.grant === 1),
    ).toHaveLength(cleanupFails ? 0 : 1);
    if (cleanupFails) expect(rig.service.snapshot().cleanupFailures).toBe(1);
    const frozen = [original.commands, original.replies, original.arena].map((backing) =>
      new Uint8Array(backing).slice(),
    );
    const history = nativeHistory.slice();
    for (const connection of rig.connections) {
      connection.slice();
      connection.replay.step();
      void connection.completions.state;
      void connection.completions.pendingCount;
      void connection.completions.payloadBytes;
      connection.completions.finishRetirement(5);
      connection.commands.readInto(new Uint8Array(4096));
    }
    await settle();
    [original.commands, original.replies, original.arena].forEach((backing, index) =>
      expect(Array.from(new Uint8Array(backing))).toEqual(Array.from(frozen[index]!)),
    );
    expect(nativeHistory).toEqual(history);
    expect(destroyed).toBe(1);
  });

test("reentrant open setup belongs to the original sealed grant before queued settlement", async () => {
  const rig = taskService({});
  const original = open();
  let entered = false;
  const canvas = {
    getContext() {
      entered = true;
      rig.service.receive({ type: "revoke", grant: 1 });
      void rig.turn();
      expect(rig.replies).toEqual([]);
      expect(Atomics.load(new Int32Array(original.control), 0)).toBe(0);
      return { transferFromImageBitmap() {} };
    },
  } as unknown as OffscreenCanvas;
  rig.service.receive({ type: "surface-register", id: 1 });
  rig.service.receive({ type: "open", grant: 1, open: original, surfaces: [{ id: 1, canvas }] });
  expect(entered).toBe(true);
  expect(rig.replies).toEqual([]);
  expect(rig.service.snapshot().connections).toBe(0);
  await rig.turn();
  expect(Atomics.load(new Int32Array(original.control), 0)).toBe(-64);
  expect(rig.replies).toEqual([]);
  await rig.turn();
  expect(rig.replies).toEqual([{ type: "retired", grant: 1 }]);
  const frozen = Array.from(new Uint8Array(original.commands));
  rig.service.receive({ type: "open", grant: 1, open: original, surfaces: [] });
  expect(Array.from(new Uint8Array(original.commands))).toEqual(frozen);
});

function writeBytes(open: GraphicsOpen, bytes: Uint8Array): void {
  const writer = new RecordRing(open.commands, 8).tryAcquireWriter();
  if (writer.kind !== "acquired") throw new Error("writer missing");
  try {
    expect(writer.writer.tryWrite(bytes).kind).toBe("written");
  } finally {
    writer.writer.release();
  }
}
async function turns(rig: ReturnType<typeof taskService>, count = 6): Promise<void> {
  for (let index = 0; index < count; index++) await rig.turn();
}
function failures(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(failures) : [error];
}
for (const mode of ["close", "revoke", "dispose"] as const) {
  test(`healthy real surface handle ${mode} does not stop its peer service`, async () => {
    const rig = taskService({ requestAdapter: async () => ({}) });
    const original = open(),
      peer = open(2);
    const canvas = {
      getContext: () => ({ transferFromImageBitmap() {} }),
    } as unknown as OffscreenCanvas;
    rig.service.receive({ type: "surface-register", id: 7 });
    rig.service.receive({ type: "open", grant: 1, open: original, surfaces: [{ id: 7, canvas }] });
    rig.service.receive({ type: "open", grant: 2, open: peer, surfaces: [] });
    write(original, "instance.create_surface", {
      receiver: ROOT,
      result: handle(7),
      descriptor: { next_in_chain: [{ sType: 4096, value: { surface_id: 7 } }], label: "surface" },
    });
    await rig.turn();
    expect(rig.service.snapshot().connections).toBe(2);
    const disposal = mode === "dispose" ? rig.service.dispose() : undefined;
    void disposal?.catch(() => {});
    if (mode === "close") rig.service.receive({ type: "close", grant: 1, id: 1 });
    if (mode === "revoke") rig.service.receive({ type: "revoke", grant: 1 });
    await turns(rig);
    expect(rig.service.snapshot().cleanupFailures).toBe(0);
    expect(rig.replies.some((reply) => reply.type === "retirement-failed")).toBe(false);
    expect(rig.replies).toContainEqual({ type: "closed", grant: 1, id: 1 });
    if (mode === "dispose") {
      await disposal;
      return;
    }
    if (mode === "close") {
      rig.service.receive({ type: "revoke", grant: 1 });
      await turns(rig);
    }
    expect(rig.replies).toContainEqual({ type: "retired", grant: 1 });
    const before = Atomics.load(new Int32Array(peer.commands), 2);
    write(peer, "instance.request_adapter", {
      receiver: ROOT,
      result: handle(2),
      token: 1,
      options: null,
    });
    await Bun.sleep(0);
    await turns(rig);
    expect(Atomics.load(new Int32Array(peer.commands), 2)).toBeGreaterThan(before);
    expect(rig.service.snapshot().connections).toBe(1);
    expect(rig.replies.some((reply) => reply.type === "retired" && reply.grant === 2)).toBe(false);
  });
}
const cleanupReasons = [
  undefined,
  null,
  false,
  0,
  "",
  new Error("original destruction failure"),
  { failed: true },
];
for (const mode of ["release", "retirement"] as const) {
  for (const reason of cleanupReasons) {
    test(`failed native device ${mode} retains original cleanup reason ${String(reason)}`, async () => {
      let attempts = 0;
      const device = {
        lost: new Promise(() => {}),
        addEventListener() {},
        removeEventListener() {},
        destroy() {
          attempts++;
          throw reason;
        },
      };
      const reader = serviceReaderOwner();
      const rig = taskService(
        { requestAdapter: async () => ({ requestDevice: async () => device }) },
        reader.access,
      );
      const original = open();
      rig.service.receive({ type: "open", grant: 1, open: original, surfaces: [] });
      write(original, "instance.request_adapter", {
        receiver: ROOT,
        result: handle(2),
        token: 1,
        options: null,
      });
      await turns(rig, 1);
      write(original, "adapter.request_device", {
        receiver: handle(2),
        result: handle(3),
        token: 2,
        descriptor: null,
      });
      await turns(rig, 1);
      if (mode === "release") {
        writeBytes(original, words(0x1000, [gpuObjectKinds.device, 3, 1]));
        await turns(rig, 1);
      }
      rig.service.receive({ type: "revoke", grant: 1 });
      await turns(rig);
      expect(attempts).toBe(1);
      expect(rig.replies.some((reply) => reply.type === "retirement-failed")).toBe(true);
      expect(rig.replies.some((reply) => reply.type === "retired" || reply.type === "closed")).toBe(
        false,
      );
      expect(rig.service.snapshot().connections).toBe(1);
      expect(rig.service.snapshot().cleanupFailures).toBe(1);
      if (reason === undefined) await reader.readers.close().join();
      const disposal = rig.service.dispose().then(
        () => ({ kind: "fulfilled" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      await turns(rig);
      const result = await disposal;
      expect(result.kind).toBe("rejected");
      if (result.kind !== "rejected") throw new Error("Lost native cleanup failure");
      expect(failures(result.error).some((error) => Object.is(error, reason))).toBe(true);
      await turns(rig);
      expect(rig.service.snapshot().connections).toBe(1);
      expect(attempts).toBe(1);
    });
  }
}

test("late first surface transfer remains available to a fresh grant after original retirement", async () => {
  const rig = taskService({});
  const original = open(),
    fresh = open(2);
  let attached = 0;
  const canvas = {
    getContext() {
      attached++;
      return { transferFromImageBitmap() {} };
    },
  } as unknown as OffscreenCanvas;
  rig.service.receive({ type: "surface-register", id: 1 });
  rig.service.receive({ type: "revoke", grant: 1 });
  await rig.turn();
  await rig.turn();
  expect(rig.replies).toEqual([{ type: "retired", grant: 1 }]);
  const buffers = [original.control, original.commands, original.replies, original.arena];
  const frozen = buffers.map((buffer) => Array.from(new Uint8Array(buffer)));
  rig.service.receive({ type: "open", grant: 1, open: original, surfaces: [{ id: 1, canvas }] });
  expect(rig.service.snapshot()).toMatchObject({ connections: 0, devicesLive: 0, heapBytes: 0 });
  rig.service.receive({ type: "open", grant: 2, open: fresh, surfaces: [{ id: 1 }] });
  expect(Atomics.load(new Int32Array(fresh.control), 0)).toBe(1);
  expect(attached).toBe(1);
  expect(rig.service.snapshot()).toMatchObject({ connections: 1, surfaces: 1 });
  expect(buffers.map((buffer) => Array.from(new Uint8Array(buffer)))).toEqual(frozen);
  expect(rig.replies.filter((reply) => reply.type === "retired" && reply.grant === 1)).toHaveLength(
    1,
  );
});
