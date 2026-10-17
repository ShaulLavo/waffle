import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { claimOutcome, outcomeWord, readOutcome } from "../../runtime/proc/outcome.ts";
import { createSignalState, publishSignal, setSignalDisposition } from "../../runtime/proc/signals.ts";
import { SharedPipe, SubprocessHost, childTransport, wasiPipe, type ChildTransport } from "../src/subprocess.ts";
import type { RunRequest, WorkerMessage } from "../src/worker.ts";
import type { Stream } from "../../runtime/core/descriptors.ts";
import { DefaultSignal } from "../src/default-signal.ts";

// Execute the actual worker lifecycle with host boundaries injected, without replacing runner globals.
const source = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(
  readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, ""),
);

type ProcImports = { signal(signal: number, mode: number): number; interrupted(): number; default_signal(signal: number): never };
type EngineOptions = { onExit(code: number): void; fetch(input: string): Promise<Response> };
type WasiBoundary = { stdio?: Partial<Record<0 | 1 | 2, Stream>>; stdout(data: Uint8Array): void; stderr(data: Uint8Array): void };
class TestWasiExit extends Error { constructor(readonly code: number) { super("exit"); } }

async function run(options: {
  adapter?: RunRequest["adapter"];
  instantiateError?: boolean;
  onMessage?(message: WorkerMessage): void;
  onSubprocess?(host: SubprocessHost): void;
  child?: ChildTransport;
  isolated?: boolean;
  signalState?: SharedArrayBuffer;
  outcome?: SharedArrayBuffer;
  interrupt?: SharedArrayBuffer;
  requestedSignal?: SharedArrayBuffer;
  launch?(proc: ProcImports, io: WasiBoundary): number | null;
  engine?(proc: ProcImports, engine: EngineOptions, dispatch: (type: string, error: unknown) => boolean, io: WasiBoundary): Promise<number> | number;
} = {}) {
  const messages: WorkerMessage[] = [];
  const events: string[] = [];
  const fetchCalls: string[] = [];
  const listeners = new Map<string, (event: any) => void>();
  let proc!: ProcImports;
  let io!: WasiBoundary;
  let revoked = false;
  const filesystem = { revocations: [] };
  const context = {
    crossOriginIsolated: options.isolated ?? true,
    location: { href: "https://example.test/worker.js" },
    postMessage(message: WorkerMessage) { messages.push(message); options.onMessage?.(message); },
    addEventListener(type: string, callback: (event: any) => void) { listeners.set(type, callback); },
    removeEventListener(type: string) { listeners.delete(type); },
    fetch(input: string) {
      if (this !== context) throw new Error("lost native fetch receiver");
      fetchCalls.push(input);
      return Promise.resolve(new Response("ok"));
    },
    onmessage: undefined as unknown as (event: { data: RunRequest }) => Promise<void>,
  };
  const outcome = options.outcome ?? (options.isolated === false ? undefined : new SharedArrayBuffer(8));
  const request = {
    engine: "browser", adapter: options.adapter, module: {}, args: ["fixture"], env: {},
    filesystem, trace: false, net: null, moduleCache: null, slots: "off", child: options.child,
    signalState: options.signalState, outcome, interrupt: options.interrupt, requestedSignal: options.requestedSignal,
  } as unknown as RunRequest;
  const memory = new WebAssembly.Memory({ initial: 1 });
  runInNewContext(source, {
    self: context, performance, Response, TextEncoder, TextDecoder, URL, console, Error,
    SharedArrayBuffer: options.isolated === false ? undefined : SharedArrayBuffer, Atomics, Int32Array, BigInt64Array,
    WebAssembly: {
      Memory: WebAssembly.Memory,
      Instance: class {
        exports = { memory, _start() {}, bunwasm_ready: () => 1 };
        constructor() { if (options.instantiateError) throw new Error("instantiate diagnostic"); }
      },
    },
    FilesystemClient: class {
      connection = filesystem;
      dispose() { events.push("dispose fs"); }
    },
    revokeFilesystem() { revoked = true; events.push("revoke"); },
    sharedRevoked: () => () => revoked,
    createFilesystemIdentity() { throw new Error("unexpected spawn"); },
    SubprocessHost: class extends SubprocessHost {
      constructor(hostOptions: ConstructorParameters<typeof SubprocessHost>[0]) {
        super(hostOptions);
        options.onSubprocess?.(this);
      }
    },
    childTransport, wasiPipe,
    claimOutcome, outcomeWord, readOutcome,
    HOST_CALL_FD: 3,
    WasiExit: TestWasiExit,
    DefaultSignal,
    Wasi: class {
      descriptors = { dispose() { events.push("dispose descriptors"); } };
      constructor(opts: WasiBoundary & { namespaces: { runtime_proc: ProcImports } }) { proc = opts.namespaces.runtime_proc; io = opts; }
      imports() { return {}; }
      launch() { return options.launch?.(proc, io) ?? null; }
    },
    async startEngineHost(engine: EngineOptions) {
      const dispatch = (type: string, error: unknown) => {
        let prevented = false;
        listeners.get(type)?.({ error, reason: error, preventDefault() { prevented = true; } });
        return prevented;
      };
      return await options.engine?.(proc, engine, dispatch, io) ?? 0;
    },
  });
  await context.onmessage({ data: request });
  return { messages, events, fetchCalls, outcome, revoked, proc };
}

function exits(messages: WorkerMessage[]) {
  return messages.filter(message => message.type === "exit" || message.type === "error");
}

test("preview1 signal imports share the adopted pending queue, not the legacy wake word", async () => {
  const state = createSignalState();
  setSignalDisposition(state, 15, 2);
  publishSignal(state, 15);
  const interrupt = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(interrupt), 0, 9);
  const result = await run({
    adapter: "preview1", signalState: state.buffer as SharedArrayBuffer, interrupt,
    launch(proc) {
      expect(proc.interrupted()).toBe(15);
      expect(proc.signal(0, 0)).toBe(0);
      expect(proc.signal(13, 2)).toBe(0);
      publishSignal(state, 13);
      expect(proc.signal(0, 0)).toBe(13);
      expect(proc.interrupted()).toBe(0);
      return 23;
    },
  });
  expect(exits(result.messages)).toEqual([{ type: "exit", code: 23, signal: undefined, sleep: "atomics" }]);
  expect(readOutcome(outcomeWord(result.outcome!))).toMatchObject({ kind: "exited", code: 23 });
});

for (const via of ["raise", "default", "restore"] as const) test(`caught ${via} cannot overwrite a synchronously claimed root signal outcome`, async () => {
  const outcome = new SharedArrayBuffer(8);
  let atCatch: ReturnType<typeof readOutcome> = null;
  const result = await run({
    outcome,
    engine(proc, engine) {
      if (via === "restore") {
        proc.signal(15, 2);
        proc.signal(15, 3);
      }
      try { via === "raise" ? proc.signal(15, 3) : via === "restore" ? proc.signal(15, 0) : proc.default_signal(15); }
      catch { atCatch = readOutcome(outcomeWord(outcome)); }
      engine.onExit(0);
      return 0;
    },
  });
  expect(atCatch).toMatchObject({ kind: "signaled", code: 15 });
  expect(result.events[0]).toBe("revoke");
  expect(result.revoked).toBe(true);
  expect(exits(result.messages)).toEqual([{ type: "exit", code: 143, signal: 15, sleep: "atomics" }]);
});

for (const type of ["error", "unhandledrejection"]) test(`asynchronous DefaultSignal is handled on ${type}`, async () => {
  let prevented = false;
  const result = await run({
    engine(proc, _engine, dispatch) {
      try { proc.default_signal(13); }
      catch (error) { prevented = dispatch(type, error); }
      return 0;
    },
  });
  expect(prevented).toBe(true);
  expect(exits(result.messages)).toEqual([{ type: "exit", code: 141, signal: 13, sleep: "atomics" }]);
});

test("force-default accepts the complete signal ABI even when its disposition is ignore", async () => {
  const result = await run({
    launch(proc) {
      expect(proc.signal(64, 1)).toBe(0);
      return proc.default_signal(64);
    },
  });
  expect(exits(result.messages)).toEqual([{ type: "exit", code: 192, signal: 64, sleep: "atomics" }]);
});

test("a signal winner also replaces a later unrelated asynchronous error", async () => {
  const result = await run({
    engine(proc) {
      try { proc.default_signal(15); } catch {}
      throw new Error("guest caught the terminal signal first");
    },
  });
  expect(exits(result.messages)).toEqual([{ type: "exit", code: 143, signal: 15, sleep: "atomics" }]);
});

test("child completion posts the adopted winner rather than its stale own exit", async () => {
  let transport!: ChildTransport;
  const parent = new SubprocessHost({ output() {}, launch(_meta, child) { transport = child; return { terminate() {} }; } });
  try {
    parent.spawn(JSON.stringify({ argv: ["fixture"] }));
    claimOutcome(outcomeWord(transport.outcome), { kind: "signaled", code: 9 });
    const result = await run({ child: transport, adapter: "preview1", launch: () => 0 });
    expect(exits(result.messages)).toEqual([{ type: "exit", code: 137, signal: 9, sleep: "atomics" }]);
    expect(Atomics.load(new Int32Array(transport.control), 1)).toBe(137);
  } finally { parent.dispose(); }
});

test("child signal registration and interrupted use the child's adopted state", async () => {
  let transport!: ChildTransport;
  const parent = new SubprocessHost({ output() {}, launch(_meta, child) { transport = child; return { terminate() {} }; } });
  try {
    parent.spawn(JSON.stringify({ argv: ["fixture"] }));
    const state = createSignalState(transport.signalState);
    setSignalDisposition(state, 2, 2);
    publishSignal(state, 2);
    let delivered = 0;
    const result = await run({ child: transport, adapter: "preview1", launch(proc) { delivered = proc.interrupted(); return 23; } });
    expect(delivered).toBe(2);
    expect(exits(result.messages)).toEqual([{ type: "exit", code: 23, signal: undefined, sleep: "atomics" }]);
  } finally { parent.dispose(); }
});

for (const checkpoint of ["interrupted", "signal"] as const) for (const signal of [9, 15]) {
  test(`${checkpoint} observes an already selected fatal signal ${signal} before dequeuing`, async () => {
    const outcome = new SharedArrayBuffer(8);
    claimOutcome(outcomeWord(outcome), { kind: "signaled", code: signal });
    const state = createSignalState();
    setSignalDisposition(state, 2, 2);
    publishSignal(state, 2);
    let returned = false;
    const result = await run({
      outcome, signalState: state.buffer as SharedArrayBuffer, adapter: "preview1",
      launch(proc) {
        checkpoint === "interrupted" ? proc.interrupted() : proc.signal(0, 0);
        returned = true;
        return 0;
      },
    });
    expect(returned).toBe(false);
    expect(result.revoked).toBe(true);
    expect(exits(result.messages)).toEqual([{ type: "exit", code: 128 + signal, signal, sleep: "atomics" }]);
    expect(Atomics.load(state, 2)).toBe(6);
  });
}

test("a root's already claimed ordinary exit wins a later forced default", async () => {
  const outcome = new SharedArrayBuffer(8);
  claimOutcome(outcomeWord(outcome), { kind: "exited", code: 23 });
  const result = await run({ outcome, launch: proc => proc.default_signal(15) });
  expect(exits(result.messages)).toEqual([{ type: "exit", code: 23, signal: undefined, sleep: "atomics" }]);
});

test("an adopted SIGKILL audit wins a later forced default", async () => {
  const requestedSignal = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(requestedSignal), 0, 9);
  const result = await run({ requestedSignal, launch: proc => proc.default_signal(15) });
  expect(exits(result.messages)).toEqual([{ type: "exit", code: 137, signal: 9, sleep: "atomics" }]);
});

test("a child that catches its fatal unwind cannot consume stdin or publish stdio before broker cleanup", async () => {
  let transport!: ChildTransport;
  const parent = new SubprocessHost({ output() {}, launch(_meta, child) { transport = child; return { terminate() {} }; } });
  const blocked: number[] = [];
  try {
    parent.spawn(JSON.stringify({ argv: ["fixture"] }));
    const pipes = childTransport(transport);
    const input = new Uint8Array([1, 2, 3]);
    pipes.stdin.write(input);
    const result = await run({
      child: transport, adapter: "preview1",
      launch(proc, io) {
        try { proc.default_signal(15); } catch {}
        const output = new Uint8Array([4, 5, 6]);
        const attempts = [
          () => io.stdout(output), () => io.stderr(output),
          () => io.stdio![1]!.write([output]), () => io.stdio![2]!.write([output]),
          () => io.stdio![0]!.read([new Uint8Array(3)]),
          () => io.stdio![0]!.readiness(), () => io.stdio![1]!.readiness(),
        ];
        for (const attempt of attempts) {
          try { attempt(); } catch (error) { blocked.push((error as { signal: number }).signal); }
        }
        return 0;
      },
    });
    expect(blocked).toEqual(new Array(7).fill(15));
    expect(pipes.stdin.read(16)).toEqual(input);
    expect(pipes.stdout.read(16)).toBe(0);
    expect(pipes.stderr.read(16)).toBe(0);
    expect(exits(result.messages)).toEqual([{ type: "exit", code: 143, signal: 15, sleep: "atomics" }]);
  } finally { parent.dispose(); }
});

for (const kind of ["exited", "signaled"] as const) test(`root stdio cannot publish after an authoritative ${kind} decision`, async () => {
  const outcome = new SharedArrayBuffer(8);
  const code = kind === "exited" ? 23 : 15;
  const blocked: number[] = [];
  const result = await run({
    outcome, adapter: "preview1",
    launch(_proc, io) {
      claimOutcome(outcomeWord(outcome), { kind, code });
      for (const write of [io.stdout, io.stderr]) {
        try { write(new Uint8Array([1, 2, 3])); }
        catch (error) { blocked.push(kind === "exited" ? (error as TestWasiExit).code : (error as { signal: number }).signal); }
      }
      return 0;
    },
  });
  expect(blocked).toEqual([code, code]);
  expect(result.messages.filter(message => message.type === "stdout" || message.type === "stderr")).toEqual([]);
  expect(exits(result.messages)).toEqual([{ type: "exit", code: kind === "exited" ? code : 128 + code, signal: kind === "signaled" ? code : undefined, sleep: "atomics" }]);
});

test("live child stdio works without consuming handled pending signals", async () => {
  let transport!: ChildTransport;
  const parent = new SubprocessHost({ output() {}, launch(_meta, child) { transport = child; return { terminate() {} }; } });
  let count = 0;
  const input = new Uint8Array([1, 2, 3]);
  const output = new Uint8Array([4, 5, 6]);
  const read = new Uint8Array(3);
  try {
    parent.spawn(JSON.stringify({ argv: ["fixture"] }));
    const state = createSignalState(transport.signalState);
    setSignalDisposition(state, 2, 2);
    publishSignal(state, 2);
    const pipes = childTransport(transport);
    pipes.stdin.write(input);
    const result = await run({
      child: transport, adapter: "preview1",
      launch(_proc, io) {
        count += io.stdio![0]!.read([read]);
        count += io.stdio![1]!.write([output]);
        io.stderr(output);
        return 23;
      },
    });
    expect(count).toBe(6);
    expect(read).toEqual(input);
    expect(pipes.stdout.read(16)).toEqual(output);
    expect(pipes.stderr.read(16)).toEqual(output);
    expect(Atomics.load(state, 2)).toBe(6);
    expect(exits(result.messages)).toEqual([{ type: "exit", code: 23, signal: undefined, sleep: "atomics" }]);
  } finally { parent.dispose(); }
});

for (const kind of ["exited", "signaled"] as const) test(`browser fetch cannot start after an authoritative ${kind} decision`, async () => {
  const outcome = new SharedArrayBuffer(8);
  const code = kind === "exited" ? 23 : 15;
  let blocked: number | undefined;
  const result = await run({
    outcome,
    async engine(_proc, engine) {
      claimOutcome(outcomeWord(outcome), { kind, code });
      try { await engine.fetch("https://example.test/resource"); }
      catch (error) { blocked = kind === "exited" ? (error as TestWasiExit).code : (error as { signal: number }).signal; }
      return 0;
    },
  });
  expect(blocked).toBe(code);
  expect(result.fetchCalls).toEqual([]);
});

test("live browser fetch retains the native host receiver", async () => {
  let text = "";
  const result = await run({ async engine(_proc, engine) { text = await (await engine.fetch("https://example.test/resource")).text(); return 0; } });
  expect(text).toBe("ok");
  expect(result.fetchCalls).toEqual(["https://example.test/resource"]);
  expect(exits(result.messages)).toEqual([{ type: "exit", code: 0, signal: undefined, sleep: "atomics" }]);
});

test("ordinary worker errors retain host diagnostics after claiming their terminal outcome", async () => {
  const root = await run({ adapter: "preview1", launch() { throw new Error("root diagnostic"); } });
  expect(exits(root.messages)).toMatchObject([{ type: "error", code: 1, message: expect.stringContaining("root diagnostic") }]);
  expect(readOutcome(outcomeWord(root.outcome!))).toMatchObject({ kind: "exited", code: 1 });
  let transport!: ChildTransport;
  const parent = new SubprocessHost({ output() {}, launch(_meta, child) { transport = child; return { terminate() {} }; } });
  try {
    parent.spawn(JSON.stringify({ argv: ["fixture"] }));
    const child = await run({ child: transport, adapter: "preview1", launch() { throw new Error("child diagnostic"); } });
    const diagnostic = childTransport(transport).stderr.read(4096);
    expect(diagnostic).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(diagnostic as Uint8Array)).toContain("child diagnostic");
    expect(exits(child.messages)).toEqual([{ type: "exit", code: 1, signal: undefined, sleep: "atomics" }]);
  } finally { parent.dispose(); }
});

test("child crash diagnostics are buffered before ordinary completion lets the broker close stderr", async () => {
  let transport!: ChildTransport;
  let bytesAtPublication = -1;
  const parent = new SubprocessHost({ output() {}, launch(_meta, child) { transport = child; return { terminate() {} }; } });
  const compareExchange = Atomics.compareExchange;
  const publication = spyOn(Atomics, "compareExchange").mockImplementation((array, index, expected, replacement) => {
    const previous = Reflect.apply(compareExchange, Atomics, [array, index, expected, replacement]);
    if (array.buffer === transport?.outcome && index === 0 && previous === 0n && replacement === 5n) {
      const stderr = childTransport(transport).stderr;
      bytesAtPublication = stderr.readiness().nbytes;
      // Observe logical completion at the earliest possible turn, before the worker posts exit.
      stderr.close();
    }
    return previous;
  });
  try {
    parent.spawn(JSON.stringify({ argv: ["fixture"] }));
    const result = await run({ child: transport, adapter: "preview1", launch() { throw new Error("buffer this diagnostic before completion"); } });
    const diagnostic = childTransport(transport).stderr.read(4096);
    expect(bytesAtPublication).toBeGreaterThan(0);
    expect(diagnostic).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(diagnostic as Uint8Array)).toContain("buffer this diagnostic before completion");
    expect(exits(result.messages)).toEqual([{ type: "exit", code: 1, signal: undefined, sleep: "atomics" }]);
  } finally { publication.mockRestore(); parent.dispose(); }
});

test("a previously selected child fatal outcome suppresses later unrelated diagnostics", async () => {
  let transport!: ChildTransport;
  const parent = new SubprocessHost({ output() {}, launch(_meta, child) { transport = child; return { terminate() {} }; } });
  try {
    parent.spawn(JSON.stringify({ argv: ["fixture"] }));
    claimOutcome(outcomeWord(transport.outcome), { kind: "signaled", code: 15 });
    const result = await run({ child: transport, adapter: "preview1", launch() { throw new Error("must not publish stale crash diagnostics"); } });
    expect(childTransport(transport).stderr.read(4096)).toBe(0);
    expect(exits(result.messages)).toEqual([{ type: "exit", code: 143, signal: 15, sleep: "atomics" }]);
  } finally { parent.dispose(); }
});

test("worker startup errors report their selected 126 outcome with diagnostics", async () => {
  const result = await run({ instantiateError: true });
  expect(exits(result.messages)).toMatchObject([{ type: "error", code: 126, message: expect.stringContaining("instantiate diagnostic") }]);
  expect(readOutcome(outcomeWord(result.outcome!))).toMatchObject({ kind: "exited", code: 126 });
});

test("caught non-isolated fatal defaults notify logical death before the guest releases its turn", async () => {
  const notices: WorkerMessage[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const running = run({
    isolated: false,
    onMessage(message) { notices.push(message); },
    async engine(proc) { try { proc.default_signal(15); } catch {} await waiting; return 0; },
  });
  try {
    expect(notices.filter(message => message.type !== "phase")).toEqual([{ type: "default-signal", signal: 15 }]);
  } finally { release(); await running; }
  const result = await running;
  expect(result.revoked).toBe(true);
  expect(exits(result.messages)).toEqual([{ type: "exit", code: 143, signal: 15, sleep: "busy-wait" }]);
});

test("a separate guest Worker adopts its message pipes without losing its signal queue or ordinary outcome", async () => {
  let transport!: ChildTransport;
  let current!: SubprocessHost;
  const parent = new SubprocessHost({ output() {}, launch(_meta, child) { transport = child; return { terminate() {} }; } });
  try {
    const pid = parent.spawn(JSON.stringify({ argv: ["fixture"], worker: {} }));
    expect(transport.pipes).toHaveLength(5);
    expect(parent.pipe(pid, 3)).toBe(-2);
    const incoming = parent.pipe(pid, 4);
    const outgoing = parent.pipe(pid, 5);
    expect(parent.write(incoming, new Uint8Array([1, 2, 3]))).toBe(3);
    const state = createSignalState(transport.signalState);
    setSignalDisposition(state, 2, 2);
    publishSignal(state, 2);
    const result = await run({
      child: transport, adapter: "preview1", onSubprocess(host) { current = host; },
      launch(proc) {
        expect(current.read(current.pipe(0, 4), 3)).toEqual(new Uint8Array([1, 2, 3]));
        expect(current.write(current.pipe(0, 5), new Uint8Array([4, 5]))).toBe(2);
        expect(proc.interrupted()).toBe(2);
        expect(proc.interrupted()).toBe(0);
        return 23;
      },
    });
    expect(parent.read(outgoing, 2)).toEqual(new Uint8Array([4, 5]));
    expect(parent.pipe(pid, 3)).toBe(0);
    expect(readOutcome(outcomeWord(transport.outcome))).toMatchObject({ kind: "exited", code: 23 });
    expect(exits(result.messages)).toEqual([{ type: "exit", code: 23, signal: undefined, sleep: "atomics" }]);
  } finally { parent.dispose(); }
});

test("a separate guest Worker cannot use message pipes after catching its fatal unwind", async () => {
  let transport!: ChildTransport;
  let current!: SubprocessHost;
  const blocked: string[] = [];
  const parent = new SubprocessHost({ output() {}, launch(_meta, child) { transport = child; return { terminate() {} }; } });
  try {
    const pid = parent.spawn(JSON.stringify({ argv: ["fixture"], worker: {} }));
    expect(transport.pipes).toHaveLength(5);
    const incoming = parent.pipe(pid, 4);
    const outgoing = parent.pipe(pid, 5);
    expect(parent.write(incoming, new Uint8Array([1, 2, 3]))).toBe(3);
    const result = await run({
      child: transport, adapter: "preview1", onSubprocess(host) { current = host; },
      launch(proc) {
        const read = current.pipe(0, 4);
        const write = current.pipe(0, 5);
        try { proc.default_signal(15); } catch {}
        for (const operation of [() => current.read(read, 3), () => current.write(write, new Uint8Array([4, 5])), () => current.close(write)]) {
          try { operation(); } catch (error) { blocked.push(error instanceof Error ? error.message : String(error)); }
        }
        return 0;
      },
    });
    expect(blocked).toEqual(new Array(3).fill("Process stopped by signal 15"));
    expect(new SharedPipe(transport.pipes[3]!, transport.budget).read(3)).toEqual(new Uint8Array([1, 2, 3]));
    expect(parent.read(outgoing, 2)).toBe(0);
    expect(parent.pipe(pid, 3)).toBe(15);
    expect(readOutcome(outcomeWord(transport.outcome))).toMatchObject({ kind: "signaled", code: 15 });
    expect(result.revoked).toBe(true);
    expect(exits(result.messages)).toEqual([{ type: "exit", code: 143, signal: 15, sleep: "atomics" }]);
  } finally { parent.dispose(); }
});

test("ordinary numeric signal-like exit remains an ordinary exit", async () => {
  const result = await run({ adapter: "preview1", launch: () => 143 });
  expect(exits(result.messages)).toEqual([{ type: "exit", code: 143, signal: undefined, sleep: "atomics" }]);
  expect(readOutcome(outcomeWord(result.outcome!))).toMatchObject({ kind: "exited", code: 143 });
});

test("non-isolated workers retain ordinary execution without SharedArrayBuffer", async () => {
  const result = await run({ isolated: false, adapter: "preview1", launch: () => 23 });
  expect(exits(result.messages)).toEqual([{ type: "exit", code: 23, signal: undefined, sleep: "busy-wait" }]);
});
