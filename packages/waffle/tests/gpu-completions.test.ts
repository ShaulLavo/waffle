import { serviceAccess } from "./fixtures/gpu/service-access.js";
import { describe, expect, test } from "bun:test";
import expected from "./fixtures/gpu/expected.json";
import { completionBytes, type WireObject } from "../browser/gpu/codec.ts";
import { CompletionOwner } from "../browser/gpu/completions.ts";
import { gpuObjectKinds } from "../browser/gpu/generated/tables.ts";
import { RecordRing } from "../browser/gpu/ring.ts";
import { GPU_TERMINAL, ServiceCredit } from "../browser/gpu/protocol.ts";
import { LogicalAppend } from "../browser/gpu/transport.ts";
import { GpuConnection } from "../browser/gpu/scheduler.ts";
import {
  command,
  deferred,
  drain,
  handle,
  joinRecords,
  openDevice,
  RecordingTarget,
  rig,
  ring,
  ROOT,
  send,
  settle,
  words,
} from "./fixtures/gpu/core-fixture.ts";

describe("bounded completion and async ownership", () => {
  test("emits independent completion golden bytes from generated layouts", () => {
    for (const entry of expected.completions) {
      const value: WireObject = { status: entry.input.status };
      if (entry.input.texture) value.texture = entry.input.texture;
      if (entry.input.type) value.type = entry.input.type;
      if (typeof entry.input.message === "string") value.message = entry.input.message;
      expect(completionBytes(entry.completion, entry.token, entry.status, value, 4096)).toEqual(
        Uint8Array.from(Buffer.from(entry.hex.replaceAll(" ", ""), "hex")),
      );
    }
  });
  test("tiny full completion rings close only their connection without blocking a guest drain", async () => {
    const target = new RecordingTarget();
    const local = rig(target, 1024, 32);
    const other = rig(new RecordingTarget());
    try {
      await openDevice(local.connection);
      // The adapter reply fits. The unread device reply does not, so the OOB reason wins.
      expect(local.connection.state).toEqual({ kind: "terminal", reason: GPU_TERMINAL.resource });
      expect(local.replies.terminal()?.reason).toBe(GPU_TERMINAL.resource);
      expect(drain(local.replies)).toHaveLength(1);
      expect(other.connection.state.kind).toBe("ready");
      expect(local.credit.used).toBe(0);
    } finally {
      local.connection.close();
      other.connection.close();
    }
  });
  test("one append producing more immediate exception replies than fit terminates explicitly", () => {
    const local = rig(new RecordingTarget(), 1024, 64);
    try {
      const create = command("instance.create_surface", {
        result: handle(2),
        receiver: ROOT,
        descriptor: {
          next_in_chain: [{ sType: 4096, value: { surface_id: 42 } }],
          label: "",
        },
      });
      const records = [create];
      for (let id = 3; id < 20; id++) {
        const copy = create.slice();
        new DataView(copy.buffer).setUint32(8, id, true);
        records.push(copy);
      }
      expect(() => send(local.connection, joinRecords(...records))).not.toThrow();
      expect(local.connection.state).toEqual({ kind: "terminal", reason: GPU_TERMINAL.resource });
      expect(drain(local.replies).length).toBeLessThan(20);
    } finally {
      local.connection.close();
    }
    expect(local.credit.used).toBe(0);
  });
  test("pending admission is exactly 64, tokens strictly increase, and no operation starts after overflow", async () => {
    const replies = ring(4096, 16);
    const owner = new CompletionOwner({ access: serviceAccess(), commands: ring(256), replies });
    const held = deferred<number>();
    let starts = 0;
    let abandoned = 0;
    try {
      for (let token = 1; token <= 65; token++)
        owner.start(
          token,
          () => {
            starts++;
            return held.promise;
          },
          () => {},
          () => {},
          () => {
            abandoned++;
          },
        );
      expect(starts).toBe(64);
      expect(owner.pendingCount).toBe(0);
      expect(owner.state).toEqual({ kind: "terminal", reason: GPU_TERMINAL.resource });
      held.resolve(1);
      await settle();
      expect(abandoned).toBe(64);
    } finally {
      owner.terminate(GPU_TERMINAL.closed);
    }
    const fresh = new CompletionOwner({
      access: serviceAccess(),
      commands: ring(256),
      replies: ring(256, 16),
    });
    try {
      fresh.admit(2);
      expect(() => fresh.admit(2)).toThrow("increase");
      expect(() => fresh.admit(1)).toThrow("increase");
      fresh.admit(0xffffffff);
      expect(() => fresh.admit(0x100000000)).toThrow("increase");
      expect(() => fresh.admit(0)).toThrow("increase");
    } finally {
      fresh.terminate(GPU_TERMINAL.closed);
    }
  });
  test("fixed payload credit has generation-aware consuming reads and explicit local exhaustion", () => {
    const owner = new CompletionOwner({
      access: serviceAccess(),
      commands: ring(256),
      replies: ring(256, 16),
      arena: new Uint8Array(16),
    });
    try {
      const first = owner.allocatePayload(new Uint8Array([1, 2, 3, 4]));
      expect(first).toEqual(handle(1));
      if (!first) throw new Error("No payload");
      expect(() => owner.takePayload(first, new Uint8Array(3))).toThrow("Short");
      const destination = new Uint8Array(4);
      expect(owner.takePayload(first, destination)).toBe(4);
      expect(destination).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(() => owner.takePayload(first, destination)).toThrow("Stale");
      expect(owner.allocatePayload(new Uint8Array(16))).toEqual(handle(1, 2));
      expect(owner.payloadBytes).toBe(16);
      expect(owner.allocatePayload(new Uint8Array(1))).toBeUndefined();
      expect(owner.state).toEqual({ kind: "terminal", reason: GPU_TERMINAL.resource });
      expect(owner.payloadBytes).toBe(0);
      expect(() => owner.takePayload(first, destination)).toThrow();
    } finally {
      owner.terminate(GPU_TERMINAL.closed);
    }
  });
  test("held adapter promise cannot revive a terminal owner or retain reassembly credit", async () => {
    const adapter = deferred<object | null>();
    const local = rig({ root: { requestAdapter: () => adapter.promise } });
    try {
      send(
        local.connection,
        command("instance.request_adapter", {
          result: handle(2),
          token: 1,
          receiver: ROOT,
          options: null,
        }),
      );
      expect(local.connection.completions.pendingCount).toBe(1);
      local.connection.close(GPU_TERMINAL.revoked);
      adapter.resolve({
        requestDevice() {
          throw new Error("Revived");
        },
      });
      await settle();
      expect(local.connection.state).toEqual({ kind: "terminal", reason: GPU_TERMINAL.revoked });
      expect(local.connection.completions.pendingCount).toBe(0);
      expect(
        drain(local.replies).map((bytes) => new DataView(bytes.buffer).getUint16(0, true)),
      ).toEqual([12]);
    } finally {
      local.connection.close();
    }
    expect(local.credit.used).toBe(0);
  });
  test("all late-created devices are destroyed once, including released pending slots", async () => {
    const target = new RecordingTarget();
    const held = [deferred<object>(), deferred<object>()];
    let index = 0;
    Object.assign(target.adapter, { requestDevice: () => held[index++]?.promise });
    const local = rig(target);
    let destroyed = 0;
    try {
      send(
        local.connection,
        command("instance.request_adapter", {
          result: handle(2),
          token: 1,
          receiver: ROOT,
          options: null,
        }),
      );
      await settle();
      send(
        local.connection,
        command("adapter.request_device", {
          result: handle(3),
          token: 2,
          receiver: handle(2),
          descriptor: null,
        }),
      );
      send(
        local.connection,
        command("adapter.request_device", {
          result: handle(4),
          token: 3,
          receiver: handle(2),
          descriptor: null,
        }),
      );
      expect(local.connection.completions.pendingCount).toBe(2);
      send(local.connection, words(0x1000, [gpuObjectKinds.device, 3, 1]));
      held[0]?.resolve({
        destroy() {
          destroyed++;
        },
      });
      await settle();
      expect(destroyed).toBe(1);
      expect(local.connection.completions.pendingCount).toBe(1);
      expect(local.connection.state.kind).toBe("ready");
      local.connection.close(GPU_TERMINAL.revoked);
      held[1]?.resolve({
        destroy() {
          destroyed++;
        },
      });
      await settle();
      expect(destroyed).toBe(2);
      expect(local.connection.state.kind).toBe("terminal");
      expect(
        drain(local.replies).map((bytes) => new DataView(bytes.buffer).getUint16(0, true)),
      ).toEqual([1, 2, 12]);
    } finally {
      local.connection.close();
    }
    expect(local.credit.used).toBe(0);
  });
  test("device loss and uncaptured errors route without C callback pointers, and detach on retirement", async () => {
    const target = new RecordingTarget();
    const local = rig(target);
    try {
      await openDevice(local.connection);
      drain(local.replies);
      for (const listener of target.listeners) {
        if (typeof listener === "function")
          Reflect.apply(listener, undefined, [
            {
              error: new (class GPUValidationError {
                message = "validation";
              })(),
            },
          ]);
      }
      target.loss.resolve({ reason: "destroyed", message: "destroyed" });
      await settle();
      const events = drain(local.replies);
      expect(events.map((bytes) => new DataView(bytes.buffer).getUint16(0, true))).toEqual([6, 7]);
      expect(events.map((bytes) => new DataView(bytes.buffer).getUint32(8, true))).toEqual([0, 0]);
      local.connection.close(GPU_TERMINAL.revoked);
      expect(target.listeners.size).toBe(0);
      expect(local.connection.completions.publish("work-done", 99, 0, {})).toBe(false);
    } finally {
      local.connection.close();
    }
  });
  for (const cancellation of ["reply", "command", "append"]) {
    test(`${cancellation} cancellation fences device settlement before the next service slice`, async () => {
      const target = new RecordingTarget();
      const held = deferred<object>();
      Object.assign(target.adapter, { requestDevice: () => held.promise });
      const local = rig(target);
      let destroyed = 0;
      let attached = 0;
      try {
        send(
          local.connection,
          command("instance.request_adapter", {
            result: handle(2),
            token: 1,
            receiver: ROOT,
            options: null,
          }),
        );
        await settle();
        drain(local.replies);
        send(
          local.connection,
          command("adapter.request_device", {
            result: handle(3),
            token: 2,
            receiver: handle(2),
            descriptor: null,
          }),
        );
        if (cancellation === "reply") local.replies.terminate(GPU_TERMINAL.revoked);
        else if (cancellation === "command") local.commands.terminate(GPU_TERMINAL.revoked);
        else
          new LogicalAppend(
            local.commands,
            command("device.get_queue", {
              result: handle(5),
              receiver: handle(3),
            }),
          ).cancel(GPU_TERMINAL.revoked);
        held.resolve({
          destroy() {
            destroyed++;
          },
          addEventListener() {
            attached++;
          },
          removeEventListener() {},
        });
        await settle();
        expect(attached).toBe(0);
        expect(destroyed).toBe(1);
        expect(local.connection.state).toEqual({ kind: "terminal", reason: GPU_TERMINAL.revoked });
        expect(
          drain(local.replies).map((bytes) => new DataView(bytes.buffer).getUint16(0, true)),
        ).toEqual(cancellation === "reply" ? [] : [12]);
        expect(local.credit.used).toBe(0);
      } finally {
        local.connection.close();
      }
    });
  }
  for (const operation of ["publish", "allocate", "take"]) {
    test(`command cancellation fences ${operation} without another service slice`, () => {
      const commands = ring(256);
      const replies = ring(256, 16);
      const credit = new ServiceCredit();
      const connection = new GpuConnection(commands, replies, { root: {} }, credit, {
        access: serviceAccess(),
        arena: new Uint8Array(16),
      });
      try {
        const payload = connection.completions.allocatePayload(new Uint8Array([1, 2, 3, 4]));
        if (!payload) throw new Error("Missing initial payload");
        commands.terminate(GPU_TERMINAL.revoked);
        if (operation === "publish")
          expect(connection.completions.publish("work-done", 1, 0, {})).toBe(false);
        else if (operation === "allocate")
          expect(connection.completions.allocatePayload(new Uint8Array(1))).toBeUndefined();
        else expect(() => connection.completions.takePayload(payload, new Uint8Array(4))).toThrow();
        expect(connection.state).toEqual({ kind: "terminal", reason: GPU_TERMINAL.revoked });
        expect(connection.completions.payloadBytes).toBe(0);
      } finally {
        connection.close();
      }
    });
  }
  test("resource closure publishes the smaller closed record when the failed reply leaves enough room", () => {
    const replies = ring(64, 16);
    const owner = new CompletionOwner({ access: serviceAccess(), commands: ring(256), replies });
    try {
      for (let token = 1; token <= 3; token++) owner.publish("work-done", token, 0, {});
      drain(replies);
      expect(owner.publish("work-done", 1, 0, {})).toBe(true);
      expect(
        owner.publish("adapter", 2, 0, {
          status: 1,
          adapter: handle(2),
          message: "01234567890123456",
        }),
      ).toBe(false);
      expect(drain(replies).map((bytes) => new DataView(bytes.buffer).getUint16(0, true))).toEqual([
        15, 12,
      ]);
      expect(replies.terminal()?.reason).toBe(GPU_TERMINAL.resource);
    } finally {
      owner.terminate(GPU_TERMINAL.closed);
    }
  });
  test("corrupt reply writer state still terminates locally and runs every retirement cleanup", () => {
    const backing = new SharedArrayBuffer(64 + 128);
    const replies = new RecordRing(backing, 16);
    const owner = new CompletionOwner({
      access: serviceAccess(),
      commands: ring(256),
      replies,
      arena: new Uint8Array(16),
    });
    let retired = false;
    owner.onRetire(() => {
      retired = true;
    });
    owner.allocatePayload(new Uint8Array(8));
    Atomics.store(new Int32Array(backing), 3, 2);
    expect(() => owner.publish("work-done", 1, 0, {})).not.toThrow();
    expect(retired).toBe(true);
    expect(owner.payloadBytes).toBe(0);
    expect(owner.state).toEqual({ kind: "terminal", reason: GPU_TERMINAL.protocol });
    expect(replies.terminal()?.reason).toBe(GPU_TERMINAL.protocol);
  });
});
