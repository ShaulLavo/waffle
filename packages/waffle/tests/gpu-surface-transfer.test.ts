import { afterEach, expect, test } from "bun:test";
import { createDisplayOwner, type DisplaySurface } from "../browser/display/owner.js";
import { GpuSurfaces } from "../browser/gpu/surfaces.js";
import { GpuService } from "../browser/gpu/service.js";
import type { GraphicsOpen } from "../browser/display/protocol.js";
import type {
  GpuServiceRequest,
  GpuServiceReply,
  ServiceBootstrap,
} from "../browser/display/service-protocol.js";
import { graphicsOpen as open, rig as coreRig } from "./fixtures/gpu/core-fixture.js";
import { enrollGraphics, serviceReaderOwner } from "./fixtures/gpu/service-access.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function transport(open: GraphicsOpen) {
  return [open.control, open.commands, open.replies, open.arena].map((buffer) =>
    Array.from(new Uint8Array(buffer)),
  );
}
function canvas(context: () => object | null) {
  // CPU Bun has no native OffscreenCanvas. Only the native object is substituted.
  return { getContext: context } as unknown as OffscreenCanvas;
}
function rig() {
  const readers = serviceReaderOwner();
  const tasks: (() => void)[] = [];
  const replies: GpuServiceReply[] = [];
  const NativeChannel = globalThis.MessageChannel;
  class Tasks extends NativeChannel {
    constructor() {
      super();
      this.port2.postMessage = () => {
        tasks.push(() => this.port1.onmessage?.(new MessageEvent("message")));
      };
    }
  }
  let service: GpuService;
  globalThis.MessageChannel = Tasks;
  try {
    service = new GpuService((reply) => replies.push(reply), { access: readers.access, root: {} });
  } finally {
    globalThis.MessageChannel = NativeChannel;
  }
  const turn = () => tasks.shift()?.();
  const drain = () => {
    for (let index = 0; index < 32 && tasks.length; index++) turn();
  };
  cleanups.push(async () => {
    const disposal = service.dispose();
    drain();
    await disposal.catch(() => {});
    await readers.readers.close().join();
    tasks.length = 0;
  });
  return { service, readers: readers.readers, replies, turn, drain };
}

test("delayed first transfer survives retirement for a fresh grant without old transport changes", () => {
  const current = rig();
  const original = open(),
    fresh = open(2);
  let attaches = 0;
  const native = canvas(() => {
    attaches++;
    return { transferFromImageBitmap() {} };
  });
  current.service.receive({ type: "surface-register", id: 1 });
  current.service.receive({ type: "revoke", grant: 1 });
  current.drain();
  expect(current.replies).toEqual([{ type: "retired", grant: 1 }]);
  const frozen = transport(original);
  current.service.receive({
    type: "open",
    grant: 1,
    open: original,
    surfaces: [{ id: 1, canvas: native }],
  });
  current.service.receive({ type: "open", grant: 2, open: fresh, surfaces: [{ id: 1 }] });
  expect(Atomics.load(new Int32Array(fresh.control), 0)).toBe(1);
  expect(attaches).toBe(1);
  expect(current.service.snapshot()).toMatchObject({ connections: 1, surfaces: 1 });
  expect(transport(original)).toEqual(frozen);
});

function register(current: ReturnType<typeof rig>, id = 1): void {
  current.service.receive({ type: "surface-register", id });
}
function receive(
  current: ReturnType<typeof rig>,
  original: GraphicsOpen,
  native: OffscreenCanvas,
  grant = 1,
  id = 1,
): void {
  current.service.receive({
    type: "open",
    grant,
    open: original,
    surfaces: [{ id, canvas: native }],
  });
}
function retire(current: ReturnType<typeof rig>, grant = 1): void {
  current.service.receive({ type: "revoke", grant });
  current.drain();
  expect(current.replies).toContainEqual({ type: "retired", grant });
}
function guarded(original: GraphicsOpen) {
  let reads = 0;
  const envelope: GraphicsOpen = {
    type: "open",
    id: original.id,
    get control(): SharedArrayBuffer {
      reads++;
      throw new Error("Retired control read");
    },
    get commands(): SharedArrayBuffer {
      reads++;
      throw new Error("Retired commands read");
    },
    get replies(): SharedArrayBuffer {
      reads++;
      throw new Error("Retired replies read");
    },
    get arena(): SharedArrayBuffer {
      reads++;
      throw new Error("Retired arena read");
    },
  };
  return { envelope, reads: () => reads };
}

test("retired ingestion reads no original transport or ID-only references", () => {
  const current = rig();
  register(current);
  const original = open();
  retire(current);
  const frozen = transport(original),
    protectedOpen = guarded(original);
  let attaches = 0;
  receive(
    current,
    protectedOpen.envelope,
    canvas(() => {
      attaches++;
      return { transferFromImageBitmap() {} };
    }),
  );
  current.service.receive({
    type: "open",
    grant: 1,
    open: protectedOpen.envelope,
    surfaces: [{ id: 2 }],
  });
  current.drain();
  expect(protectedOpen.reads()).toBe(0);
  expect(transport(original)).toEqual(frozen);
  expect(attaches).toBe(1);
  expect(current.service.snapshot()).toMatchObject({ connections: 0, surfaces: 1, heapBytes: 0 });
});

for (const delivery of ["before", "after"] as const) {
  test(`surface disposal ${delivery} transfer cannot resurrect on a fresh grant`, () => {
    const current = rig();
    register(current);
    retire(current);
    const original = guarded(open());
    let attaches = 0,
      clears = 0;
    const native = canvas(() => {
      attaches++;
      return {
        transferFromImageBitmap(value: unknown) {
          expect(value).toBeNull();
          clears++;
        },
      };
    });
    if (delivery === "after") receive(current, original.envelope, native);
    current.service.receive({ type: "surface-dispose", id: 1 });
    current.drain();
    if (delivery === "before") receive(current, original.envelope, native);
    const fresh = open(2);
    current.service.receive({ type: "open", grant: 2, open: fresh, surfaces: [{ id: 1 }] });
    expect(Atomics.load(new Int32Array(fresh.control), 0)).toBe(-64);
    expect(current.service.snapshot()).toMatchObject({
      connections: 0,
      surfaces: 0,
      registeredSurfaces: 0,
    });
    expect(attaches).toBe(delivery === "after" ? 1 : 0);
    expect(clears).toBe(delivery === "after" ? 1 : 0);
    expect(original.reads()).toBe(0);
  });
}

test("live setup revoke keeps its counted frame and separate acknowledgement task", () => {
  const current = rig();
  register(current);
  const original = open();
  receive(
    current,
    original,
    canvas(() => {
      current.service.receive({ type: "revoke", grant: 1 });
      current.turn();
      expect(current.replies).toEqual([]);
      expect(Atomics.load(new Int32Array(original.control), 0)).toBe(0);
      return { transferFromImageBitmap() {} };
    }),
  );
  expect(current.service.snapshot()).toMatchObject({ connections: 0, surfaces: 1 });
  current.turn();
  expect(Atomics.load(new Int32Array(original.control), 0)).toBe(-64);
  expect(current.replies).toEqual([]);
  current.turn();
  expect(current.replies).toEqual([{ type: "retired", grant: 1 }]);
  const fresh = open(2);
  current.service.receive({ type: "open", grant: 2, open: fresh, surfaces: [{ id: 1 }] });
  expect(Atomics.load(new Int32Array(fresh.control), 0)).toBe(1);
});

test("disposal reentered from getContext invalidates immediately and cleans its returned context", () => {
  const current = rig();
  register(current);
  let clears = 0,
    duplicates = 0;
  receive(
    current,
    open(),
    canvas(() => {
      current.service.receive({ type: "surface-dispose", id: 1 });
      current.turn();
      const reentrant = open(2);
      receive(
        current,
        reentrant,
        canvas(() => {
          duplicates++;
          return {};
        }),
        2,
      );
      expect(Atomics.load(new Int32Array(reentrant.control), 0)).toBe(-64);
      expect(current.service.snapshot().registeredSurfaces).toBe(1);
      return {
        transferFromImageBitmap() {
          clears++;
        },
      };
    }),
  );
  current.drain();
  expect(current.service.snapshot()).toMatchObject({
    connections: 0,
    surfaces: 0,
    registeredSurfaces: 0,
  });
  expect(clears).toBe(1);
  expect(duplicates).toBe(0);
});

test("native owner reserves a pending identity before reentrant duplicate attachment", () => {
  const owner = new GpuSurfaces();
  owner.register(1);
  let duplicateCalls = 0;
  const duplicate = canvas(() => {
    duplicateCalls++;
    return {};
  });
  const first = canvas(() => {
    expect(() => owner.register(1)).toThrow();
    expect(() => owner.attach([{ id: 1, canvas: duplicate }])).toThrow();
    return { transferFromImageBitmap() {} };
  });
  owner.attach([{ id: 1, canvas: first }]);
  expect(owner.get(1)?.canvas).toBe(first);
  expect(duplicateCalls).toBe(0);
  owner.dispose(1);
});

test("disposing lookup denies use but still exposes the actual resource until cleanup succeeds", () => {
  const owner = new GpuSurfaces();
  owner.register(1);
  let clears = 0;
  owner.attach([
    {
      id: 1,
      canvas: canvas(() => ({
        transferFromImageBitmap() {
          clears++;
        },
      })),
    },
  ]);
  const resource = owner.get(1);
  owner.invalidate(1);
  expect(owner.get(1)).toBeUndefined();
  expect(owner.resource(1)).toBe(resource);
  expect(() => owner.attach([{ id: 1 }])).toThrow();
  expect(owner.dispose(1)).toBe(true);
  expect(owner.resource(1)).toBeUndefined();
  expect(clears).toBe(1);
});

for (const outcome of ["throw", "null", "invalid"] as const) {
  test(`${outcome} context never commits a visible owner or connection`, () => {
    const current = rig();
    register(current);
    const native =
      outcome === "invalid"
        ? ({} as OffscreenCanvas)
        : canvas(() => {
            if (outcome === "throw") throw new Error("native context failure");
            return null;
          });
    const original = open();
    receive(current, original, native);
    expect(Atomics.load(new Int32Array(original.control), 0)).toBe(-64);
    expect(current.service.snapshot()).toMatchObject({
      connections: 0,
      surfaces: 0,
      registeredSurfaces: 1,
    });
    const fresh = open(2);
    current.service.receive({ type: "open", grant: 2, open: fresh, surfaces: [{ id: 1 }] });
    expect(Atomics.load(new Int32Array(fresh.control), 0)).toBe(-64);
    current.service.receive({ type: "surface-dispose", id: 1 });
    current.drain();
    expect(current.service.snapshot().registeredSurfaces).toBe(0);
  });
}

for (const invalidIndex of [0, 1, 2]) {
  test(`partial multi-transfer preserves independent valid owners around bad member ${invalidIndex}`, () => {
    const current = rig();
    for (const id of [1, 2, 3]) register(current, id);
    const transfers = [1, 2, 3].map((id, index) => ({
      id,
      canvas: canvas(() => {
        if (index === invalidIndex) throw new Error("one invalid transfer");
        return { transferFromImageBitmap() {} };
      }),
    }));
    const original = open();
    current.service.receive({ type: "open", grant: 1, open: original, surfaces: transfers });
    expect(Atomics.load(new Int32Array(original.control), 0)).toBe(-64);
    expect(current.service.snapshot()).toMatchObject({ connections: 0, surfaces: 2 });
    const fresh = open(2);
    current.service.receive({
      type: "open",
      grant: 2,
      open: fresh,
      surfaces: transfers
        .filter((_value, index) => index !== invalidIndex)
        .map(({ id }) => ({ id })),
    });
    expect(Atomics.load(new Int32Array(fresh.control), 0)).toBe(1);
  });
}

test("malformed command envelope does not discard an independently valid surface", () => {
  const current = rig();
  register(current);
  const malformed = { ...open(), arena: new SharedArrayBuffer(64) };
  receive(
    current,
    malformed,
    canvas(() => ({ transferFromImageBitmap() {} })),
  );
  expect(current.service.snapshot()).toMatchObject({ connections: 0, surfaces: 1 });
  const fresh = open(2);
  current.service.receive({ type: "open", grant: 2, open: fresh, surfaces: [{ id: 1 }] });
  expect(Atomics.load(new Int32Array(fresh.control), 0)).toBe(1);
});

test("registration capacity includes pending identities without accumulating disposal history", () => {
  const owner = new GpuSurfaces();
  owner.register(1);
  for (let id = 2; id <= 16; id++) owner.register(id);
  expect(() => owner.register(17)).toThrow();
  for (let id = 2; id <= 16; id++) owner.dispose(id);
  for (let id = 17; id <= 128; id++) {
    owner.register(id);
    expect(owner.snapshot().registeredSurfaces).toBe(2);
    expect(owner.dispose(id)).toBe(true);
    expect(owner.dispose(id)).toBe(true);
  }
  owner.attach([{ id: 1, canvas: canvas(() => ({ transferFromImageBitmap() {} })) }]);
  expect(owner.snapshot()).toMatchObject({ registeredSurfaces: 1, surfaces: 1 });
  owner.dispose(1);
  expect(owner.snapshot().registeredSurfaces).toBe(0);
});

for (const id of [0, -1, 0x100000000, 1.5, NaN, Infinity]) {
  test(`invalid registration ${String(id)} consumes no ownership capacity`, () => {
    const owner = new GpuSurfaces();
    expect(() => owner.register(id)).toThrow();
    expect(owner.snapshot().registeredSurfaces).toBe(0);
  });
}

for (const boundary of ["close", "dispose", "close-and-dispose"] as const) {
  test(`service ${boundary} during attachment cannot publish or finish disposal inline`, async () => {
    const current = rig();
    register(current);
    const original = open(),
      frozen = transport(original);
    let clears = 0,
      disposed = false;
    let disposal: Promise<void> | undefined;
    receive(
      current,
      original,
      canvas(() => {
        if (boundary !== "dispose") current.readers.close();
        if (boundary !== "close") {
          disposal = current.service.dispose();
          void disposal.then(() => {
            disposed = true;
          });
          current.turn();
        }
        expect(disposed).toBe(false);
        expect(clears).toBe(0);
        return {
          transferFromImageBitmap() {
            clears++;
          },
        };
      }),
    );
    expect(current.service.snapshot().connections).toBe(0);
    expect(clears).toBe(1);
    if (boundary !== "dispose") expect(transport(original)).toEqual(frozen);
    current.drain();
    await disposal;
    if (disposal) expect(disposed).toBe(true);
    expect(current.service.snapshot().surfaces).toBe(0);
  });
}

for (const reason of [undefined, null, false, 0, "", new Error("bitmap clear failed")]) {
  test(`cleanup failure ${String(reason)} retains actual resources and rejects strong cleanup`, async () => {
    const current = rig();
    register(current);
    retire(current);
    let attempts = 0;
    const original = guarded(open());
    receive(
      current,
      original.envelope,
      canvas(() => ({
        transferFromImageBitmap() {
          attempts++;
          throw reason;
        },
      })),
    );
    current.service.receive({ type: "surface-dispose", id: 1 });
    current.drain();
    expect(current.service.snapshot()).toMatchObject({
      surfaces: 1,
      registeredSurfaces: 1,
      cleanupFailures: 1,
    });
    const result = current.service.dispose();
    current.drain();
    await expect(result).rejects.toThrow("GPU service cleanup retained");
    expect(current.service.snapshot().surfaces).toBe(1);
    expect(attempts).toBe(1);
    expect(original.reads()).toBe(0);
  });
}

test("reentrant disposal remains incomplete while native cleanup owns the resource", () => {
  const owner = new GpuSurfaces();
  owner.register(1);
  owner.attach([
    {
      id: 1,
      canvas: canvas(() => ({
        transferFromImageBitmap() {
          expect(owner.active).toBe(true);
          expect(owner.dispose(1)).toBe(false);
          expect(owner.resource(1)).toBeDefined();
          expect(owner.get(1)).toBeUndefined();
        },
      })),
    },
  ]);
  expect(owner.dispose(1)).toBe(true);
  expect(owner.resource(1)).toBeUndefined();
});

function replaceGlobal(name: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  cleanups.push(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  });
}
function pageRig(
  reenter: (where: "register" | "transfer", surface: DisplaySurface) => void = () => {},
) {
  replaceGlobal("document", {
    visibilityState: "visible",
    hasFocus: () => true,
    addEventListener() {},
    removeEventListener() {},
  });
  replaceGlobal("requestAnimationFrame", () => 1);
  replaceGlobal("cancelAnimationFrame", () => {});
  replaceGlobal("ResizeObserver", undefined);
  const messages: (GpuServiceRequest | ServiceBootstrap)[] = [];
  const history: string[] = [];
  let workers = 0,
    transfers = 0;
  const worker = {
    onerror: null,
    onmessageerror: null,
    onmessage: null as ((event: MessageEvent<GpuServiceReply>) => void) | null,
    postMessage(message: GpuServiceRequest | ServiceBootstrap) {
      messages.push(message);
      history.push(message.type);
      if (message.type === "surface-register") reenter("register", surface);
      if (message.type === "revoke")
        queueMicrotask(() =>
          worker.onmessage?.(
            new MessageEvent("message", { data: { type: "retired", grant: message.grant } }),
          ),
        );
    },
    terminate() {},
  };
  const owner = createDisplayOwner(() => {}, {
    commandBytes: 4096,
    completionBytes: 4096,
    worker: () => {
      workers++;
      return worker as unknown as Worker;
    },
  });
  const element = {
    width: 1,
    height: 1,
    transferControlToOffscreen() {
      history.push("transfer");
      transfers++;
      reenter("transfer", surface);
      return canvas(() => ({ transferFromImageBitmap() {} }));
    },
  } as unknown as HTMLCanvasElement;
  const surface = owner.display.createSurface(element);
  cleanups.push(() => owner.dispose());
  const grant = () => {
    const selected = owner.display.grant({ gpu: true, surfaces: [surface] });
    enrollGraphics(selected);
    cleanups.push(() => selected.connection.port.close());
    return selected;
  };
  return {
    owner,
    surface,
    messages,
    history,
    grant,
    workers: () => workers,
    transfers: () => transfers,
  };
}
const task = () => new Promise<void>((resolve) => setImmediate(resolve));

test("page enrollment is lazy and precedes exactly one native transfer across regrant", async () => {
  const current = pageRig();
  expect(current.workers()).toBe(0);
  const first = current.grant();
  expect(current.workers()).toBe(0);
  first.connection.port.postMessage(open());
  await task();
  expect(current.history).toEqual(["bootstrap", "surface-register", "transfer", "open"]);
  const initial = current.messages.find((message) => message.type === "open");
  expect(initial?.surfaces[0]?.canvas).toBeDefined();
  first.dispose();
  await first.retired();
  const second = current.grant();
  second.connection.port.postMessage(open(2));
  await task();
  const opens = current.messages.filter((message) => message.type === "open");
  expect(opens[1]?.surfaces).toEqual([{ id: current.surface.id }]);
  expect(current.messages.filter((message) => message.type === "surface-register")).toHaveLength(1);
  expect(current.transfers()).toBe(1);
  second.dispose();
  await second.retired();
  current.surface.dispose();
});

for (const boundary of ["register", "transfer"] as const) {
  test(`page disposal reentered during ${boundary} cannot send a later open or transfer again`, async () => {
    const current = pageRig((where, surface) => {
      if (where === boundary) surface.dispose();
    });
    const first = current.grant();
    first.connection.port.postMessage(open());
    await task();
    expect(current.messages.filter((message) => message.type === "surface-register")).toHaveLength(
      1,
    );
    expect(current.messages.filter((message) => message.type === "surface-dispose")).toHaveLength(
      1,
    );
    expect(current.messages.some((message) => message.type === "open")).toBe(false);
    expect(current.transfers()).toBe(boundary === "register" ? 0 : 1);
    expect(() => current.grant()).toThrow();
    await current.owner.dispose();
  });
}

for (const failureAt of ["frame", "context"] as const) {
  test(`failed presenter ${failureAt} teardown retains actual resources without retry`, () => {
    const failure = new Error("native presenter cleanup failed");
    let fail = false,
      destroys = 0,
      unconfigures = 0;
    class NativeTexture {
      destroy() {
        destroys++;
        if (fail && failureAt === "frame") throw failure;
      }
    }
    class NativeDevice {
      readonly lost = new Promise<never>(() => {});
      createTexture() {
        return new NativeTexture();
      }
    }
    class NativeContext {
      configure() {}
      unconfigure() {
        unconfigures++;
        if (fail && failureAt === "context") throw failure;
      }
    }
    class NativeCanvas {
      getContext() {
        return new NativeContext();
      }
    }
    replaceGlobal("GPUDevice", NativeDevice);
    replaceGlobal("GPUCanvasContext", NativeContext);
    replaceGlobal("OffscreenCanvas", NativeCanvas);
    const owner = new GpuSurfaces();
    owner.register(1);
    const visibleCanvas = canvas(() => ({ transferFromImageBitmap() {} }));
    owner.attach([{ id: 1, canvas: visibleCanvas }]);
    // Only native WebGPU objects are fixtures; the presenter and completion owner are real.
    const { connection } = coreRig({ root: {} });
    const surfaces = owner.connection([1], connection.completions);
    const reference = surfaces.create(1, "", { id: 1, generation: 1 });
    surfaces.configure(reference, {
      device: new NativeDevice(),
      width: 1,
      height: 1,
      format: "rgba8unorm",
      usage: 2,
      alphaMode: "opaque",
      viewFormats: [],
    });
    expect(surfaces.acquire(reference).kind).toBe("ready");
    const visible = owner.get(1),
      presenter = visible?.presenter,
      frame = presenter?.frame;
    fail = true;
    expect(() => owner.dispose(1)).toThrow(failure);
    expect(owner.get(1)).toBeUndefined();
    expect(owner.resource(1)).toBe(visible);
    expect(owner.resource(1)?.presenter).toBe(presenter);
    expect(owner.resource(1)?.presenter?.frame).toBe(failureAt === "frame" ? frame : undefined);
    expect(owner.snapshot()).toMatchObject({
      surfaces: 1,
      presentCanvasesLive: 1,
      frameTexturesLive: failureAt === "frame" ? 1 : 0,
    });
    expect(() => surfaces.dispose()).toThrow();
    expect(unconfigures).toBe(failureAt === "frame" ? 0 : 1);
    expect(destroys).toBe(2);
    expect(owner.failures).toEqual([failure]);
  });
}

test("service releases never-transferred identities synchronously without tombstone capacity", () => {
  const current = rig();
  register(current, 1);
  for (let id = 2; id <= 96; id++) {
    register(current, id);
    current.service.receive({ type: "surface-dispose", id });
    expect(current.service.snapshot().registeredSurfaces).toBe(1);
  }
  const original = open();
  receive(
    current,
    original,
    canvas(() => ({ transferFromImageBitmap() {} })),
  );
  expect(Atomics.load(new Int32Array(original.control), 0)).toBe(1);
});

test("malformed live envelope still ingests its canvas but never enters revoke settlement", () => {
  const current = rig();
  register(current);
  const malformed = { ...open(), arena: new SharedArrayBuffer(64) };
  const frozen = transport(malformed);
  receive(
    current,
    malformed,
    canvas(() => {
      current.service.receive({ type: "revoke", grant: 1 });
      current.turn();
      return { transferFromImageBitmap() {} };
    }),
  );
  current.drain();
  expect(current.service.snapshot()).toMatchObject({ connections: 0, surfaces: 1 });
  expect(transport(malformed)).toEqual(frozen);
  expect(current.replies).toEqual([{ type: "retired", grant: 1 }]);
});

for (const phase of ["sealed", "retired"] as const) {
  test(`duplicate and unknown transfers on ${phase} grants cannot replace or enroll assets`, () => {
    const current = rig();
    register(current);
    current.service.receive({ type: "revoke", grant: 1 });
    if (phase === "retired") current.drain();
    let attaches = 0,
      duplicates = 0;
    const native = canvas(() => {
      attaches++;
      return { transferFromImageBitmap() {} };
    });
    const original = guarded(open());
    receive(current, original.envelope, native);
    const duplicate = canvas(() => {
      duplicates++;
      return {};
    });
    receive(current, original.envelope, duplicate);
    receive(current, original.envelope, duplicate, 1, 99);
    expect(attaches).toBe(1);
    expect(duplicates).toBe(0);
    expect(original.reads()).toBe(0);
    expect(current.service.snapshot()).toMatchObject({ surfaces: 1, registeredSurfaces: 1 });
    const fresh = open(2);
    current.service.receive({ type: "open", grant: 2, open: fresh, surfaces: [{ id: 1 }] });
    expect(Atomics.load(new Int32Array(fresh.control), 0)).toBe(1);
  });
}

test("closed service denies even native-only late ownership ingestion and joins its admitted frame", async () => {
  const current = rig();
  register(current);
  let pending: Promise<unknown> | undefined,
    joined = false;
  const original = open(),
    frozen = transport(original);
  receive(
    current,
    original,
    canvas(() => {
      pending = current.readers
        .close()
        .join()
        .then(() => {
          joined = true;
        });
      expect(Atomics.load(new Int32Array(current.readers.bootstrap), 0)).toBeLessThan(-1);
      current.turn();
      expect(joined).toBe(false);
      return { transferFromImageBitmap() {} };
    }),
  );
  await pending;
  expect(joined).toBe(true);
  let calls = 0;
  receive(
    current,
    guarded(original).envelope,
    canvas(() => {
      calls++;
      return {};
    }),
    2,
  );
  expect(calls).toBe(0);
  expect(transport(original)).toEqual(frozen);
  expect(current.service.snapshot().surfaces).toBe(0);
});

test("cleanup failure while service disposal reenters attachment rejects with native assets retained", async () => {
  const current = rig();
  register(current);
  const original = open(),
    frozen = transport(original);
  let disposal: Promise<void> | undefined,
    attempts = 0;
  receive(
    current,
    original,
    canvas(() => {
      current.readers.close();
      disposal = current.service.dispose();
      current.turn();
      return {
        transferFromImageBitmap() {
          attempts++;
          throw new Error("cancelled attach cleanup failed");
        },
      };
    }),
  );
  if (!disposal) throw new Error("No reentrant disposal");
  await expect(disposal).rejects.toThrow("GPU service cleanup retained");
  expect(current.service.snapshot()).toMatchObject({
    connections: 0,
    surfaces: 1,
    registeredSurfaces: 1,
    cleanupFailures: 1,
  });
  expect(transport(original)).toEqual(frozen);
  expect(attempts).toBe(1);
});

for (const result of ["context", "throw", "null"] as const) {
  test(`direct reentrant disposal leaves no cancelled-attachment history after ${result}`, () => {
    const owner = new GpuSurfaces();
    owner.register(1);
    let clears = 0;
    const native = canvas(() => {
      expect(owner.dispose(1)).toBe(false);
      expect(owner.snapshot().registeredSurfaces).toBe(1);
      if (result === "throw") throw new Error("native context failed after disposal");
      if (result === "null") return null;
      return {
        transferFromImageBitmap() {
          clears++;
        },
      };
    });
    expect(() => owner.attach([{ id: 1, canvas: native }])).toThrow();
    expect(owner.snapshot()).toMatchObject({ surfaces: 0, registeredSurfaces: 0 });
    expect(clears).toBe(result === "context" ? 1 : 0);
  });
}
