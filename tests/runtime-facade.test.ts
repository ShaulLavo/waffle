import { afterEach, beforeEach, expect, test } from "bun:test";
import { posix } from "node:path";
import { createRuntime, type Runtime, type RuntimeOptions } from "../index";
import { ProcessSupervisor } from "../proc/supervisor";
import { FilesystemSection } from "../fs/protocol";
import type { ProcessContext } from "../proc/types";

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
    constructor() { events.push("filesystem:start"); }
    addEventListener(type: string, listener: EventListener) {
      let listeners = workerListeners.get(type);
      if (!listeners) workerListeners.set(type, listeners = []);
      listeners.push(listener);
    }
    postMessage(message: { connect: { port: MessagePort } }) { ports.push(message.connect.port); }
    terminate() { events.push("filesystem:stop"); }
  } as unknown as typeof Worker;
});
afterEach(async () => {
  for (const runtime of runtimes) await runtime.dispose().catch(() => {});
  for (const port of ports) port.close();
  globalThis.Worker = previousWorker;
});
function create(options: RuntimeOptions = {}): Runtime {
  const runtime = createRuntime({ filesystem: { workerURL: "https://example.test/filesystem.js", persistence: false }, ...options });
  runtimes.push(runtime);
  return runtime;
}
function processHost(dispose?: () => Promise<void>): NonNullable<RuntimeOptions["processHost"]> {
  return options => {
    events.push("process:start");
    const supervisor = new ProcessSupervisor({ registry: options.registry, table: options.table, launch: options.launch });
    let suspended = false;
    return {
      ready: async () => supervisor,
      suspend: () => { if (!suspended) { suspended = true; supervisor.dispose(); events.push("process:outcomes"); } },
      quiesce: async () => {},
      dispose: async () => { await dispose?.(); events.push("process:stop"); },
    } as Awaited<ReturnType<NonNullable<RuntimeOptions["processHost"]>>>;
  };
}

test("page guard uses the global stable symbol and remains held until disposal completes", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = create({ processHost: processHost(() => gate) });
  expect(globalThis[Symbol.for("waffle.runtime.owner") as keyof typeof globalThis]).toBeDefined();
  expect(() => create()).toThrow(/live|owner|runtime/i);
  await runtime.processes();
  const pending = runtime.dispose();
  try {
    expect(runtime.disposed).toBe(true);
    expect(runtime.dispose()).toBe(pending);
    expect(() => create()).toThrow(/live|owner|runtime/i);
    expect(events).not.toContain("filesystem:stop");
  } finally { release(); }
  await pending;
  expect(events.slice(-3)).toEqual(["process:outcomes", "process:stop", "filesystem:stop"]);
  const next = create();
  expect(next.disposed).toBe(false);
});

test("constructor failure releases the owner guard", () => {
  globalThis.Worker = class { constructor() { throw new Error("worker unavailable"); } } as unknown as typeof Worker;
  expect(() => create()).toThrow("worker unavailable");
  globalThis.Worker = previousWorker;
  // The guard itself, not an available browser Worker, is what must be reset.
  expect(Object.prototype.hasOwnProperty.call(globalThis, Symbol.for("waffle.runtime.owner"))).toBe(false);
});

function trackClosedPorts() {
  // The filesystem intentionally captures its native MessageChannel constructor. Observe the
  // native ports instead of replacing the guest-facing global constructor it must not use.
  const original = MessagePort.prototype.close;
  const closed = new Set<MessagePort>();
  MessagePort.prototype.close = function () { closed.add(this); original.call(this); };
  return { closed, restore: () => { MessagePort.prototype.close = original; } };
}

test("filesystem connection setup failure never leaves an unowned worker", () => {
  const original = globalThis.SharedArrayBuffer;
  try {
    globalThis.SharedArrayBuffer = new Proxy(original, { construct(target, args) {
      if (args[0] === 24 * 1024 * 1024) throw new Error("connection allocation failed");
      return Reflect.construct(target, args);
    } });
    expect(() => create()).toThrow("connection allocation failed");
    expect(events).toEqual([]);
  } finally { globalThis.SharedArrayBuffer = original; }
  expect(create().disposed).toBe(false);
});

test("filesystem Worker constructor failure closes both untransferred ports", () => {
  const original = globalThis.Worker;
  const tracked = trackClosedPorts();
  try {
    globalThis.Worker = class { constructor() { throw new Error("worker unavailable"); } } as unknown as typeof Worker;
    expect(() => create()).toThrow("worker unavailable");
    expect(tracked.closed.size).toBe(2);
  } finally { tracked.restore(); globalThis.Worker = original; }
  expect(create().disposed).toBe(false);
});

test("filesystem postMessage startup failure closes ports and terminates its worker", () => {
  const original = globalThis.Worker;
  const tracked = trackClosedPorts();
  try {
    globalThis.Worker = class {
      addEventListener() {}
      postMessage() { throw new Error("transfer failed"); }
      terminate() { events.push("filesystem:stop"); }
    } as unknown as typeof Worker;
    expect(() => create()).toThrow("transfer failed");
    expect(events).toEqual(["filesystem:stop"]);
    expect(tracked.closed.size).toBe(2);
  } finally { tracked.restore(); globalThis.Worker = original; }
  expect(create().disposed).toBe(false);
});

test("shared runtime reports its browser capability requirement and releases failed ownership", () => {
  const previous = globalThis.SharedArrayBuffer;
  try {
    globalThis.SharedArrayBuffer = undefined as unknown as typeof SharedArrayBuffer;
    expect(() => create()).toThrow(/SharedArrayBuffer.*isolation/i);
  } finally { globalThis.SharedArrayBuffer = previous; }
  expect(create().disposed).toBe(false);
});

test("process activation is lazy, shared, and adopts the runtime identity allocator", async () => {
  let calls = 0;
  const factory = processHost();
  const runtime = create({ processHost: options => { calls++; expect(options.table.identities).toBe(runtime.identities); return factory(options); } });
  runtime.registerAdapter("test", () => ({ terminate() {} }));
  runtime.registerProgram("before", { adapter: "test", module: emptyModule, cooperative: true });
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

test.each(["filesystem", "process", "supervisor"] as const)("borrowed %s projection exposes no owner fields, descriptors, or prototype", async name => {
  const runtime = create();
  const service = await runtime.processes();
  const supervisor = await service.ready();
  const surfaces = {
    filesystem: { value: runtime.filesystem, hidden: ["worker", "client", "writes", "failure", "fatal", "fail", "assertLive", "request", "mutate", "dispose"] },
    process: { value: service, hidden: ["options", "supervisor", "transport", "pipes", "controllers", "roots", "children", "activation", "suspend", "quiesce", "dispose"] },
    supervisor: { value: supervisor, hidden: ["options", "listeners", "jobListeners", "finishing", "disposed", "launch", "finish", "terminate", "dispose"] },
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
});

test("positive projections keep bound public methods, stable identity, and disposal admission checks", async () => {
  const runtime = create();
  const filesystem = runtime.filesystem;
  const createIdentity = Object.getOwnPropertyDescriptor(filesystem, "createIdentity")!.value as typeof filesystem.createIdentity;
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
  const retainRoot = Object.getOwnPropertyDescriptor(service, "retainRoot")!.value as typeof service.retainRoot;
  const releaseRoot = retainRoot.call(null, reserved);
  expect(typeof releaseRoot).toBe("function");
  releaseRoot();
  releaseRoot();
  const createRoot = Object.getOwnPropertyDescriptor(supervisor, "createRoot")!.value as typeof supervisor.createRoot;
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
  runtime.registerAdapter("test", context => { contexts.push(context); return { terminate() {} }; });
  runtime.registerProgram("first", { adapter: "test", source: () => { loads++; return bytes; } });
  expect(loads).toBe(0);
  const service = await runtime.processes();
  runtime.registerProgram("later", { adapter: "test", module: emptyModule, cooperative: true });
  const supervisor = await service.ready();
  const root = supervisor.createRoot();
  const child = supervisor.reserveSpawn(root, { executable: "later", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
  await supervisor.start(child);
  expect(contexts[0]?.module).toBe(emptyModule);
  const sourced = supervisor.reserveSpawn(root, { executable: "first", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
  await supervisor.start(sourced);
  expect(loads).toBe(1);
  expect(contexts[1]?.module).toBeInstanceOf(WebAssembly.Module);
});

test.each(["source", "cooperative"] as const)("program admission preserves %s interruption metadata in adapter context", async admission => {
  const contexts: ProcessContext[] = [];
  const runtime = create({ processHost: processHost() });
  runtime.registerAdapter("test", context => { contexts.push(context); return { terminate() {} }; });
  // The same executable name in successive runtimes must not carry another admission's policy.
  runtime.registerProgram("app", admission === "source"
    ? { adapter: "test", source: bytes }
    : { adapter: "test", module: emptyModule, cooperative: true });
  const supervisor = await (await runtime.processes()).ready();
  const root = supervisor.createRoot();
  const child = supervisor.reserveSpawn(root, { executable: "app", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
  await supervisor.start(child);
  expect(contexts).toHaveLength(1);
  expect(contexts[0]!.interruptible).toBe(admission === "source");
});

test("duplicate program and adapter names and unknown adapters reject", () => {
  const runtime = create();
  runtime.registerAdapter("test", () => ({ terminate() {} }));
  expect(() => runtime.registerAdapter("test", () => ({ terminate() {} }))).toThrow(/duplicate|already/i);
  runtime.registerProgram("app", { adapter: "test", source: bytes });
  expect(() => runtime.registerProgram("app", { adapter: "test", source: bytes })).toThrow(/duplicate|already/i);
  expect(() => runtime.registerProgram("missing", { adapter: "missing", source: bytes })).toThrow(/adapter/i);
});

test("compiled modules require explicit cooperative trust and ambiguous admission rejects", () => {
  const runtime = create();
  runtime.registerAdapter("test", () => ({ terminate() {} }));
  const register = runtime.registerProgram as (name: string, program: unknown) => void;
  expect(() => register("unsafe", { adapter: "test", module: emptyModule })).toThrow(/cooperative/i);
  expect(() => register("false", { adapter: "test", module: emptyModule, cooperative: false })).toThrow(/cooperative/i);
  expect(() => register("both", { adapter: "test", module: emptyModule, source: bytes, cooperative: true })).toThrow(/source|module|ambiguous/i);
});

test("source admission snapshots borrowed bytes before the lazy loader starts", async () => {
  let registry: Parameters<NonNullable<RuntimeOptions["processHost"]>>[0]["registry"] | undefined;
  const factory = processHost();
  const runtime = create({ processHost: options => { registry = options.registry; return factory(options); } });
  runtime.registerAdapter("test", () => ({ terminate() {} }));
  const source = bytes.slice();
  runtime.registerProgram("snapshot", { adapter: "test", source });
  source.fill(255);
  await runtime.processes();
  expect((await registry!.resolve("snapshot")).module).toBeInstanceOf(WebAssembly.Module);
});

test("disposal blocks previously borrowed capabilities and never activates unused processes", async () => {
  const runtime = create({ processHost: () => { throw new Error("must stay lazy"); } });
  const filesystem = runtime.filesystem;
  await runtime.dispose();
  expect(events).toEqual(["filesystem:start", "filesystem:stop"]);
  expect(() => runtime.registerAdapter("late", () => ({ terminate() {} }))).toThrow(/disposed/i);
  expect(() => runtime.registerProgram("late", { adapter: "test", source: bytes })).toThrow(/disposed/i);
  await expect(runtime.processes()).rejects.toThrow(/disposed/i);
  expect(() => filesystem.fork()).toThrow(/disposed/i);
  await expect(filesystem.writeFile("/late", "no")).rejects.toThrow(/disposed/i);
});

test("borrowed filesystem forwards its allowlisted ownership callback and preserves failure state", async () => {
  const runtime = create();
  let lost = 0;
  let receiver: unknown;
  const callback = function (this: unknown) { lost++; receiver = this; };
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
  expect(() => { runtime.filesystem.onOwnershipLost = undefined; }).toThrow(/disposed/i);
  expect(create().disposed).toBe(false);
});

test("an activation racing disposal is awaited and cleaned before filesystem ownership closes", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const factory = processHost();
  const runtime = create({ processHost: async options => { await gate; return factory(options); } });
  const activating = runtime.processes();
  const rejected = activating.catch(error => error);
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
  const stopStarted = new Promise<void>(resolve => { enteredStop = resolve; });
  const launching = new Promise<void>(resolve => { entered = resolve; });
  const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve; });
  const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
  let stops = 0;
  const runtime = create({ processHost: processHost() });
  runtime.registerAdapter("delayed", async () => {
    entered();
    await launchGate;
    return { terminate: async () => { stops++; enteredStop(); await stopGate; } };
  });
  runtime.registerProgram("app", { adapter: "delayed", module: emptyModule, cooperative: true });
  const service = await runtime.processes();
  const supervisor = await service.ready();
  const root = supervisor.createRoot();
  const child = supervisor.reserveSpawn(root, { executable: "app", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
  const starting = supervisor.start(child);
  await launching;
  const disposal = runtime.dispose();
  let finished = false;
  void disposal.then(() => { finished = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    expect(() => create()).toThrow(/live|owner|runtime/i);
    releaseLaunch();
    await starting;
    await stopStarted;
    expect(stops).toBe(1);
    expect(finished).toBe(false);
  } finally { releaseLaunch(); releaseStop(); }
  await disposal;
  expect(stops).toBe(1);
  expect(events.at(-1)).toBe("filesystem:stop");
});

test.each(["running", "late"] as const)("disposal fences default-host filesystem sections before stopping a %s custom adapter", async timing => {
  const runtime = create();
  const identity = runtime.filesystem.createIdentity();
  let entered!: () => void;
  let releaseLaunch!: () => void;
  const admitted = new Promise<void>(resolve => { entered = resolve; });
  const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve; });
  let stops = 0;
  let active = false;
  let stoppedDuringSection = false;
  runtime.registerAdapter("test", async (context, service) => {
    service.registerController(context.pid, { filesystem: identity });
    entered();
    if (timing === "late") await launchGate;
    return { terminate() { stops++; stoppedDuringSection ||= active; } };
  });
  runtime.registerProgram("app", { adapter: "test", module: emptyModule, cooperative: true });
  const supervisor = await (await runtime.processes()).ready();
  const root = supervisor.createRoot();
  const child = supervisor.reserveSpawn(root, { executable: "app", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
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
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(stops).toBe(0);
    expect(events).not.toContain("filesystem:stop");
    expect(() => create()).toThrow(/live|owner|runtime/i);
  } finally { releaseLaunch(); active = false; section.exit(); }
  await disposal;
  expect(stops).toBe(1);
  expect(stoppedDuringSection).toBe(false);
  expect(events.at(-1)).toBe("filesystem:stop");
});

test("a custom adapter can stop normally before page disposal without a disposal fence", async () => {
  let stops = 0;
  const runtime = create({ processHost: processHost() });
  runtime.registerAdapter("test", () => ({ terminate() { stops++; } }));
  runtime.registerProgram("app", { adapter: "test", module: emptyModule, cooperative: true });
  const supervisor = await (await runtime.processes()).ready();
  const root = supervisor.createRoot();
  const child = supervisor.reserveSpawn(root, { executable: "app", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
  await supervisor.start(child);
  supervisor.exit(child, 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(stops).toBe(1);
  await runtime.dispose();
  expect(stops).toBe(1);
});

test("synchronous suspension callbacks observe the same already-published disposal promise", async () => {
  let nested: Promise<void> | undefined;
  const runtime = create();
  const service = await runtime.processes();
  service.reserveRoot({}, { revoke() { nested = runtime.dispose(); } });
  const disposal = runtime.dispose();
  expect(nested).toBe(disposal);
  await disposal;
  expect(events.filter(event => event === "filesystem:stop")).toHaveLength(1);
});

test("a rejected disposal fence retains consumers, relays, filesystem ownership, and the page guard", async () => {
  // Fence failure intentionally retains ownership until the page is destroyed. Use an isolated
  // process as that page, then destroy it in finally rather than deleting a live owner's guard.
  const script = `
    import { createRuntime } from ${JSON.stringify(new URL("../index.ts", import.meta.url).href)};
    import { ProcessSupervisor } from ${JSON.stringify(new URL("../proc/supervisor.ts", import.meta.url).href)};
    let filesystemStops = 0, consumerStops = 0, relayStops = 0;
    globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() { filesystemStops++; } };
    const runtime = createRuntime({ filesystem: { persistence: false, workerURL: "https://example.test/fs.js" }, processHost: options => {
      const supervisor = new ProcessSupervisor({ registry: options.registry, table: options.table, launch: options.launch });
      return { ready: async () => supervisor, suspend: () => supervisor.dispose(),
        quiesce: async () => { throw new Error("fence failed"); }, dispose: async () => { relayStops++; } };
    } });
    runtime.registerAdapter("test", () => ({ terminate() { consumerStops++; } }));
    runtime.registerProgram("app", { adapter: "test", module: new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])), cooperative: true });
    const supervisor = await (await runtime.processes()).ready();
    const root = supervisor.createRoot();
    const child = supervisor.reserveSpawn(root, { executable: "app", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
    await supervisor.start(child);
    const disposal = runtime.dispose();
    let error;
    try { await disposal; } catch (failure) { error = failure.message; }
    let guardHeld = false;
    try { createRuntime(); } catch (failure) { guardHeld = /live|owner|runtime/i.test(failure.message); }
    console.log(JSON.stringify({ error, filesystemStops, consumerStops, relayStops, guardHeld, sameDisposal: runtime.dispose() === disposal }));
    process.exit(0);
  `;
  const page = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([page.exited, new Response(page.stdout).text(), new Response(page.stderr).text()]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ error: "fence failed", filesystemStops: 0, consumerStops: 0, relayStops: 0, guardHeld: true, sameDisposal: true });
  } finally { page.kill(); await page.exited; }
});

test("facade initial browser graph keeps process services and interrupt compilation lazy", async () => {
  const result = await Bun.build({ entrypoints: [new URL("../index.ts", import.meta.url).pathname], target: "browser", splitting: true, metafile: true });
  expect(result.success).toBe(true);
  const outputs = new Map(Object.entries(result.metafile!.outputs).map(([path, output]) => [posix.normalize(path), output]));
  const root = Array.from(outputs).find(([, output]) => output.entryPoint !== undefined && posix.basename(output.entryPoint) === "index.ts")?.[0];
  expect(root).toBeDefined();
  const initial = new Set<string>();
  function visit(path: string): void {
    if (initial.has(path)) return;
    initial.add(path);
    const output = outputs.get(path)!;
    for (const imported of output.imports) {
      if (imported.kind === "dynamic-import" || imported.external) continue;
      visit(posix.normalize(posix.join(posix.dirname(path), imported.path)));
    }
  }
  visit(root!);
  const inputs = Array.from(initial).flatMap(path => Object.keys(outputs.get(path)!.inputs));
  const processInputs = inputs.filter(path => /(?:^|\/)proc\//.test(path) && !/(?:^|\/)(identity|stub|outcome|signals|types)\.ts$/.test(path));
  expect(processInputs).toEqual([]);
  expect(inputs.filter(path => /(?:^|\/)interrupt\//.test(path))).toEqual([]);
  expect(Array.from(outputs.values()).some(output => Object.keys(output.inputs).some(path => path.endsWith("proc/supervisor.ts")))).toBe(true);
  expect(Array.from(outputs.values()).some(output => Object.keys(output.inputs).some(path => path.endsWith("interrupt/rewriter.ts")))).toBe(true);
});

test("cleanup errors still close the filesystem and release page ownership", async () => {
  const runtime = create({ processHost: processHost(async () => { throw new Error("consumer cleanup failed"); }) });
  await runtime.processes();
  await expect(runtime.dispose()).rejects.toThrow("consumer cleanup failed");
  expect(events.at(-1)).toBe("filesystem:stop");
  expect(create().disposed).toBe(false);
});
