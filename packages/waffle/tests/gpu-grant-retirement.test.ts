import { afterEach, expect, spyOn, test } from "bun:test";
import { GpuService } from "../browser/gpu/service.js";
import { GpuScheduler, type GpuConnection } from "../browser/gpu/scheduler.js";
import { RecordRing } from "../browser/gpu/ring.js";
import { gpuPayloadLayout } from "../browser/display/generated/graphics-layout.js";
import type { GraphicsOpen } from "../browser/display/protocol.js";
import type { GpuServiceReply } from "../browser/display/service-protocol.js";
import { command, deferred, handle, ROOT, settle } from "./fixtures/gpu/core-fixture.js";
import { serviceAccess } from "./fixtures/gpu/service-access.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
function open(id = 1): GraphicsOpen {
  return { type: "open", id, control: new SharedArrayBuffer(64), commands: new SharedArrayBuffer(4160), replies: new SharedArrayBuffer(4160), arena: new SharedArrayBuffer(gpuPayloadLayout.byteLength) };
}
function write(open: GraphicsOpen, name: string, fields: unknown) {
  const writer = new RecordRing(open.commands, 8).tryAcquireWriter();
  if (writer.kind !== "acquired") throw new Error("writer missing");
  try { expect(writer.writer.tryWrite(command(name, fields)).kind).toBe("written"); }
  finally { writer.writer.release(); }
}
function taskService(root: object) {
  const tasks: (() => void)[] = [];
  const replies: GpuServiceReply[] = [];
  const connections: GpuConnection[] = [];
  const original = globalThis.MessageChannel;
  class Tasks extends original {
    constructor() {
      super();
      this.port2.postMessage = () => { tasks.push(() => this.port1.onmessage?.(new MessageEvent("message", { data: null }))); };
    }
  }
  const add = GpuScheduler.prototype.add;
  const observer = spyOn(GpuScheduler.prototype, "add").mockImplementation(function (connection) {
    connections.push(connection); return add.call(this, connection);
  });
  cleanups.push(() => observer.mockRestore());
  let service: GpuService;
  globalThis.MessageChannel = Tasks;
  try { service = new GpuService((message) => replies.push(message), { root, access: serviceAccess() }); }
  finally { globalThis.MessageChannel = original; }
  const turn = async () => { tasks.shift()?.(); await settle(); };
  cleanups.push(async () => {
    const disposal = service.dispose();
    for (let n = 0; n < 20 && tasks.length; n++) await turn();
    await Promise.resolve(disposal).catch(() => {});
    tasks.length = 0;
  });
  return { service, replies, connections, turn };
}

for (const cleanupFails of [false, true]) test(`map-fill revoke joins the actual outer stack and separate ack task (${cleanupFails})`, async () => {
  const mapped = deferred<void>();
  let rig!: ReturnType<typeof taskService>;
  let inside = false, destroyed = 0, ranges = 0, premature = false, cleanupInside = false;
  const nativeHistory: string[] = [];
  const buffer = {
    mapAsync() { return mapped.promise; },
    getMappedRange() {
      inside = true;
      ranges++;
      nativeHistory.push("range");
      rig.service.receive({ type: "revoke", grant: 1 });
      premature ||= rig.replies.some((reply) => reply.type === "retired");
      cleanupInside ||= destroyed > 0;
      // Even a reentrant task dispatch cannot clean up an admitted map-fill frame.
      void rig.turn();
      expect(destroyed).toBe(0);
      expect(rig.replies.some((reply) => reply.type === "retired")).toBe(false);
      inside = false;
      return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    },
  };
  const device = {
    lost: new Promise(() => {}), addEventListener() {}, removeEventListener() {},
    createBuffer() { return buffer; },
    destroy() {
      cleanupInside ||= inside;
      destroyed++;
      nativeHistory.push("destroy");
      rig.service.receive({ type: "revoke", grant: 1 });
      rig.service.receive({ type: "revoke", grant: 2 });
      expect(rig.replies.some((reply) => reply.type === "retired")).toBe(false);
      if (cleanupFails) throw new Error("owned cleanup failure");
    },
  };
  rig = taskService({ requestAdapter: async () => ({ requestDevice: async () => device }) });
  const original = open(), peer = open(2);
  rig.service.receive({ type: "open", grant: 1, open: original, surfaces: [] });
  rig.service.receive({ type: "open", grant: 2, open: peer, surfaces: [] });
  write(original, "instance.request_adapter", { receiver: ROOT, result: handle(2), token: 1, options: null });
  await rig.turn();
  write(original, "adapter.request_device", { receiver: handle(2), result: handle(3), token: 2, descriptor: null });
  await rig.turn();
  write(original, "device.create_buffer", { receiver: handle(3), result: handle(4), descriptor: { next_in_chain: [], label: "", usage: 1n, size: 8n, mapped_at_creation: false } });
  write(original, "buffer.map_async", { receiver: handle(4), token: 3, mode: 1, offset: 0n, size: 8n });
  write(peer, "instance.request_adapter", { receiver: ROOT, result: handle(2), token: 1, options: null });
  await rig.turn();
  expect(Atomics.load(new Int32Array(peer.commands), 2)).toBeGreaterThan(0);
  mapped.resolve();
  await settle();
  expect(ranges).toBe(1);
  expect(premature).toBe(false);
  expect(cleanupInside).toBe(false);
  expect(destroyed).toBe(0);
  expect(rig.replies.some((reply) => reply.type === "retired")).toBe(false);
  await rig.turn();
  expect(destroyed).toBe(1);
  expect(rig.replies.some((reply) => reply.type === "retired")).toBe(false);
  await rig.turn();
  expect(rig.replies.filter((reply) => reply.type === "retired" && reply.grant === 1)).toHaveLength(cleanupFails ? 0 : 1);
  if (cleanupFails) expect(rig.service.snapshot().cleanupFailures).toBe(1);
  const frozen = [original.commands, original.replies, original.arena].map((backing) => new Uint8Array(backing).slice());
  const history = nativeHistory.slice();
  for (const connection of rig.connections) {
    connection.slice();
    connection.replay.step();
    connection.completions.state;
    connection.completions.pendingCount;
    connection.completions.payloadBytes;
    connection.commands.readInto(new Uint8Array(4096));
  }
  await settle();
  [original.commands, original.replies, original.arena].forEach((backing, index) => expect(Array.from(new Uint8Array(backing))).toEqual(Array.from(frozen[index]!)));
  expect(nativeHistory).toEqual(history);
  expect(destroyed).toBe(1);
});
