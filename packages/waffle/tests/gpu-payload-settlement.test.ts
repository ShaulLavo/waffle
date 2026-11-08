import { serviceAccess } from "./fixtures/gpu/service-access.js";
import { expect, spyOn, test } from "bun:test";
import { gpuPayloadLayout } from "../browser/display/generated/graphics-layout.js";
import type { GraphicsOpen } from "../browser/display/protocol.js";
import type { GpuServiceReply } from "../browser/display/service-protocol.js";
import { CompletionOwner } from "../browser/gpu/completions.js";
import { RecordRing } from "../browser/gpu/ring.js";
import { GpuService } from "../browser/gpu/service.js";
import {
  payloadTerminalObservation,
  payloadTerminalReady,
} from "./gpu-payload-pressure-browser.js";
import { until } from "./gpu-ownership-browser.js";
import { qualificationRecord } from "./fixtures/gpu/qualification-contract.js";
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
        return new GpuService(send, { access: serviceAccess(), root });
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

function payloadObservationSnapshot(status: number, reason: number): Record<string, unknown> {
  return {
    payloadPressure: {
      allocations: [{ outcome: "refused", terminalReason: 3, owner: 1, grant: 1, connection: 1 }],
    },
    attempts: [
      {
        owner: 1,
        grant: 1,
        connection: 1,
        status,
        reason,
        arenaTerminal: 3,
        commands: { terminal: 3 },
        replies: { terminal: 3 },
      },
    ],
  };
}

type PayloadObservationPoll = Parameters<typeof payloadTerminalObservation>[0];
async function withPayloadSnapshots(
  samples: readonly { at: number; service: Record<string, unknown> }[],
  run: (poll: PayloadObservationPoll, state: () => { now: number; polls: number }) => Promise<void>,
) {
  let now = 0,
    next = 0,
    polls = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const page = {
    async evaluate() {
      const sample = samples[next++];
      if (!sample) throw new Error("Unexpected extra payload polling");
      now = sample.at;
      return sample.service;
    },
  };
  const poll: PayloadObservationPoll = async (ready) => {
    polls++;
    return qualificationRecord(await Reflect.apply(until, undefined, [page, ready]));
  };
  try {
    await run(poll, () => ({ now, polls }));
  } finally {
    clock.mockRestore();
  }
}

test("payload refusal and settlement keep one polling deadline", async () => {
  const refusal = payloadObservationSnapshot(1, 0),
    terminal = payloadObservationSnapshot(-48, 3);
  await withPayloadSnapshots(
    [
      { at: 100, service: refusal },
      { at: 200, service: payloadObservationSnapshot(1, 0) },
      { at: 300, service: terminal },
    ],
    async (poll, state) => {
      const observed = await payloadTerminalObservation(poll);
      expect(observed.refusal).toBe(refusal);
      expect(observed.terminal).toBe(terminal);
      expect(state()).toEqual({ now: 300, polls: 1 });
    },
  );
});

test("late payload refusal cannot renew the original settlement budget", async () => {
  const refusal = payloadObservationSnapshot(1, 0),
    terminal = payloadObservationSnapshot(-48, 3);
  await withPayloadSnapshots(
    [
      { at: 14900, service: refusal },
      { at: 14901, service: refusal },
      { at: 16000, service: refusal },
      { at: 20000, service: terminal },
    ],
    async (poll, state) => {
      await expect(payloadTerminalObservation(poll)).rejects.toThrow("checkpoint deadline");
      expect(state()).toEqual({ now: 16000, polls: 1 });
    },
  );
});

test("already settled payload refusal retains the identical checkpoint", async () => {
  const terminal = payloadObservationSnapshot(-48, 3);
  await withPayloadSnapshots([{ at: 14900, service: terminal }], async (poll, state) => {
    const observed = await payloadTerminalObservation(poll);
    expect(observed.refusal).toBe(terminal);
    expect(observed.terminal).toBe(terminal);
    expect(state()).toEqual({ now: 14900, polls: 1 });
  });
});
