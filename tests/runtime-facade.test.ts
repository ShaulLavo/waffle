import { afterEach, beforeEach, expect, test } from "bun:test";
import { posix } from "node:path";
import {
  createRuntime,
  type Runtime,
  type RuntimeOptions,
  type RuntimeConsumer,
} from "../index.js";
import { ProcessSupervisor } from "../proc/supervisor.js";
import {
  CONNECTION_SHARED_BYTES,
  FilesystemSection,
  type FilesystemConnection,
} from "../fs/protocol.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemService } from "../fs/service.js";
import type { ProcessContext } from "../proc/types.js";
import { runtimeStopControlPath } from "./fixtures/runtime-stop-control.js";

const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const previousWorker = globalThis.Worker;
let runtimes: Runtime[];
let events: string[];
let ports: MessagePort[];
let workerListeners: Map<string, EventListener[]>;

beforeEach(() => {
  runtimes = [];
  events = [];
  ports = [];
  workerListeners = new Map();
  globalThis.Worker = class {
    private service: FilesystemService;
    constructor() {
      events.push("filesystem:start");
      const backend = new MemoryBackend();
      for (const path of ["/app", "/first", "/later", "/snapshot"])
        backend.fs.writeFile(path, bytes);
      this.service = new FilesystemService(backend);
    }
    addEventListener(type: string, listener: EventListener) {
      let listeners = workerListeners.get(type);
      if (!listeners) workerListeners.set(type, (listeners = []));
      listeners.push(listener);
    }
    postMessage(message: { connect: FilesystemConnection }) {
      ports.push(message.connect.port);
      this.service.connect(message.connect);
    }
    terminate() {
      this.service.dispose();
      events.push("filesystem:stop");
    }
  } as unknown as typeof Worker;
});
afterEach(async () => {
  for (const runtime of runtimes) await runtime.dispose().catch(() => {});
  for (const port of ports) port.close();
  globalThis.Worker = previousWorker;
});
function create(options: RuntimeOptions = {}): Runtime {
  const runtime = createRuntime({
    filesystem: { workerURL: "https://example.test/filesystem.js", mode: "memory" },
    ...options,
  });
  runtimes.push(runtime);
  return runtime;
}
function processHost(dispose?: () => Promise<void>): NonNullable<RuntimeOptions["processHost"]> {
  return (options) => {
    events.push("process:start");
    const supervisor = new ProcessSupervisor({
      registry: options.registry,
      table: options.table,
      launch: options.launch,
    });
    let suspended = false;
    return {
      ready: async () => supervisor,
      suspend: () => {
        if (!suspended) {
          suspended = true;
          supervisor.dispose();
          events.push("process:outcomes");
        }
      },
      quiesce: async () => {},
      dispose: async () => {
        await dispose?.();
        events.push("process:stop");
      },
    } as Awaited<ReturnType<NonNullable<RuntimeOptions["processHost"]>>>;
  };
}

test("page guard uses the global stable symbol and remains held until disposal completes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = create({ processHost: processHost(() => gate) });
  expect(Reflect.get(globalThis, Symbol.for("waffle.runtime.owner"))).toBeDefined();
  expect(() => create()).toThrow(/live|owner|runtime/i);
  await runtime.processes();
  const pending = runtime.dispose();
  try {
    expect(runtime.disposed).toBe(true);
    expect(runtime.dispose()).toBe(pending);
    expect(() => create()).toThrow(/live|owner|runtime/i);
    expect(events).not.toContain("filesystem:stop");
  } finally {
    release();
  }
  await pending;
  expect(events.slice(-3)).toEqual(["process:outcomes", "process:stop", "filesystem:stop"]);
  const next = create();
  expect(next.disposed).toBe(false);
});

test("constructor failure releases the owner guard", () => {
  globalThis.Worker = class {
    constructor() {
      throw new Error("worker unavailable");
    }
  } as unknown as typeof Worker;
  expect(() => create()).toThrow("worker unavailable");
  globalThis.Worker = previousWorker;
  // The guard itself, not an available browser Worker, is what must be reset.
  expect(Object.prototype.hasOwnProperty.call(globalThis, Symbol.for("waffle.runtime.owner"))).toBe(
    false,
  );
});

function trackClosedPorts() {
  // The filesystem intentionally captures its native MessageChannel constructor. Observe the
  // native ports instead of replacing the guest-facing global constructor it must not use.
  const original = MessagePort.prototype.close;
  const closed = new Set<MessagePort>();
  MessagePort.prototype.close = function () {
    closed.add(this);
    original.call(this);
  };
  return {
    closed,
    restore: () => {
      MessagePort.prototype.close = original;
    },
  };
}

test("filesystem connection setup failure never leaves an unowned worker", () => {
  const original = globalThis.SharedArrayBuffer;
  try {
    globalThis.SharedArrayBuffer = new Proxy(original, {
      construct(target, args) {
        if (args[0] === CONNECTION_SHARED_BYTES) throw new Error("connection allocation failed");
        return Reflect.construct(target, args);
      },
    });
    expect(() => create()).toThrow("connection allocation failed");
    expect(events).toEqual([]);
  } finally {
    globalThis.SharedArrayBuffer = original;
  }
  expect(create().disposed).toBe(false);
});

test("filesystem Worker constructor failure closes both untransferred ports", () => {
  const original = globalThis.Worker;
  const tracked = trackClosedPorts();
  try {
    globalThis.Worker = class {
      constructor() {
        throw new Error("worker unavailable");
      }
    } as unknown as typeof Worker;
    expect(() => create()).toThrow("worker unavailable");
    expect(tracked.closed.size).toBe(2);
  } finally {
    tracked.restore();
    globalThis.Worker = original;
  }
  expect(create().disposed).toBe(false);
});

test("filesystem postMessage startup failure closes ports and terminates its worker", () => {
  const original = globalThis.Worker;
  const tracked = trackClosedPorts();
  try {
    globalThis.Worker = class {
      addEventListener() {}
      postMessage() {
        throw new Error("transfer failed");
      }
      terminate() {
        events.push("filesystem:stop");
      }
    } as unknown as typeof Worker;
    expect(() => create()).toThrow("transfer failed");
    expect(events).toEqual(["filesystem:stop"]);
    expect(tracked.closed.size).toBe(2);
  } finally {
    tracked.restore();
    globalThis.Worker = original;
  }
  expect(create().disposed).toBe(false);
});

test("shared runtime reports its browser capability requirement and releases failed ownership", () => {
  const previous = globalThis.SharedArrayBuffer;
  try {
    globalThis.SharedArrayBuffer = undefined as unknown as typeof SharedArrayBuffer;
    expect(() => create()).toThrow(/SharedArrayBuffer.*isolation/i);
  } finally {
    globalThis.SharedArrayBuffer = previous;
  }
  expect(create().disposed).toBe(false);
});

test("process activation is lazy, shared, and adopts the runtime identity allocator", async () => {
  let calls = 0;
  const factory = processHost();
  const runtime = create({
    processHost: (options) => {
      calls++;
      expect(options.table.identities).toBe(runtime.identities);
      return factory(options);
    },
  });
  runtime.registerAdapter("test", () => ({ terminate() {} }));
  runtime.registerProgram("/before", { adapter: "test", module: emptyModule, cooperative: true });
  expect(calls).toBe(0);
  const first = runtime.processes();
  expect(runtime.processes()).toBe(first);
  const service = await first;
  expect(calls).toBe(1);
  expect(await runtime.processes()).toBe(service);
  const supervisor = await service.ready();
  expect(supervisor.createRoot()).toBe(1);
  expect(supervisor.createRoot()).toBe(2);
  expect(runtime.identities.pid()).toBe(3);
  expect("dispose" in service).toBe(false);
  expect("dispose" in supervisor).toBe(false);
  expect("client" in runtime.filesystem).toBe(false);
  expect("dispose" in runtime.filesystem).toBe(false);
});

test("page filesystem writeFile supports atomic exclusive creation", async () => {
  const runtime = create();
  await runtime.filesystem.writeFile("/exclusive", "winner", { exclusive: true });
  try {
    await runtime.filesystem.writeFile("/exclusive", "clobber", { exclusive: true });
    throw new Error("exclusive file create unexpectedly succeeded");
  } catch (error) {
    expect(error).toMatchObject({ errno: 20 });
  }
  try {
    await runtime.filesystem.drain();
  } catch (error) {
    expect(error).toMatchObject({ errno: 20 });
  }

  await runtime.filesystem.mkdirp("/directory");
  try {
    await runtime.filesystem.writeFile("/directory", "not a directory", { exclusive: true });
    throw new Error("exclusive directory create unexpectedly succeeded");
  } catch (error) {
    expect(error).toMatchObject({ errno: 20 });
  }
  try {
    await runtime.filesystem.drain();
  } catch (error) {
    expect(error).toMatchObject({ errno: 20 });
  }

  const outcomes = await Promise.allSettled([
    runtime.filesystem.writeFile("/race", "first", { exclusive: true }),
    runtime.filesystem.writeFile("/race", "second", { exclusive: true }),
  ]);
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(outcomes.find((result) => result.status === "rejected")).toMatchObject({
    reason: { errno: 20 },
  });
  try {
    await runtime.filesystem.drain();
  } catch (error) {
    expect(error).toMatchObject({ errno: 20 });
  }
  expect(new TextDecoder().decode(await runtime.filesystem.readFile("/race"))).toMatch(
    /^(first|second)$/,
  );

  await runtime.filesystem.writeFile("/exclusive", "updated");
  expect(new TextDecoder().decode(await runtime.filesystem.readFile("/exclusive"))).toBe("updated");
  expect(() =>
    runtime.filesystem.writeFile("/invalid", "value", { append: true, exclusive: true }),
  ).toThrow("writeFile cannot append and create exclusively");
});

test("the public admission observer reaches the lazily activated process host unchanged", async () => {
  const onProcessAdmission: NonNullable<RuntimeOptions["onProcessAdmission"]> = () => {};
  const factory = processHost();
  let calls = 0;
  const runtime = create({
    onProcessAdmission,
    processHost: (options) => {
      calls++;
      expect(options.onProcessAdmission).toBe(onProcessAdmission);
      return factory(options);
    },
  });
  expect(calls).toBe(0);
  await runtime.processes();
  expect(calls).toBe(1);
});

test.each(["filesystem", "process", "supervisor"] as const)(
  "borrowed %s projection exposes no owner fields, descriptors, or prototype",
  async (name) => {
    const runtime = create();
    const service = await runtime.processes();
    const supervisor = await service.ready();
    const surfaces = {
      filesystem: {
        value: runtime.filesystem,
        hidden: [
          "worker",
          "client",
          "writes",
          "failure",
          "fatal",
          "fail",
          "assertLive",
          "request",
          "mutate",
          "dispose",
        ],
      },
      process: {
        value: service,
        hidden: [
          "options",
          "supervisor",
          "transport",
          "pipes",
          "controllers",
          "roots",
          "children",
          "activation",
          "suspend",
          "quiesce",
          "dispose",
        ],
      },
      supervisor: {
        value: supervisor,
        hidden: [
          "options",
          "listeners",
          "jobListeners",
          "finishing",
          "disposed",
          "launch",
          "finish",
          "terminate",
          "dispose",
        ],
      },
    };
    const { value, hidden } = surfaces[name];
    for (const key of hidden) {
      expect(Reflect.get(value, key) === undefined).toBe(true);
      expect(Reflect.has(value, key)).toBe(false);
      expect(Reflect.ownKeys(value).includes(key)).toBe(false);
      expect(Object.getOwnPropertyDescriptor(value, key)).toBeUndefined();
    }
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Reflect.has(value, "constructor")).toBe(false);
    expect(Object.isFrozen(value)).toBe(true);
  },
);

test("positive projections keep bound public methods, stable identity, and disposal admission checks", async () => {
  const runtime = create();
  const filesystem = runtime.filesystem;
  const createIdentity = Object.getOwnPropertyDescriptor(filesystem, "createIdentity")!
    .value as typeof filesystem.createIdentity;
  const identity = createIdentity.call(null);
  const sibling = filesystem.createIdentity();
  expect(identity.ownerStates).toBe(sibling.ownerStates);
  expect(identity.owner).not.toBe(sibling.owner);
  const service = await runtime.processes();
  const ready = Object.getOwnPropertyDescriptor(service, "ready")!.value as typeof service.ready;
  const supervisor = await ready.call(null);
  expect(await service.ready()).toBe(supervisor);
  expect(service.ready).toBe(ready);
  const reserved = service.reserveRoot({});
  const retainRoot = Object.getOwnPropertyDescriptor(service, "retainRoot")!
    .value as typeof service.retainRoot;
  const releaseRoot = retainRoot.call(null, reserved);
  expect(typeof releaseRoot).toBe("function");
  releaseRoot();
  releaseRoot();
  const createRoot = Object.getOwnPropertyDescriptor(supervisor, "createRoot")!
    .value as typeof supervisor.createRoot;
  const pid = createRoot.call(null);
  expect(supervisor.get(pid)?.pid).toBe(pid);
  expect(supervisor.table.identities).toBe(runtime.identities);
  expect(Reflect.set(filesystem, "worker", {})).toBe(false);
  expect(Reflect.defineProperty(service, "options", { value: {} })).toBe(false);
  expect(Reflect.deleteProperty(supervisor, "createRoot")).toBe(false);
  await filesystem.drain();
  await runtime.dispose();
  expect(() => createIdentity()).toThrow(/disposed/i);
  expect(() => createRoot()).toThrow(/disposed/i);
  expect(() => retainRoot(reserved)).toThrow(/disposed/i);
  await expect(ready()).rejects.toThrow(/disposed/i);
  await expect(filesystem.drain()).rejects.toThrow(/disposed/i);
});

test("program registration stays lazy and accepts new programs after activation", async () => {
  let loads = 0;
  const contexts: ProcessContext[] = [];
  const runtime = create({ processHost: processHost() });
  runtime.registerAdapter("test", (context) => {
    contexts.push(context);
    return { terminate() {} };
  });
  runtime.registerProgram("/first", {
    adapter: "test",
    source: () => {
      loads++;
      return bytes;
    },
  });
  expect(loads).toBe(0);
  const service = await runtime.processes();
  runtime.registerProgram("/later", { adapter: "test", module: emptyModule, cooperative: true });
  const supervisor = await service.ready();
  const root = supervisor.createRoot();
  const child = supervisor.reserveSpawn(root, {
    executable: "/later",
    argv: [],
    env: {},
    cwd: "/",
    job: 0,
    fds: [],
  });
  await supervisor.start(child);
  expect(contexts[0]?.module).toBe(emptyModule);
  const sourced = supervisor.reserveSpawn(root, {
    executable: "/first",
    argv: [],
    env: {},
    cwd: "/",
    job: 0,
    fds: [],
  });
  await supervisor.start(sourced);
  expect(loads).toBe(1);
  expect(contexts[1]?.module).toBeInstanceOf(WebAssembly.Module);
});

test.each(["source", "cooperative"] as const)(
  "program admission preserves %s interruption metadata in adapter context",
  async (admission) => {
    const contexts: ProcessContext[] = [];
    const runtime = create({ processHost: processHost() });
    runtime.registerAdapter("test", (context) => {
      contexts.push(context);
      return { terminate() {} };
    });
    // The same executable name in successive runtimes must not carry another admission's policy.
    runtime.registerProgram(
      "/app",
      admission === "source"
        ? { adapter: "test", source: bytes }
        : { adapter: "test", module: emptyModule, cooperative: true },
    );
    const supervisor = await (await runtime.processes()).ready();
    const root = supervisor.createRoot();
    const child = supervisor.reserveSpawn(root, {
      executable: "/app",
      argv: [],
      env: {},
      cwd: "/",
      job: 0,
      fds: [],
    });
    await supervisor.start(child);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.interruptible).toBe(admission === "source");
  },
);

test("duplicate program and adapter names and unknown adapters reject", () => {
  const runtime = create();
  runtime.registerAdapter("test", () => ({ terminate() {} }));
  expect(() => runtime.registerAdapter("test", () => ({ terminate() {} }))).toThrow(
    /duplicate|already/i,
  );
  runtime.registerProgram("/app", { adapter: "test", source: bytes });
  expect(() => runtime.registerProgram("/app", { adapter: "test", source: bytes })).toThrow(
    /duplicate|already/i,
  );
  expect(() => runtime.registerProgram("/missing", { adapter: "missing", source: bytes })).toThrow(
    /adapter/i,
  );
});

test("compiled modules require explicit cooperative trust and ambiguous admission rejects", () => {
  const runtime = create();
  runtime.registerAdapter("test", () => ({ terminate() {} }));
  const register = runtime.registerProgram as (name: string, program: unknown) => void;
  expect(() => register("/unsafe", { adapter: "test", module: emptyModule })).toThrow(
    /cooperative/i,
  );
  expect(() =>
    register("/false", { adapter: "test", module: emptyModule, cooperative: false }),
  ).toThrow(/cooperative/i);
  expect(() =>
    register("/both", { adapter: "test", module: emptyModule, source: bytes, cooperative: true }),
  ).toThrow(/source|module|ambiguous/i);
});

test("source admission snapshots borrowed bytes before the lazy loader starts", async () => {
  let registry: Parameters<NonNullable<RuntimeOptions["processHost"]>>[0]["registry"] | undefined;
  const factory = processHost();
  const runtime = create({
    processHost: (options) => {
      registry = options.registry;
      return factory(options);
    },
  });
  runtime.registerAdapter("test", () => ({ terminate() {} }));
  const source = bytes.slice();
  runtime.registerProgram("/snapshot", { adapter: "test", source });
  source.fill(255);
  await runtime.processes();
  expect((await registry!.resolve("/snapshot")).module).toBeInstanceOf(WebAssembly.Module);
});

test("disposal blocks previously borrowed capabilities and never activates unused processes", async () => {
  const runtime = create({
    processHost: () => {
      throw new Error("must stay lazy");
    },
  });
  const filesystem = runtime.filesystem;
  await runtime.dispose();
  expect(events).toEqual(["filesystem:start", "filesystem:stop"]);
  expect(() => runtime.registerAdapter("late", () => ({ terminate() {} }))).toThrow(/disposed/i);
  expect(() => runtime.registerProgram("/late", { adapter: "test", source: bytes })).toThrow(
    /disposed/i,
  );
  await expect(runtime.processes()).rejects.toThrow(/disposed/i);
  expect(() => filesystem.fork()).toThrow(/disposed/i);
  await expect(filesystem.writeFile("/late", "no")).rejects.toThrow(/disposed/i);
});

test("borrowed filesystem forwards its allowlisted ownership callback and preserves failure state", async () => {
  const runtime = create();
  let lost = 0;
  let receiver: unknown;
  const callback = function (this: unknown) {
    lost++;
    /* oxlint-disable typescript/no-this-alias -- Record the actual ownership callback receiver. */
    receiver = this;
    /* oxlint-enable typescript/no-this-alias */
  };
  runtime.filesystem.onOwnershipLost = callback;
  expect(runtime.filesystem.onOwnershipLost).toBe(callback);
  const event = new MessageEvent("message", { data: { type: "filesystem-ownership-lost" } });
  for (const listener of workerListeners.get("message") ?? []) listener(event);
  expect(lost).toBe(1);
  // A method-style callback must receive the borrowed projection, never the private owner.
  expect(receiver === runtime.filesystem).toBe(true);
  expect(runtime.filesystem.ownershipLost).toBe(true);
  expect(Reflect.set(runtime.filesystem, "ownershipLost", false)).toBe(false);
  expect(() => runtime.filesystem.fork()).toThrow(/another tab/i);
  await expect(runtime.filesystem.writeFile("/lost", "no")).rejects.toThrow(/another tab/i);
  await expect(runtime.dispose()).rejects.toThrow(/another tab/i);
  expect(() => {
    runtime.filesystem.onOwnershipLost = undefined;
  }).toThrow(/disposed/i);
  expect(create().disposed).toBe(false);
});

test("an activation racing disposal is awaited and cleaned before filesystem ownership closes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const factory = processHost();
  const runtime = create({
    processHost: async (options) => {
      await gate;
      return factory(options);
    },
  });
  const activating = runtime.processes();
  const rejected = activating.catch((error) => error);
  const disposal = runtime.dispose();
  release();
  expect(await rejected).toBeInstanceOf(Error);
  expect((await rejected).message).toMatch(/disposed/i);
  await disposal;
  expect(events.slice(-3)).toEqual(["process:outcomes", "process:stop", "filesystem:stop"]);
});

test("disposal owns late adapter launch completion and asynchronous handle termination", async () => {
  let releaseLaunch!: () => void;
  let releaseStop!: () => void;
  let entered!: () => void;
  let enteredStop!: () => void;
  const stopStarted = new Promise<void>((resolve) => {
    enteredStop = resolve;
  });
  const launching = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const launchGate = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  let stops = 0;
  const runtime = create({ processHost: processHost() });
  runtime.registerAdapter("delayed", async () => {
    entered();
    await launchGate;
    return {
      terminate: async () => {
        stops++;
        enteredStop();
        await stopGate;
      },
    };
  });
  runtime.registerProgram("/app", { adapter: "delayed", module: emptyModule, cooperative: true });
  const service = await runtime.processes();
  const supervisor = await service.ready();
  const root = supervisor.createRoot();
  const child = supervisor.reserveSpawn(root, {
    executable: "/app",
    argv: [],
    env: {},
    cwd: "/",
    job: 0,
    fds: [],
  });
  const starting = supervisor.start(child);
  await launching;
  const disposal = runtime.dispose();
  let finished = false;
  void disposal.then(() => {
    finished = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    expect(() => create()).toThrow(/live|owner|runtime/i);
    releaseLaunch();
    await starting;
    await stopStarted;
    expect(stops).toBe(1);
    expect(finished).toBe(false);
  } finally {
    releaseLaunch();
    releaseStop();
  }
  await disposal;
  expect(stops).toBe(1);
  expect(events.at(-1)).toBe("filesystem:stop");
});

test.each(["running", "late"] as const)(
  "disposal fences default-host filesystem sections before stopping a %s custom adapter",
  async (timing) => {
    const runtime = create();
    const identity = runtime.filesystem.createIdentity();
    let entered!: () => void;
    let releaseLaunch!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    let stops = 0;
    let active = false;
    let stoppedDuringSection = false;
    runtime.registerAdapter("test", async (context, service) => {
      service.registerController(context.pid, { filesystem: identity });
      entered();
      if (timing === "late") await launchGate;
      return {
        terminate() {
          stops++;
          stoppedDuringSection ||= active;
        },
      };
    });
    runtime.registerProgram("/app", { adapter: "test", module: emptyModule, cooperative: true });
    const supervisor = await (await runtime.processes()).ready();
    const root = supervisor.createRoot();
    const child = supervisor.reserveSpawn(root, {
      executable: "/app",
      argv: [],
      env: {},
      cwd: "/",
      job: 0,
      fds: [],
    });
    const starting = supervisor.start(child);
    await admitted;
    if (timing === "running") await starting;
    // Simulate another worker still inside an admitted storage critical section.
    const section = new FilesystemSection(identity);
    section.enter();
    active = true;
    const disposal = runtime.dispose();
    try {
      releaseLaunch();
      await starting;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stops).toBe(0);
      expect(events).not.toContain("filesystem:stop");
      expect(() => create()).toThrow(/live|owner|runtime/i);
    } finally {
      releaseLaunch();
      active = false;
      section.exit();
    }
    await disposal;
    expect(stops).toBe(1);
    expect(stoppedDuringSection).toBe(false);
    expect(events.at(-1)).toBe("filesystem:stop");
  },
);

test("a custom adapter can stop normally before page disposal without a disposal fence", async () => {
  let stops = 0;
  const runtime = create({ processHost: processHost() });
  runtime.registerAdapter("test", () => ({
    terminate() {
      stops++;
    },
  }));
  runtime.registerProgram("/app", { adapter: "test", module: emptyModule, cooperative: true });
  const supervisor = await (await runtime.processes()).ready();
  const root = supervisor.createRoot();
  const child = supervisor.reserveSpawn(root, {
    executable: "/app",
    argv: [],
    env: {},
    cwd: "/",
    job: 0,
    fds: [],
  });
  await supervisor.start(child);
  supervisor.exit(child, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stops).toBe(1);
  await runtime.dispose();
  expect(stops).toBe(1);
});

test("synchronous suspension callbacks observe the same already-published disposal promise", async () => {
  let nested: Promise<void> | undefined;
  const runtime = create();
  const service = await runtime.processes();
  service.reserveRoot(
    {},
    {
      revoke() {
        nested = runtime.dispose();
      },
    },
  );
  const disposal = runtime.dispose();
  expect(nested).toBe(disposal);
  await disposal;
  expect(events.filter((event) => event === "filesystem:stop")).toHaveLength(1);
});

test("a rejected disposal fence retains consumers, relays, filesystem ownership, and the page guard", async () => {
  // Fence failure intentionally retains ownership until the page is destroyed. Use an isolated
  // process as that page, then destroy it in finally rather than deleting a live owner's guard.
  const script = `
    import { createRing } from ${JSON.stringify(new URL("../browser/net/ring.ts", import.meta.url).href)};
    import { createRuntime } from ${JSON.stringify(new URL("../index.ts", import.meta.url).href)};
    import { ProcessSupervisor } from ${JSON.stringify(new URL("../proc/supervisor.ts", import.meta.url).href)};
    import { MemoryBackend } from ${JSON.stringify(new URL("../fs/backend.ts", import.meta.url).href)};
    import { FilesystemService } from ${JSON.stringify(new URL("../fs/service.ts", import.meta.url).href)};
    const backend = new MemoryBackend();
    backend.fs.writeFile("/app", new Uint8Array());
    const filesystem = new FilesystemService(backend);
    let filesystemStops = 0, consumerStops = 0, relayStops = 0, networkStops = 0;
    globalThis.Worker = class { addEventListener() {} postMessage(message) { filesystem.connect(message.connect); } terminate() { filesystem.dispose(); filesystemStops++; } };
    const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: "https://example.test/fs.js" }, processHost: options => {
      const supervisor = new ProcessSupervisor({ registry: options.registry, table: options.table, launch: options.launch });
      return { ready: async () => supervisor, suspend: () => supervisor.dispose(),
        quiesce: async () => { throw new Error("fence failed"); }, dispose: async () => { relayStops++; } };
    } });
    const network = await runtime.network();
    const helper = network.createHelper({ ring: createRing(), fetch: async () => { throw Error("Unexpected external fetch"); }, hooks: { stopped() { networkStops++; } } });
    helper.handle({ type: "tcp-listen", id: 1, port: 32146, host: "localhost", reply: new SharedArrayBuffer(12) });
    runtime.registerAdapter("test", () => ({ terminate() { consumerStops++; } }));
    runtime.registerProgram("/app", { adapter: "test", module: new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])), cooperative: true });
    const supervisor = await (await runtime.processes()).ready();
    const root = supervisor.createRoot();
    const child = supervisor.reserveSpawn(root, { executable: "/app", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
    await supervisor.start(child);
    const disposal = runtime.dispose();
    let error;
    try { await disposal; } catch (failure) { error = failure.message; }
    let guardHeld = false;
    try { createRuntime(); } catch (failure) { guardHeld = /live|owner|runtime/i.test(failure.message); }
    console.log(JSON.stringify({ error, filesystemStops, consumerStops, relayStops, networkStops, guardHeld, sameDisposal: runtime.dispose() === disposal }));
    process.exit(0);
  `;
  const page = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      page.exited,
      new Response(page.stdout).text(),
      new Response(page.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({
      error: "fence failed",
      filesystemStops: 0,
      consumerStops: 0,
      relayStops: 0,
      networkStops: 0,
      guardHeld: true,
      sameDisposal: true,
    });
  } finally {
    page.kill();
    await page.exited;
  }
});

test("adapter retention owns synchronous pre-service acceptance through the filesystem fence and async stop", async () => {
  let hostStarts = 0,
    cancels = 0,
    stops = 0;
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const runtime = create({
    processHost: (options) => {
      hostStarts++;
      return processHost()(options);
    },
  });
  const identity = runtime.filesystem.createIdentity();
  const section = new FilesystemSection(identity);
  let active = false,
    stoppedActive = false,
    settled = false;
  const consumer: RuntimeConsumer = {
    filesystem: identity,
    revoke() {
      cancels++;
    },
    async stop() {
      stops++;
      stoppedActive ||= active;
      await stopGate;
    },
  };
  const release = runtime.retainConsumer(consumer);
  section.enter();
  active = true;
  const disposal = runtime.dispose();
  void disposal.then(() => {
    settled = true;
  });
  try {
    expect(cancels).toBe(1);
    expect(hostStarts).toBe(0);
    release();
    release(); // A late handoff cannot erase an already-owned fence.
    await Bun.sleep(0);
    expect(stops).toBe(0);
    expect(events).not.toContain("filesystem:stop");
    expect(() => create()).toThrow(/live|owner|runtime/i);
    expect(() => runtime.retainConsumer(consumer)).toThrow(/disposed/i);
    active = false;
    section.exit();
    await Bun.sleep(0);
    expect(stops).toBe(1);
    expect(settled).toBe(false);
    expect(events).not.toContain("filesystem:stop");
  } finally {
    if (active) {
      active = false;
      section.exit();
    }
    releaseStop();
    await disposal;
  }
  expect(stoppedActive).toBe(false);
  expect(events.at(-1)).toBe("filesystem:stop");
});

test("retained adapter cancellation is reentrant and cannot release another disposal-owned consumer", async () => {
  const runtime = create();
  const first = runtime.filesystem.createIdentity(),
    second = runtime.filesystem.createIdentity();
  let nested: Promise<void> | undefined;
  const stopped: string[] = [];
  runtime.retainConsumer({
    filesystem: first,
    revoke() {
      nested = runtime.dispose();
      releaseSecond();
    },
    stop() {
      stopped.push("first");
    },
  });
  const releaseSecond = runtime.retainConsumer({
    filesystem: second,
    revoke() {
      events.push("second:cancel");
    },
    stop() {
      stopped.push("second");
    },
  });
  const section = new FilesystemSection(second);
  section.enter();
  const disposal = runtime.dispose();
  try {
    expect(nested).toBe(disposal);
    expect(events).toContain("second:cancel");
    await Bun.sleep(0);
    expect(stopped).toEqual([]);
    expect(events).not.toContain("filesystem:stop");
  } finally {
    section.exit();
  }
  await disposal;
  expect(stopped).toEqual(["first", "second"]);
});

test("adapter retention snapshots its identity and callbacks", async () => {
  const runtime = create();
  const identity = runtime.filesystem.createIdentity();
  const consumer: RuntimeConsumer = {
    filesystem: { ...identity },
    revoke() {
      events.push("original:cancel");
    },
    stop() {
      events.push("original:stop");
    },
  };
  runtime.retainConsumer(consumer);
  consumer.revoke = () => {
    throw new Error("replacement cancellation");
  };
  consumer.stop = () => {
    throw new Error("replacement stop");
  };
  consumer.filesystem.sections = new SharedArrayBuffer(0);
  const section = new FilesystemSection(identity);
  section.enter();
  const disposal = runtime.dispose();
  try {
    await Bun.sleep(0);
    expect(events).toContain("original:cancel");
    expect(events).not.toContain("original:stop");
    expect(events).not.toContain("filesystem:stop");
  } finally {
    section.exit();
  }
  await disposal;
  expect(events.slice(-2)).toEqual(["original:stop", "filesystem:stop"]);
});

test("a successful synchronous broker handoff releases only the temporary adapter retention", async () => {
  const runtime = create();
  const identity = runtime.filesystem.createIdentity();
  let cancels = 0,
    stops = 0;
  const consumer: RuntimeConsumer = {
    filesystem: identity,
    revoke() {
      cancels++;
    },
    stop() {
      stops++;
    },
  };
  const release = runtime.retainConsumer(consumer);
  const service = await runtime.processes();
  service.registerController(runtime.identities.pid(), consumer);
  release();
  release(); // Ownership has transferred only after the broker accepted the controller.
  const section = new FilesystemSection(identity);
  section.enter();
  const disposal = runtime.dispose();
  try {
    expect(cancels).toBe(1);
    await Bun.sleep(0);
    expect(stops).toBe(0);
    expect(events).not.toContain("filesystem:stop");
  } finally {
    section.exit();
  }
  await disposal;
  expect(stops).toBe(1);
});

test("failed lazy host activation cannot lose an accepted adapter consumer", async () => {
  const runtime = create({
    processHost: () => {
      throw new Error("host activation failed");
    },
  });
  const identity = runtime.filesystem.createIdentity();
  let cancels = 0,
    stops = 0;
  runtime.retainConsumer({
    filesystem: identity,
    revoke() {
      cancels++;
    },
    stop() {
      stops++;
    },
  });
  await expect(runtime.processes()).rejects.toThrow("host activation failed");
  const section = new FilesystemSection(identity);
  section.enter();
  const disposal = runtime.dispose();
  const result = disposal.catch((error) => error);
  try {
    expect(cancels).toBe(1);
    await Bun.sleep(0);
    expect(stops).toBe(0);
    expect(events).not.toContain("filesystem:stop");
  } finally {
    section.exit();
  }
  expect((await result).message).toBe("host activation failed");
  expect(stops).toBe(1);
  expect(events.at(-1)).toBe("filesystem:stop");
  expect(create().disposed).toBe(false);
});

test.each(["filesystem", "revoke", "stop"] as const)(
  "an adapter retention %s getter cannot admit a consumer behind reentrant disposal",
  async (field) => {
    const runtime = create();
    const identity = runtime.filesystem.createIdentity();
    let disposal: Promise<void> | undefined;
    const consumer: RuntimeConsumer = {
      filesystem: identity,
      revoke() {
        throw new Error("unadmitted revoke");
      },
      stop() {
        throw new Error("unadmitted stop");
      },
    };
    const value = consumer[field];
    Object.defineProperty(consumer, field, {
      get() {
        disposal = runtime.dispose();
        return value;
      },
    });
    expect(() => runtime.retainConsumer(consumer)).toThrow(/disposed/i);
    expect(disposal).toBe(runtime.dispose());
    await disposal;
    expect(events.at(-1)).toBe("filesystem:stop");
  },
);

test("a rejected retained-consumer fence fails closed even without process activation", async () => {
  const script = `
    import { createRuntime } from ${JSON.stringify(new URL("../index.ts", import.meta.url).href)};
    let filesystemStops = 0, consumerStops = 0, cancels = 0;
    const ports = [];
    globalThis.Worker = class { addEventListener() {} postMessage(message) { ports.push(message.connect.port); } terminate() { filesystemStops++; } };
    const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: "https://example.test/fs.js" } });
    const release = runtime.retainConsumer({ filesystem: { ...runtime.filesystem.createIdentity(), sections: new SharedArrayBuffer(0) },
      revoke() { cancels++; }, stop() { consumerStops++; } });
    const disposal = runtime.dispose();
    let fenceFailed = false;
    try { await disposal; } catch { fenceFailed = true; }
    release();
    let guardHeld = false;
    try { createRuntime(); } catch (failure) { guardHeld = /live|owner|runtime/i.test(failure.message); }
    console.log(JSON.stringify({ fenceFailed, filesystemStops, consumerStops, cancels, guardHeld, sameDisposal: runtime.dispose() === disposal }));
    for (const port of ports) port.close();
    process.exit(0);
  `;
  const page = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      page.exited,
      new Response(page.stdout).text(),
      new Response(page.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({
      fenceFailed: true,
      filesystemStops: 0,
      consumerStops: 0,
      cancels: 1,
      guardHeld: true,
      sameDisposal: true,
    });
  } finally {
    page.kill();
    await page.exited;
  }
});

test("facade initial browser graph keeps process services and interrupt compilation lazy", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../index.ts", import.meta.url).pathname],
    target: "browser",
    splitting: true,
    metafile: true,
  });
  expect(result.success).toBe(true);
  const outputs = new Map(
    Object.entries(result.metafile!.outputs).map(([path, output]) => [
      posix.normalize(path),
      output,
    ]),
  );
  const root = Array.from(outputs).find(
    ([, output]) =>
      output.entryPoint !== undefined && posix.basename(output.entryPoint) === "index.ts",
  )?.[0];
  expect(root).toBeDefined();
  const initial = new Set<string>();
  function visit(path: string): void {
    if (initial.has(path)) return;
    initial.add(path);
    const output = outputs.get(path)!;
    for (const imported of output.imports) {
      if (imported.kind === "dynamic-import" || ("external" in imported && imported.external))
        continue;
      visit(posix.normalize(posix.join(posix.dirname(path), imported.path)));
    }
  }
  visit(root!);
  const inputs = Array.from(initial).flatMap((path) => Object.keys(outputs.get(path)!.inputs));
  const processInputs = inputs.filter(
    (path) =>
      /(?:^|\/)proc\//.test(path) &&
      !/(?:^|\/)proc\/(?:errors|intrinsics\/(?:core|host))\.ts$/.test(path) &&
      !/(?:^|\/)(identity|stub|outcome|signals|control|types|intrinsics)\.ts$/.test(path),
  );
  expect(processInputs).toEqual([]);
  expect(inputs.filter((path) => /(?:^|\/)(?:network|native)\//.test(path))).toEqual([]);
  expect(
    inputs.filter((path) => /browser\/net\/(?:module|namespace|runtime)\.ts$/.test(path)),
  ).toEqual([]);
  const modules = Object.keys(result.metafile!.inputs);
  expect(modules.some((path) => /network\.wasm|native\/|socket2/.test(path))).toBe(false);
  expect(inputs.filter((path) => /(?:^|\/)interrupt\//.test(path))).toEqual([]);
  expect(
    Array.from(outputs.values()).some((output) =>
      Object.keys(output.inputs).some((path) => path.endsWith("proc/supervisor.ts")),
    ),
  ).toBe(true);
  expect(
    Array.from(outputs.values()).some((output) =>
      Object.keys(output.inputs).some((path) => path.endsWith("interrupt/rewriter-internal.ts")),
    ),
  ).toBe(true);
});

test.each([
  ["consumer", "error"],
  ["inactive", "error"],
  ["consumer", "undefined"],
  ["consumer", "null"],
  ["consumer", "false"],
  ["consumer", "zero"],
  ["consumer", "empty"],
  ["consumer", "object"],
  ["sync", "undefined"],
  ["multiple", "undefined"],
  ["adapter", "error"],
  ["late", "error"],
  ["host", "error"],
  ["success", "error"],
])("physical stop ownership survives %s with %s rejection", async (mode, reason) => {
  const page = Bun.spawn([process.execPath, runtimeStopControlPath, mode, reason], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 3000,
    killSignal: "SIGKILL",
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      page.exited,
      new Response(page.stdout).text(),
      new Response(page.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const success = mode === "success";
    const consumer =
      mode === "consumer" ||
      mode === "inactive" ||
      mode === "sync" ||
      mode === "multiple" ||
      success;
    expect(JSON.parse(stdout)).toEqual({
      rejected: !success,
      sameFailure: !success,
      sameRejection: !success,
      sameDisposal: true,
      retainedWhilePending: true,
      guardHeld: !success,
      sameToken: !success,
      events: (consumer ? ["consumer:revoke"] : []).concat(
        ["sibling:revoke"],
        consumer ? ["consumer:stop"] : [],
        ["sibling:stop"],
        mode === "adapter" || mode === "late" ? ["adapter:stop"] : [],
        mode === "inactive" ? [] : ["host:stop"],
        success ? ["filesystem:stop", "filesystem:stop"] : [],
      ),
    });
  } finally {
    page.kill();
    await page.exited;
  }
});

test("registration leases remove unused programs and adapters without activating process services or loaders", async () => {
  let activations = 0,
    loads = 0;
  const factory = processHost();
  let registry: Parameters<NonNullable<RuntimeOptions["processHost"]>>[0]["registry"] | undefined;
  const runtime = create({
    processHost: (options) => {
      activations++;
      registry = options.registry;
      return factory(options);
    },
  });
  const unregisterAdapter = runtime.registerAdapter("test", () => ({ terminate() {} }));
  const unregisterProgram = runtime.registerProgram("/app", {
    adapter: "test",
    source: () => {
      loads++;
      return bytes;
    },
  });
  expect(typeof unregisterAdapter).toBe("function");
  expect(typeof unregisterProgram).toBe("function");
  unregisterProgram();
  unregisterProgram();
  unregisterAdapter();
  unregisterAdapter();
  expect(activations).toBe(0);
  expect(loads).toBe(0);
  expect(events).toEqual(["filesystem:start"]);
  expect(() =>
    runtime.registerProgram("/unknown", {
      adapter: "test",
      module: emptyModule,
      cooperative: true,
    }),
  ).toThrow(/adapter/i);
  await runtime.processes();
  expect(registry!.has("/app")).toBe(false);
  expect(loads).toBe(0);
});

for (const reuseDefinition of [false, true])
  test(`old leases never remove replacements using the same launcher (same program object=${reuseDefinition})`, async () => {
    let launches = 0;
    const launcher = () => {
      launches++;
      return { terminate() {} };
    };
    let registry: Parameters<NonNullable<RuntimeOptions["processHost"]>>[0]["registry"] | undefined;
    const factory = processHost();
    const runtime = create({
      processHost: (options) => {
        registry = options.registry;
        return factory(options);
      },
    });
    const removeAdapter = runtime.registerAdapter("test", launcher);
    const definition = { adapter: "test", module: emptyModule, cooperative: true } as const;
    const removeProgram = runtime.registerProgram("/app", definition);
    const service = await runtime.processes();
    removeProgram();
    removeAdapter();
    expect(registry!.has("/app")).toBe(false);
    const replacement = reuseDefinition ? emptyModule : new WebAssembly.Module(bytes);
    const removeNewAdapter = runtime.registerAdapter("test", launcher);
    const removeNewProgram = runtime.registerProgram(
      "/app",
      reuseDefinition ? definition : { ...definition, module: replacement },
    );
    removeAdapter();
    removeProgram();
    expect((await registry!.resolve("/app")).module).toBe(replacement);
    const supervisor = await service.ready();
    const root = supervisor.createRoot();
    const child = supervisor.reserveSpawn(root, {
      executable: "/app",
      argv: [],
      env: {},
      cwd: "/",
      job: 0,
      fds: [],
    });
    await supervisor.start(child);
    expect(launches).toBe(1);
    removeNewProgram();
    removeNewAdapter();
    expect(registry!.has("/app")).toBe(false);
    expect(() =>
      runtime.registerProgram("/unknown", {
        adapter: "test",
        module: emptyModule,
        cooperative: true,
      }),
    ).toThrow(/adapter/i);
  });

test("unregistering programs and adapters leaves running and accepted launch handles with their original launcher", async () => {
  let entered!: () => void, release!: () => void;
  const launched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const admission = new Promise<void>((resolve) => {
    release = resolve;
  });
  const contexts: ProcessContext[] = [];
  const stops: string[] = [];
  const runtime = create({ processHost: processHost() });
  const removeAdapter = runtime.registerAdapter("test", async (context) => {
    contexts.push(context);
    entered();
    await admission;
    return {
      terminate() {
        stops.push("original");
      },
    };
  });
  const removeProgram = runtime.registerProgram("/app", {
    adapter: "test",
    module: emptyModule,
    cooperative: true,
  });
  const supervisor = await (await runtime.processes()).ready();
  const root = supervisor.createRoot();
  const request = { executable: "/app", argv: [], env: {}, cwd: "/", job: 0, fds: [] };
  const original = supervisor.reserveSpawn(root, request);
  const starting = supervisor.start(original);
  try {
    await launched;
    removeProgram();
    removeAdapter();
    const removeReplacementAdapter = runtime.registerAdapter("test", (context) => {
      contexts.push(context);
      return {
        terminate() {
          stops.push("replacement");
        },
      };
    });
    const removeReplacementProgram = runtime.registerProgram("/app", {
      adapter: "test",
      module: emptyModule,
      cooperative: true,
    });
    const replacement = supervisor.reserveSpawn(root, request);
    await supervisor.start(replacement);
    removeProgram();
    removeAdapter();
    removeReplacementProgram();
    removeReplacementAdapter();
    expect(stops).toEqual([]);
    release();
    await starting;
    expect(supervisor.get(original)?.result).toBeNull();
    expect(supervisor.get(replacement)?.result).toBeNull();
    contexts[0]!.exit(7);
    contexts[1]!.exit(8);
    expect((await supervisor.waitForExit(root, original)).status).toBe(7);
    expect((await supervisor.waitForExit(root, replacement)).status).toBe(8);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(stops).toEqual(["original", "replacement"]);
  } finally {
    release();
    await starting;
  }
});

test("registration lease release is harmless after disposal, including leases not released earlier", async () => {
  const runtime = create();
  const unregisterAdapter = runtime.registerAdapter("test", () => ({ terminate() {} }));
  const unregisterProgram = runtime.registerProgram("/app", {
    adapter: "test",
    module: emptyModule,
    cooperative: true,
  });
  await runtime.dispose();
  const before = events.slice();
  expect(() => {
    unregisterProgram();
    unregisterAdapter();
    unregisterProgram();
    unregisterAdapter();
  }).not.toThrow();
  expect(events).toEqual(before);
});

test.each(["bun", "bin/bun", "/", "/bin/../bun", "/bin/./bun", "/bin//bun", "/bin/bun/"])(
  "program registration rejects noncanonical path %s clearly",
  (name) => {
    const runtime = create();
    runtime.registerAdapter("test", () => ({ terminate() {} }));
    expect(() =>
      runtime.registerProgram(name, { adapter: "test", module: emptyModule, cooperative: true }),
    ).toThrow(/absolute canonical file path/);
  },
);

test("runtime spawn and PATH metadata agree on live canonical executable files", async () => {
  const runtime = create();
  let launches = 0,
    loads = 0;
  runtime.registerAdapter("test", (context) => {
    launches++;
    context.exit(17);
    return { terminate() {} };
  });
  await runtime.filesystem.writeFile("/bin/test-guest", "registered guest");
  runtime.registerProgram("/bin/test-guest", {
    adapter: "test",
    module: () => {
      loads++;
      return emptyModule;
    },
    cooperative: true,
  });
  const supervisor = await (await runtime.processes()).ready();
  const root = supervisor.createRoot();
  async function spawn(executable: string, cwd = "/") {
    const child = supervisor.reserveSpawn(root, {
      executable,
      argv: [],
      env: {},
      cwd,
      job: 0,
      fds: [],
    });
    await supervisor.start(child);
    return supervisor.waitForExit(root, child);
  }
  const bin = await runtime.filesystem.lookup("/bin");
  if (bin?.kind !== "dir") throw new Error("expected /bin directory");
  expect(bin.children.get("test-guest")?.kind).toBe("file");
  expect(await spawn("./test-guest", "/bin")).toEqual({ kind: "exited", code: 17, status: 17 });
  expect(await spawn("/bin/../bin/./test-guest")).toEqual({ kind: "exited", code: 17, status: 17 });
  await runtime.filesystem.remove("/bin/test-guest");
  expect(await spawn("/bin/test-guest")).toEqual({
    kind: "start-failed",
    code: 2,
    error: "ENOENT",
    status: null,
  });
  await runtime.filesystem.mkdirp("/bin/test-guest");
  expect(await spawn("/bin/test-guest")).toEqual({
    kind: "start-failed",
    code: 13,
    error: "EACCES",
    status: null,
  });
  await runtime.filesystem.writeFile("/bin/unregistered", "not executable");
  expect(await spawn("/bin/unregistered")).toEqual({
    kind: "start-failed",
    code: 13,
    error: "EACCES",
    status: null,
  });
  expect(launches).toBe(2);
  expect(loads).toBe(1);
});

for (const [executable, error, code] of [
  ["/bin/test-guest/", "ENOTDIR", 20],
  ["/missing/../bin/test-guest", "ENOENT", 2],
  ["/bin/test-guest/../test-guest", "ENOTDIR", 20],
] as const)
  test(`runtime preserves real filesystem traversal constraints for ${executable}`, async () => {
    const runtime = create();
    let loads = 0,
      launches = 0;
    runtime.registerAdapter("test", (context) => {
      launches++;
      context.exit(0);
      return { terminate() {} };
    });
    await runtime.filesystem.writeFile("/bin/test-guest", "registered guest");
    runtime.registerProgram("/bin/test-guest", {
      adapter: "test",
      module: () => {
        loads++;
        return emptyModule;
      },
      cooperative: true,
    });
    const supervisor = await (await runtime.processes()).ready();
    const root = supervisor.createRoot();
    const pid = supervisor.reserveSpawn(root, {
      executable,
      argv: [],
      env: {},
      cwd: "/",
      job: 0,
      fds: [],
    });
    await supervisor.start(pid);
    expect(await supervisor.waitForExit(root, pid)).toEqual({
      kind: "start-failed",
      code,
      error,
      status: null,
    });
    expect(loads).toBe(0);
    expect(launches).toBe(0);
  });

test("an unrelated failed mutation cannot reject a later valid executable admission", async () => {
  const runtime = create({ processHost: processHost() });
  let loads = 0;
  runtime.registerAdapter("test", (context) => {
    context.exit(23);
    return { terminate() {} };
  });
  await runtime.filesystem.writeFile("/bin/test-guest", "registered guest");
  runtime.registerProgram("/bin/test-guest", {
    adapter: "test",
    module: () => {
      loads++;
      return emptyModule;
    },
    cooperative: true,
  });
  // Explicit catch avoids an unexplained Bun matcher hang in this full-runtime context.
  let failure: unknown;
  try {
    await runtime.filesystem.writeFile("/bin", "cannot replace directory");
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  const supervisor = await (await runtime.processes()).ready();
  const root = supervisor.createRoot();
  const pid = supervisor.reserveSpawn(root, {
    executable: "/bin/test-guest",
    argv: [],
    env: {},
    cwd: "/",
    job: 0,
    fds: [],
  });
  await supervisor.start(pid);
  expect(await supervisor.waitForExit(root, pid)).toEqual({ kind: "exited", code: 23, status: 23 });
  expect(loads).toBe(1);
  // Admission orders writes but must not consume errors owned by the explicit drain API.
  await expect(runtime.filesystem.drain()).rejects.toThrow();
  await runtime.filesystem.drain();
});

test("source registrations compile once across concurrent spawns and replace by lease", async () => {
  const modules: WebAssembly.Module[] = [];
  let loads = 0;
  const runtime = create({ processHost: processHost() });
  runtime.registerAdapter("test", (context) => {
    modules.push(context.module);
    new WebAssembly.Instance(context.module, { runtime_proc: { interrupted: () => 0 } });
    context.started();
    context.exit(0);
    return { terminate() {} };
  });
  const register = (source: Uint8Array) =>
    runtime.registerProgram("/app", {
      adapter: "test",
      source: () => {
        loads++;
        return source;
      },
    });
  const remove = register(bytes);
  const supervisor = await (await runtime.processes()).ready();
  const root = supervisor.createRoot();
  const spawn = async () => {
    const pid = supervisor.reserveSpawn(root, {
      executable: "/app",
      argv: [],
      env: {},
      cwd: "/",
      job: -1,
      fds: [],
    });
    await supervisor.start(pid);
    expect(await supervisor.waitForExit(root, pid)).toMatchObject({ kind: "exited", code: 0 });
  };
  await Promise.all([spawn(), spawn()]);
  await spawn();
  expect(loads).toBe(1);
  expect(modules[1]).toBe(modules[0]);
  expect(modules[2]).toBe(modules[0]);
  remove();
  register(new Uint8Array(Array.from(bytes).concat([0, 2, 1, 120])));
  await spawn();
  expect(loads).toBe(2);
  expect(modules[3]).not.toBe(modules[0]);
  remove();
  await spawn();
  expect(loads).toBe(2);
  expect(modules[4]).toBe(modules[3]);
});
