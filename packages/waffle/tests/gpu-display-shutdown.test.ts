import { afterEach, expect, spyOn, test } from "bun:test";
import { createDisplayOwner } from "../browser/display/owner.js";
import { attachServiceAccess } from "../browser/display/service-readers.js";
import type { GraphicsOpen } from "../browser/display/protocol.js";
import type {
  GpuServiceRequest,
  GpuServiceReply,
  ServiceBootstrap,
} from "../browser/display/service-protocol.js";
import { GpuService } from "../browser/gpu/service.js";
import { GpuScheduler, type GpuConnection } from "../browser/gpu/scheduler.js";
import { gpuPayloadLayout } from "../browser/display/generated/graphics-layout.js";
import { enrollGraphics } from "./fixtures/gpu/service-access.js";
import { deferred, settle } from "./fixtures/gpu/core-fixture.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const task = () => new Promise<void>((resolve) => setImmediate(resolve));

function bridge() {
  const tasks: (() => void)[] = [];
  const connections: GpuConnection[] = [];
  const replies: GpuServiceReply[] = [];
  const late = deferred<void>();
  const native = deferred<number>();
  const state = {
    gate: undefined as SharedArrayBuffer | undefined,
    revokes: 0,
    stops: 0,
    abandoned: 0,
  };
  let service: GpuService | undefined;
  const Channel = globalThis.MessageChannel;
  class Tasks extends Channel {
    constructor() {
      super();
      this.port2.postMessage = () =>
        tasks.push(() => this.port1.onmessage?.(new MessageEvent("message")));
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
  const value = {
    onerror: null as (() => void) | null,
    onmessage: null as ((event: MessageEvent<GpuServiceReply>) => void) | null,
    onmessageerror: null,
    postMessage(message: GpuServiceRequest | ServiceBootstrap) {
      if (message.type === "bootstrap") {
        state.gate = message.readers;
        globalThis.MessageChannel = Tasks;
        try {
          service = new GpuService((reply) => replies.push(reply), {
            access: attachServiceAccess(message.readers),
            root: {},
          });
        } finally {
          globalThis.MessageChannel = Channel;
        }
        return;
      }
      if (!service) throw new Error("missing service");
      service.receive(message);
      if (message.type === "revoke") {
        state.revokes++;
        native.resolve(42);
      }
    },
    terminate() {
      state.stops++;
    },
  };
  const turn = async () => {
    tasks.shift()?.();
    await settle();
  };
  const deliver = async () => {
    for (const reply of replies.splice(0)) {
      if (reply.type === "retired") await late.promise;
      value.onmessage?.(new MessageEvent("message", { data: reply }));
    }
  };
  cleanups.push(async () => {
    native.resolve(42);
    late.resolve();
    const disposal = service?.dispose();
    for (let n = 0; n < 20 && tasks.length; n++) await turn();
    await disposal;
  });
  return { state, value, connections, replies, turn, deliver, native, late };
}

for (const mode of ["suspend", "dispose", "already-revoking"] as const)
  test(`healthy ${mode} preserves real cooperative cleanup before closing service readers`, async () => {
    const raf = globalThis.requestAnimationFrame,
      cancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = () => 1;
    globalThis.cancelAnimationFrame = () => {};
    cleanups.push(() => {
      globalThis.requestAnimationFrame = raf;
      globalThis.cancelAnimationFrame = cancel;
    });
    const rig = bridge();
    const owner = createDisplayOwner(() => {}, {
      commandBytes: 64,
      completionBytes: 64,
      worker: () => rig.value as unknown as Worker,
    });
    const grant = owner.display.grant({ gpu: true, surfaces: [] });
    enrollGraphics(grant);
    cleanups.push(() => grant.connection.port.close());
    const open: GraphicsOpen = {
      type: "open",
      id: 1,
      control: new SharedArrayBuffer(64),
      commands: new SharedArrayBuffer(128),
      replies: new SharedArrayBuffer(128),
      arena: new SharedArrayBuffer(gpuPayloadLayout.byteLength),
    };
    grant.connection.port.postMessage(open);
    await task();
    expect(rig.connections).toHaveLength(1);
    rig.connections[0]!.completions.start(
      1,
      () => rig.native.promise,
      () => {
        throw new Error("retired completion settled live");
      },
      () => {
        throw new Error("unexpected rejection");
      },
      (value) => {
        expect(value).toBe(42);
        rig.state.abandoned++;
        rig.late.resolve();
      },
    );
    if (mode === "already-revoking") grant.dispose();
    if (mode === "suspend") owner.suspend();
    const disposal = owner.dispose();
    let disposed = false,
      retired = false;
    void disposal.then(() => {
      disposed = true;
    });
    void grant.retired().then(() => {
      retired = true;
    });
    await settle();
    try {
      expect(rig.state.revokes).toBe(1);
      expect(Atomics.load(new Int32Array(grant.connection.revocation), 0)).toBe(1);
      expect(Atomics.load(new Int32Array(rig.state.gate!), 0)).toBeGreaterThanOrEqual(0);
      expect(rig.state.stops).toBe(0);
      expect(disposed).toBe(false);
      expect(retired).toBe(false);
      expect(() => owner.display.grant({ gpu: true, surfaces: [] })).toThrow("disposed");
      for (let n = 0; n < 6; n++) await rig.turn();
      expect(rig.state.abandoned).toBe(1);
      expect(rig.replies.filter((reply) => reply.type === "retired")).toHaveLength(1);
      expect(rig.state.stops).toBe(0);
      await rig.deliver();
      await disposal;
      expect(disposed).toBe(true);
      expect(retired).toBe(true);
      expect(rig.state.stops).toBe(1);
      expect(Atomics.load(new Int32Array(rig.state.gate!), 0)).toBe(-1);
    } finally {
      rig.value.onerror?.();
      await disposal;
    }
  });
