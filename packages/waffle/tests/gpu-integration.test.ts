import { serviceAccess, enrollGraphics } from "./fixtures/gpu/service-access.js";
import { gpuPayloadLayout } from "../browser/display/generated/graphics-layout.js";
import { validGraphicsOpen } from "../browser/display/open.js";
import { afterEach, expect, test } from "bun:test";
import { createGraphicsGuest } from "../browser/gpu/guest.js";
import { RuntimeWorkerSignal } from "../browser/worker.js";
import { WasiExit } from "../core/index.js";
import { ProcessSignalExit } from "../proc/abi.js";
import { importUnwind } from "./fixtures/gpu/import-unwind.js";
import {
  createSharedControlAllocator,
  installSharedControlAllocator,
  consumedControlBytes,
  type SharedControlGrant,
} from "../memory/control.js";
import { RecordRing } from "../browser/gpu/ring.js";
import { completionBytes } from "../browser/gpu/codec.js";
import { createDisplayOwner } from "../browser/display/owner.js";
import { GpuService } from "../browser/gpu/service.js";
import type { GraphicsOpen } from "../browser/display/protocol.js";
import { command, deferred, handle, ROOT, settle } from "./fixtures/gpu/core-fixture.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function openRecord(id = 1): GraphicsOpen {
  return {
    type: "open",
    id,
    control: new SharedArrayBuffer(64),
    commands: new SharedArrayBuffer(64 + 4096),
    replies: new SharedArrayBuffer(64 + 4096),
    arena: new SharedArrayBuffer(gpuPayloadLayout.byteLength),
  };
}
function guest(
  options: {
    gpu?: boolean;
    limit?: number;
    failPost?: boolean;
    revokeOnPost?: boolean;
    live?: () => void;
  } = {},
) {
  const receipts: SharedArrayBuffer[] = [];
  const grant: SharedControlGrant = {
    kind: "bounded",
    state: new SharedArrayBuffer(8),
    limit: options.limit ?? 3_000_000,
  };
  cleanups.push(
    installSharedControlAllocator(
      createSharedControlAllocator(grant, (buffer) => receipts.push(buffer)),
    ),
  );
  const revocation = new SharedArrayBuffer(64);
  let opened: GraphicsOpen | undefined;
  const port = {
    postMessage(message: GraphicsOpen | { type: "close"; id: number }) {
      if (options.failPost) throw new Error("post failure");
      if (message.type === "open") {
        if (!validGraphicsOpen(message, 4096, 4096)) throw new Error("Invalid real open shape");
        opened = message;
        if (options.revokeOnPost) {
          Atomics.store(new Int32Array(revocation), 0, 1);
          return;
        }
        Atomics.store(new Int32Array(message.control), 0, 1);
      }
    },
    close() {},
  } as unknown as MessagePort;
  const memory = new WebAssembly.Memory({ initial: 1 });
  const imports = createGraphicsGuest(
    {
      port,
      revocation,
      surfaces: [],
      gpu: options.gpu ?? true,
      commandBytes: 4096,
      completionBytes: 4096,
    },
    () => memory,
    options.live ?? (() => {}),
  );
  cleanups.push(() => imports.dispose());
  const gpu = imports.imports.runtime_gpu!;
  const invoke = (name: string, ...args: (number | bigint)[]) => {
    const call = gpu[name];
    if (typeof call !== "function") throw new Error("Missing function");
    return call(...args);
  };
  return { memory, imports, invoke, receipts, grant, revocation, opened: () => opened };
}
test("guest shared controls are claimed before construction and fixed", () => {
  const rig = guest();
  expect(rig.invoke("open", 0, 0)).toBe(0);
  expect(rig.receipts.map((buffer) => buffer.byteLength)).toEqual([
    64,
    4160,
    4160,
    gpuPayloadLayout.byteLength,
  ]);
  expect(rig.receipts.every((buffer) => !buffer.growable)).toBe(true);
  expect(consumedControlBytes(rig.grant)).toBe(1_056_960);
  expect(rig.invoke("close", 1)).toBe(0);
  expect(rig.invoke("close", 1)).toBe(0);
  expect(consumedControlBytes(rig.grant)).toBe(1_056_960);
});
test("bounded refusal happens without constructing unadmitted backing or posting open", () => {
  const rig = guest({ limit: 64 });
  expect(rig.invoke("open", 0, 0)).toBe(-48);
  expect(rig.receipts).toHaveLength(1);
  expect(rig.opened()).toBeUndefined();
  expect(consumedControlBytes(rig.grant)).toBe(64);
});
test("output spans validate before allocation and surface-only grants expose no GPU", () => {
  const rig = guest();
  expect(rig.invoke("open", 0, 65535)).toBe(-28);
  expect(rig.receipts).toHaveLength(0);
  expect(guest({ gpu: false }).imports.imports.runtime_gpu).toBeUndefined();
});
test("post failure returns a bounded failure, no live command ring", () => {
  const rig = guest({ failPost: true });
  expect(rig.invoke("open", 0, 0)).toBe(-64);
});
test("committed completions drain before resource terminal becomes ENOMEM", () => {
  const rig = guest();
  rig.invoke("open", 0, 0);
  const ring = new RecordRing(rig.opened()!.replies, 16);
  const writer = ring.tryAcquireWriter();
  if (writer.kind !== "acquired") throw new Error("Missing writer");
  writer.writer.tryWrite(completionBytes("closed", 0, 0, { reason: 3 }, 4096));
  writer.writer.release();
  new RecordRing(rig.opened()!.commands, 8).terminate(3);
  ring.terminate(3);
  expect(rig.invoke("completions", 1, 64, 64, 0n, 4)).toBe(0);
  expect(new DataView(rig.memory.buffer).getUint32(4, true)).toBe(24);
  expect(rig.invoke("completions", 1, 64, 64, 0n, 4)).toBe(-48);
});
test("display-only creates no worker; constructor failure settles pending open", async () => {
  let creates = 0;
  const owner = createDisplayOwner(() => {}, {
    worker: () => {
      creates++;
      throw new Error("constructor failed");
    },
    commandBytes: 4096,
    completionBytes: 4096,
  });
  cleanups.push(() => owner.dispose());
  const grant = owner.display.grant({ surfaces: [], gpu: true });
  enrollGraphics(grant);
  cleanups.push(() => grant.connection.port.close());
  expect(creates).toBe(0);
  const open = openRecord();
  grant.connection.port.postMessage(open);
  await grant.retired();
  expect(creates).toBe(1);
  expect(Atomics.load(new Int32Array(open.control), 0)).toBe(-64);
  expect(new RecordRing(open.commands, 8).terminal()).toMatchObject({ reason: 5 });
});
test("initial service post failure terminates the failed worker before replacement", async () => {
  let stops = 0,
    creates = 0;
  const originalRaf = globalThis.requestAnimationFrame,
    originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  cleanups.push(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  });
  const owner = createDisplayOwner(() => {}, {
    commandBytes: 4096,
    completionBytes: 4096,
    worker: () => {
      creates++;
      return {
        postMessage() {
          throw new Error("post failed");
        },
        terminate() {
          stops++;
        },
      } as unknown as Worker;
    },
  });
  cleanups.push(() => owner.dispose());
  for (let turn = 0; turn < 2; turn++) {
    const grant = owner.display.grant({ surfaces: [], gpu: true }),
      open = openRecord();
    enrollGraphics(grant);
    grant.connection.port.postMessage(open);
    await grant.retired();
    grant.connection.port.close();
    expect(Atomics.load(new Int32Array(open.control), 0)).toBe(-64);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stops).toBe(turn + 1);
  }
  expect(creates).toBe(2);
});
test("service revocation terminalizes held adapter work and cannot resurrect", async () => {
  let resolve!: (adapter: object) => void;
  const service = new GpuService(() => {}, {
    access: serviceAccess(),
    root: {
      requestAdapter: () =>
        new Promise<object>((yes) => {
          resolve = yes;
        }),
    },
  });
  cleanups.push(() => service.dispose());
  const open = openRecord();
  service.receive({ type: "open", grant: 1, open, surfaces: [] });
  const ring = new RecordRing(open.commands, 8),
    writer = ring.tryAcquireWriter();
  if (writer.kind !== "acquired") throw new Error("Missing writer");
  writer.writer.tryWrite(
    command("instance.request_adapter", {
      result: handle(2),
      token: 1,
      receiver: ROOT,
      options: null,
    }),
  );
  writer.writer.release();
  await Bun.sleep(20);
  service.receive({ type: "revoke", grant: 1 });
  resolve({
    requestDevice() {
      throw new Error("late adapter used");
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(service.snapshot()).toMatchObject({ connections: 0, heapBytes: 0 });
  expect(new RecordRing(open.replies, 16).terminal()).toMatchObject({ reason: 4 });
});

test("service setup failure settles open controls and only the offending connection", () => {
  const service = new GpuService(() => {}, { access: serviceAccess(), root: {} });
  cleanups.push(() => service.dispose());
  const invalid = openRecord();
  service.receive({ type: "open", grant: 1, open: invalid, surfaces: [{ id: 999 }] });
  expect(Atomics.load(new Int32Array(invalid.control), 0)).toBe(-64);
  const valid = openRecord(2);
  service.receive({ type: "open", grant: 2, open: valid, surfaces: [] });
  expect(Atomics.load(new Int32Array(valid.control), 0)).toBe(1);
  expect(service.snapshot().connections).toBe(1);
});

test("revoke settles an open before worker construction, and grant disposal is idempotent", async () => {
  let creates = 0;
  const owner = createDisplayOwner(() => {}, {
    commandBytes: 4096,
    completionBytes: 4096,
    worker: () => {
      creates++;
      throw new Error("must not activate");
    },
  });
  cleanups.push(() => owner.dispose());
  const grant = owner.display.grant({ surfaces: [], gpu: true });
  enrollGraphics(grant);
  grant.dispose();
  grant.dispose();
  await grant.retired();
  expect(creates).toBe(0);
  grant.connection.port.close();
});

test("unknown connections return EBADF while closed connections return EPIPE", () => {
  const rig = guest();
  expect(rig.invoke("append", 55, 0, 0)).toBe(-8);
  rig.invoke("open", 0, 0);
  rig.invoke("close", 1);
  expect(rig.invoke("payload", 1, 0, 0, 0)).toBe(-64);
  expect(rig.invoke("close", 55)).toBe(-8);
});

test("launch-wide revocation settles open even before its page message is delivered", () => {
  const rig = guest({ revokeOnPost: true });
  expect(rig.invoke("open", 0, 0)).toBe(-64);
  expect(Atomics.load(new Int32Array(rig.opened()!.control), 0)).toBe(-64);
  expect(new RecordRing(rig.opened()!.commands, 8).terminal()).toMatchObject({ reason: 4 });
});

test("revoked launch refuses a new open before any buffer allocation", () => {
  const rig = guest();
  Atomics.store(new Int32Array(rig.revocation), 0, 1);
  expect(rig.invoke("open", 0, 0)).toBe(-64);
  expect(rig.receipts).toEqual([]);
});

async function nativeServiceReply(open: GraphicsOpen): Promise<void> {
  const replies = new RecordRing(open.replies, 16);
  const scratch = new Uint8Array(4096);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const result = replies.readInto(scratch);
    if (result.kind === "record") return;
    if (result.kind === "terminal") throw new Error("Native service setup terminated");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Native service setup reply missing");
}

async function trackedNativeDevice(destroy: () => unknown = () => undefined) {
  const lost = deferred<unknown>();
  const destroyed = deferred<void>();
  let destroyCalls = 0;
  const device = {
    lost: lost.promise,
    addEventListener() {},
    removeEventListener() {},
    destroy() {
      expect(this).toBe(device);
      destroyCalls++;
      const result = destroy();
      destroyed.resolve();
      return result;
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      gpu: {
        async requestAdapter() {
          return {
            async requestDevice() {
              return device;
            },
          };
        },
      },
    },
  });
  cleanups.push(() => {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  });
  const service = new GpuService(() => {}, { access: serviceAccess() });
  cleanups.push(() => service.dispose().catch(() => {}));
  cleanups.push(() => lost.resolve({ reason: "destroyed" }));
  const open = openRecord();
  service.receive({ type: "open", grant: 1, open, surfaces: [] });
  const ring = new RecordRing(open.commands, 8);
  const writer = ring.tryAcquireWriter();
  if (writer.kind !== "acquired") throw new Error("Missing native device writer");
  writer.writer.tryWrite(
    command("instance.request_adapter", {
      result: handle(2),
      token: 1,
      receiver: ROOT,
      options: null,
    }),
  );
  writer.writer.release();
  await nativeServiceReply(open);
  const deviceWriter = ring.tryAcquireWriter();
  if (deviceWriter.kind !== "acquired") throw new Error("Missing request-device writer");
  deviceWriter.writer.tryWrite(
    command("adapter.request_device", {
      result: handle(3),
      token: 2,
      receiver: handle(2),
      descriptor: null,
    }),
  );
  deviceWriter.writer.release();
  await nativeServiceReply(open);
  return { service, ring, device, lost, destroyed, destroyCalls: () => destroyCalls };
}

for (const mode of ["revoke", "guest-destroy"]) {
  test(`native device ownership retires on ${mode} before its loss promise settles`, async () => {
    const rig = await trackedNativeDevice();
    expect(rig.service.snapshot().devicesLive).toBe(1);
    if (mode === "revoke") {
      rig.service.receive({ type: "revoke", grant: 1 });
      await rig.destroyed.promise;
    } else {
      const writer = rig.ring.tryAcquireWriter();
      if (writer.kind !== "acquired") throw new Error("Missing destroy writer");
      writer.writer.tryWrite(command("device.destroy", { receiver: handle(3) }));
      writer.writer.release();
      await rig.destroyed.promise;
    }
    expect(rig.destroyCalls()).toBe(1);
    expect(rig.service.snapshot().devicesLive).toBe(0);
    rig.lost.resolve({ reason: "destroyed" });
    await settle();
    expect(rig.service.snapshot().devicesLive).toBe(0);
    await rig.service.dispose();
    expect(rig.destroyCalls()).toBe(1);
  });
}

test("native device destruction preserves failures without claiming successful retirement", async () => {
  const failure = new Error("native destroy failure");
  const rig = await trackedNativeDevice(() => {
    throw failure;
  });
  expect(() => Reflect.apply(rig.device.destroy, rig.device, [])).toThrow(failure);
  expect(rig.service.snapshot().devicesLive).toBe(1);
  rig.lost.resolve({ reason: "unknown" });
  await settle();
  expect(rig.service.snapshot().devicesLive).toBe(0);
});

test("native device destruction preserves its result and repeated calls", async () => {
  const rig = await trackedNativeDevice(() => false);
  expect(Reflect.apply(rig.device.destroy, rig.device, [])).toBe(false);
  expect(rig.service.snapshot().devicesLive).toBe(1);
  expect(Reflect.apply(rig.device.destroy, rig.device, [])).toBe(false);
  expect(rig.destroyCalls()).toBe(2);
  expect(rig.service.snapshot().devicesLive).toBe(1);
  rig.lost.resolve({ reason: "destroyed", message: "actual native loss" });
  await settle();
  expect(rig.service.snapshot().devicesLive).toBe(0);
});

for (const limit of [8384, 1_056_959])
  test(`arena admission refuses before the fourth construction at quota ${limit}`, () => {
    const rig = guest({ limit });
    expect(rig.invoke("open", 0, 0)).toBe(-48);
    expect(rig.opened()).toBeUndefined();
    expect(rig.receipts.map((buffer) => buffer.byteLength)).toEqual([64, 4160, 4160]);
    expect(consumedControlBytes(rig.grant)).toBe(64 + 4160 + 4160);
  });
test("exact arena quota admits one open and close/reopen preserves physical backing debt", () => {
  const exact = guest({ limit: 1_056_960 });
  expect(exact.invoke("open", 0, 0)).toBe(0);
  expect(consumedControlBytes(exact.grant)).toBe(64 + 4160 + 4160 + gpuPayloadLayout.byteLength);
  expect(exact.invoke("close", 1)).toBe(0);
  expect(consumedControlBytes(exact.grant)).toBe(1_056_960);
  const repeat = guest();
  expect(repeat.invoke("open", 0, 0)).toBe(0);
  expect(repeat.invoke("close", 1)).toBe(0);
  expect(repeat.invoke("open", 0, 0)).toBe(0);
  expect(
    repeat.receipts.filter((backing) => backing.byteLength === gpuPayloadLayout.byteLength),
  ).toHaveLength(2);
  expect(consumedControlBytes(repeat.grant)).toBe(2 * 1_056_960);
});

test("actual GPU waits preserve fatal liveness unwinds instead of returning an errno", () => {
  const killed = new RuntimeWorkerSignal(9);
  let waiting = false,
    checks = 0;
  const rig = guest({
    live() {
      if (waiting && ++checks >= 3) throw killed;
    },
  });
  expect(rig.invoke("open", 0, 0)).toBe(0);
  waiting = true;
  let thrown: unknown;
  try {
    rig.invoke("completions", 1, 64, 64, -1n, 4);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(killed);
  expect(checks).toBe(4);
  expect(importUnwind(thrown)).toEqual({ kind: "signal", code: 9 });
});

test("the import observer classifies only actual runtime unwind objects", () => {
  expect(importUnwind(new RuntimeWorkerSignal(9))).toEqual({ kind: "signal", code: 9 });
  expect(importUnwind(new ProcessSignalExit(9))).toEqual({ kind: "signal", code: 9 });
  expect(importUnwind(new WasiExit(1))).toEqual({ kind: "exit", code: 1 });
  expect(importUnwind(new TypeError("unrelated native error"))).toBeUndefined();
  expect(importUnwind({ signal: 9 })).toBeUndefined();
});
