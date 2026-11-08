import { expect, spyOn, test } from "bun:test";
import { gpuPayloadLayout } from "../browser/display/generated/graphics-layout.js";
import type { GraphicsOpen, GpuServiceReply } from "../browser/display/protocol.js";
import { CompletionOwner } from "../browser/gpu/completions.js";
import { RecordRing } from "../browser/gpu/ring.js";
import { GpuService } from "../browser/gpu/service.js";
import { payloadTerminalReady } from "./gpu-payload-pressure-browser.js";
import { command, deferred, drain, handle, ROOT, settle } from "./fixtures/gpu/core-fixture.js";
import { ringSnapshot } from "./fixtures/gpu/ring-snapshot.js";

function controlledTasks() {
  const tasks: (() => void)[] = [];
  const NativeChannel = globalThis.MessageChannel;
  class ControlledChannel extends NativeChannel {
    constructor() {
      super();
      this.port2.postMessage = () => {
        tasks.push(() => this.port1.onmessage?.(new MessageEvent("message", { data: null })));
      };
    }
  }
  return {
    create(root: object, send: (message: GpuServiceReply) => void) {
      globalThis.MessageChannel = ControlledChannel;
      try {
        return new GpuService(send, { root });
      } finally {
        globalThis.MessageChannel = NativeChannel;
      }
    },
    async until(ready: () => boolean) {
      for (let turn = 0; turn < 100; turn++) {
        if (ready()) return;
        tasks.shift()?.();
        await settle();
      }
      throw new Error("Controlled GPU service did not reach its CPU checkpoint");
    },
    turn() {
      const task = tasks.shift();
      if (!task) throw new Error("Missing controlled service turn");
      task();
    },
    clear: () => {
      tasks.length = 0;
    },
  };
}
function openRecord(): GraphicsOpen {
  return {
    type: "open",
    id: 1,
    control: new SharedArrayBuffer(64),
    commands: new SharedArrayBuffer(64 + 4096),
    replies: new SharedArrayBuffer(64 + 4096),
    arena: new SharedArrayBuffer(gpuPayloadLayout.byteLength),
  };
}
function publish(open: GraphicsOpen, bytes: Uint8Array): void {
  const acquired = new RecordRing(open.commands, 8).tryAcquireWriter();
  if (acquired.kind !== "acquired") throw new Error("Missing command writer");
  try {
    expect(acquired.writer.tryWrite(bytes).kind).toBe("written");
  } finally {
    acquired.writer.release();
  }
}

test("payload terminal observation joins real native settlement with the service turn", async () => {
  const tasks = controlledTasks(),
    open = openRecord();
  const requests: ReturnType<typeof deferred<{ messages: [] }>>[] = [];
  const lost = deferred<unknown>();
  const shader = {
    getCompilationInfo() {
      const request = deferred<{ messages: [] }>();
      requests.push(request);
      return request.promise;
    },
  };
  const device = {
    lost: lost.promise,
    queue: {},
    addEventListener() {},
    removeEventListener() {},
    destroy() {},
    createShaderModule: () => shader,
  };
  const sent: GpuServiceReply[] = [];
  const service = tasks.create(
    { requestAdapter: async () => ({ requestDevice: async () => device }) },
    (message) => sent.push(message),
  );
  const allocations: {
    owner: number;
    grant: number;
    connection: number;
    outcome: string;
    terminalReason: number;
  }[] = [];
  let restoreFill = () => {};
  const replies = new RecordRing(open.replies, 16);
  const sample = () => ({
    ...service.snapshot(),
    payloadPressure: { allocations: allocations.slice() },
    serviceReplies: sent.slice(),
    attempts: [
      {
        owner: 1,
        grant: 1,
        connection: 1,
        status: Atomics.load(new Int32Array(open.control), 0),
        reason: Atomics.load(new Int32Array(open.control), 1),
        arenaTerminal: Atomics.load(new Int32Array(open.arena), 0),
        commands: ringSnapshot(open.commands),
        replies: ringSnapshot(open.replies),
        retiredAck: sent.some((message) => message.type === "retired" && message.grant === 1),
      },
    ],
  });
  try {
    const originalFill = CompletionOwner.prototype.fillPayload;
    const fill = spyOn(CompletionOwner.prototype, "fillPayload").mockImplementation(function (
      this: CompletionOwner,
      length,
      copy,
    ) {
      const result = originalFill.call(this, length, copy);
      const state = this.state;
      if (!result && state.kind === "terminal")
        allocations.push({
          owner: 1,
          grant: 1,
          connection: 1,
          outcome: "refused",
          terminalReason: state.reason,
        });
      return result;
    });
    restoreFill = () => fill.mockRestore();
    service.receive({ type: "open", grant: 1, open, surfaces: [] });
    publish(
      open,
      command("instance.request_adapter", {
        result: handle(2),
        token: 1,
        receiver: ROOT,
        options: null,
      }),
    );
    await tasks.until(() => ringSnapshot(open.replies).used > 0);
    drain(replies);
    publish(
      open,
      command("adapter.request_device", {
        result: handle(3),
        token: 2,
        receiver: handle(2),
        descriptor: null,
      }),
    );
    await tasks.until(() => ringSnapshot(open.replies).used > 0);
    drain(replies);
    publish(
      open,
      command("device.create_shader_module", {
        result: handle(6),
        receiver: handle(3),
        descriptor: { next_in_chain: [{ sType: 2, value: { code: "" } }], label: "" },
      }),
    );
    for (let index = 0; index < 65; index++) {
      publish(
        open,
        command("shader_module.get_compilation_info", { token: index + 3, receiver: handle(6) }),
      );
      await tasks.until(() => requests.length === index + 1);
      requests[index]!.resolve({ messages: [] });
      await settle();
      if (index < 63) expect(drain(replies)).toHaveLength(1);
    }
    const refusal = sample();
    expect(refusal.attempts[0]).toMatchObject({ status: 1, reason: 0, arenaTerminal: 3 });
    expect(refusal.attempts[0]!.commands.terminal).toBe(3);
    expect(refusal.attempts[0]!.replies).toMatchObject({ used: 64, terminal: 3 });
    expect(refusal.serviceReplies).toEqual([]);
    tasks.turn();
    const terminal = sample();
    expect(terminal.serviceReplies).toEqual([{ type: "closed", grant: 1, id: 1 }]);
    expect(terminal.attempts[0]).toMatchObject({ status: -48, reason: 3, arenaTerminal: 3 });
    expect(terminal.attempts[0]!.retiredAck).toBe(false);
    expect(terminal.attempts[0]!.replies).toMatchObject({ used: 64, terminal: 3 });
    const committed = drain(replies).map((bytes) => new DataView(bytes.buffer).getUint16(0, true));
    expect(committed).toEqual([17, 12]);
    console.info(JSON.stringify({ stage: "cpu-payload-settlement", refusal, terminal }));
    expect(payloadTerminalReady(refusal)).toBe(false);
    expect(payloadTerminalReady(terminal)).toBe(true);
    for (const key of ["owner", "grant", "connection"]) {
      const other = structuredClone(terminal);
      Reflect.set(other.attempts[0]!, key, 99);
      expect(payloadTerminalReady(other)).toBe(false);
    }
  } finally {
    try {
      service.dispose();
    } finally {
      restoreFill();
      lost.resolve({ reason: "destroyed" });
      await settle();
      tasks.clear();
    }
  }
});
