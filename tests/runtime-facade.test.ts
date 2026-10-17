import { afterEach, beforeEach, expect, test } from "bun:test";
import { posix } from "node:path";
import { createRuntime, type Runtime, type RuntimeOptions } from "../index";
import { ProcessSupervisor } from "../proc/supervisor";
import type { ProcessContext } from "../proc/types";

const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const previousWorker = globalThis.Worker;
let runtimes: Runtime[];
let events: string[];
let ports: MessagePort[];

beforeEach(() => {
  runtimes = [];
  events = [];
  ports = [];
  globalThis.Worker = class {
    constructor() { events.push("filesystem:start"); }
    addEventListener() {}
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
  expect(Array.from(outputs.values()).some(output => Object.keys(output.inputs).some(path => path.endsWith("/interrupt/rewriter.ts")))).toBe(true);
});

test("cleanup errors still close the filesystem and release page ownership", async () => {
  const runtime = create({ processHost: processHost(async () => { throw new Error("consumer cleanup failed"); }) });
  await runtime.processes();
  await expect(runtime.dispose()).rejects.toThrow("consumer cleanup failed");
  expect(events.at(-1)).toBe("filesystem:stop");
  expect(create().disposed).toBe(false);
});
