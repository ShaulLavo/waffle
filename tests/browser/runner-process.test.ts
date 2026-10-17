import type { RootProcessOptions } from "../../runtime/proc";
import { processRuntimeFixture } from "./process-runtime-fixture";
import { expect, spyOn, test } from "bun:test";
import { ENGINES, startRun, type Engine } from "../src/runner";
import { SubprocessBroker } from "../src/subprocess-broker";
import type { SharedFilesystem } from "../src/shared-fs";
import type { RunRequest } from "../src/worker";
import { claimOutcome, outcomeWord, readOutcome } from "../../runtime/proc/outcome";
import { createSignalState, setSignalDisposition, takeSignal } from "../../runtime/proc/signals";
import { SubprocessHost, type ChildTransport } from "../src/subprocess";
import { createFilesystemIdentity } from "../../runtime/fs";

function runConfirmation(run: ReturnType<typeof startRun>) {
  let confirmed = false;
  const result = run.done.then(value => { confirmed = true; return value; });
  return { result, confirmed: () => confirmed };
}

test.each([{ signal: undefined, code: 130 }, { signal: 9 as const, code: 137 }])("non-isolated root commands start without SharedArrayBuffer and stop with $code", async ({ signal, code }) => {
  const originalWorker = globalThis.Worker;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const originalShared = globalThis.SharedArrayBuffer;
  let sent: RunRequest | undefined;
  let posted!: () => void;
  const ready = new Promise<void>(resolve => { posted = resolve; });
  let terminated = 0;
  let revoked = 0;
  const channel = new MessageChannel();
  let release!: () => void;
  const section = new Promise<void>(resolve => { release = resolve; });
  const filesystem = { fork: () => ({ port: channel.port1 }), async quiesce() { revoked++; await section; } } as unknown as SharedFilesystem;
  const runtime = processRuntimeFixture(filesystem);
  let run: ReturnType<typeof startRun> | undefined;
  try {
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
    Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: false });
    globalThis.SharedArrayBuffer = undefined as unknown as typeof SharedArrayBuffer;
    globalThis.Worker = class {
      postMessage(request: RunRequest) { sent = request; posted(); }
      terminate() { terminated++; }
    } as unknown as typeof Worker;
    const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    run = startRun({ engine: "browser", module, args: ["-e", "0"], env: {}, runtime, moduleScope: false }, { stdout() {}, stderr() {} });
    await ready;
    expect(sent?.interrupt).toBeUndefined();
    expect(sent?.net).toBeNull();
    const waiting = runConfirmation(run);
    run.kill(signal);
    await Promise.resolve();
    expect(waiting.confirmed()).toBe(false);
    expect(terminated).toBe(0);
    expect(revoked).toBe(1);
    release();
    expect(await waiting.result).toEqual({ code });
    expect(terminated).toBe(1);
  } finally {
    release();
    run?.kill(9);
    globalThis.SharedArrayBuffer = originalShared;
    try { await run?.done; await runtime.dispose(); }
    finally {
      globalThis.Worker = originalWorker;
      if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
      if (originalIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", originalIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
      channel.port1.close(); channel.port2.close();
    }
  }
});

function isolatedRoot(isolated = true, engine: Engine = "browser", options: Parameters<typeof processRuntimeFixture>[1] = {}) {
  const originalWorker = globalThis.Worker;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const channel = new MessageChannel();
  let request!: RunRequest;
  let posted!: () => void;
  const ready = new Promise<void>(resolve => { posted = resolve; });
  let worker!: FakeWorker;
  const requests = new Map<number, RunRequest>();
  const workers = new Map<number, FakeWorker>();
  const pending = new Map<number, (request: RunRequest) => void>();
  const launchTimers = new Set<ReturnType<typeof setTimeout>>();
  const ports: MessagePort[] = [];
  let revoked = 0;
  let reaped = 0;
  let rejected = 0;
  const output: string[] = [];
  const phases: string[] = [];
  let release!: () => void;
  const quiescence = new Promise<void>(resolve => { release = resolve; });
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    terminated = 0;
    postMessage(value: RunRequest) {
      request ??= value; worker ??= this; requests.set(value.pid!, value); workers.set(value.pid!, this);
      pending.get(value.pid!)?.(value); posted();
    }
    terminate() { this.terminated++; }
    exit(code: number, signal?: number) { this.onmessage?.({ data: { type: "exit", code, signal, sleep: "atomics" } } as MessageEvent); }
  }
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: isolated });
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const filesystem = {
    fork: () => ({ ...createFilesystemIdentity(), port: channel.port1 }),
    connect(identity: object) {
      const child = new MessageChannel(); child.port2.close(); ports.push(child.port1);
      return { ...identity, port: child.port1 };
    },
    reap() { reaped++; },
    revoke() { rejected++; },
    async quiesce() { revoked++; await quiescence; },
  } as unknown as SharedFilesystem;
  const runtime = processRuntimeFixture(filesystem, options);
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const run = startRun({ engine, module, args: ["-e", "0"], env: {}, runtime, moduleScope: false }, {
    stdout(data) { output.push(new TextDecoder().decode(data)); }, stderr() {}, phase(name) { phases.push(name); },
  });
  return {
    run, runtime, ready, get request() { return request; }, get worker() { return worker; }, release, quiescence, output, phases,
    workerFor(pid: number) { return workers.get(pid)!; },
    requestFor(pid: number): Promise<RunRequest> {
      const request = requests.get(pid);
      return request ? Promise.resolve(request) : new Promise((resolve, reject) => {
        const timer = setTimeout(() => { launchTimers.delete(timer); pending.delete(pid); reject(new Error(`worker ${pid} did not receive its run request`)); }, 1000);
        launchTimers.add(timer);
        pending.set(pid, request => { clearTimeout(timer); launchTimers.delete(timer); pending.delete(pid); resolve(request); });
      });
    },
    revoked: () => revoked, reaped: () => reaped, rejected: () => rejected,
    async dispose() {
      try {
        run.kill(9);
        release();
        await run.done;
        await quiescence;
        await runtime.dispose();
      } finally {
        for (const timer of launchTimers) clearTimeout(timer);
        pending.clear();
        globalThis.Worker = originalWorker;
        if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
        if (originalIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", originalIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
        for (const port of ports) port.close();
        channel.port1.close(); channel.port2.close();
      }
    },
  };
}

const engines: Engine[] = ["quickjs", "jsc", "browser"];

for (const engine of engines) {
  test(`${engine} roots launch bun/node aliases with their selected engine and existing module`, async () => {
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Root engine aliases must not download another guest"));
    const state = isolatedRoot(false, engine);
    const host = new SubprocessHost({
      identity: state.runtime.identities.buffer, pid: 1, jobId: 1, output() {},
      launch(meta, child) {
        state.worker.onmessage?.({ data: { type: "spawn", request: {
          executable: meta.argv[0]!, argv: meta.argv, cwd: "/", env: {}, pid: child.pid, parentPid: child.parentPid,
          jobId: child.jobId, child, filesystem: createFilesystemIdentity(), trace: false, spawnBroker: true,
        } } } as MessageEvent);
        return { terminate() {} };
      },
    });
    try {
      await state.ready;
      for (const name of ["bun", "/bun", "node", "/node", "/usr/local/bin/bun", "/usr/local/bin/node"]) {
        const pid = host.spawn(JSON.stringify({ argv: [name] }));
        const entry = await state.requestFor(pid);
        expect(entry.engine).toBe(engine);
        expect(entry.adapter).toBe("bun");
        expect(entry.module).toBe(state.request.module);
        state.workerFor(pid).exit(0);
        const deadline = performance.now() + 1000;
        while (host.wait(pid) === -2 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
        expect(host.wait(pid)).toBe(0);
        host.close(pid);
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      try { host.detach(); host.dispose(); await state.dispose(); }
      finally { fetch.mockRestore(); }
    }
  });

  test(`${engine} roots retain explicit engine overrides and cache each guest module`, async () => {
    const register = spyOn(SubprocessBroker.prototype, "register");
    const urls: string[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith(".gz")) return new Response(null, { status: 404 });
      return new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), { headers: { "content-type": "application/wasm" } });
    }, { preconnect: globalThis.fetch.preconnect }));
    const state = isolatedRoot(false, engine);
    try {
      await state.ready;
      const entries = new Map(register.mock.calls);
      const loaded = new Set<WebAssembly.Module>();
      for (const selected of engines) {
        const entry = entries.get(`bun-${selected}`);
        if (!entry) throw new Error(`Missing explicit engine registration: ${selected}`);
        if (entry.adapter !== "bun") throw new Error(`Explicit ${selected} program must use the Bun adapter`);
        expect(entry.engine).toBe(selected);
        expect(entry.adapter).toBe("bun");
        const module = typeof entry.module === "function" ? await entry.module() : entry.module;
        const again = typeof entry.module === "function" ? await entry.module() : entry.module;
        expect(module).toBeInstanceOf(WebAssembly.Module);
        expect(again).toBe(module);
        if (selected === engine) expect(module).toBe(state.request.module);
        else expect(module).not.toBe(state.request.module);
        loaded.add(module);
      }
      expect(loaded.size).toBe(3);
      expect(urls).toEqual(engines.filter(selected => selected !== engine).flatMap(selected => [
        `http://localhost/${ENGINES[selected].wasm}.gz`, `http://localhost/${ENGINES[selected].wasm}`,
      ]));
    } finally {
      try { await state.dispose(); }
      finally { register.mockRestore(); fetch.mockRestore(); }
    }
  });
}

test("concurrent roots on one runtime keep engine-correct aliases without replacing other roots", async () => {
  const originalWorker = globalThis.Worker;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const ports: MessagePort[] = [];
  const workers: FakeWorker[] = [];
  const requests = new Map<number, RunRequest>();
  const runs: ReturnType<typeof startRun>[] = [];
  const hosts: SubprocessHost[] = [];
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) =>
    String(input).endsWith(".gz") ? new Response(null, { status: 404 })
      : new Response(wasm, { headers: { "content-type": "application/wasm" } }), { preconnect: globalThis.fetch.preconnect }));
  function connect(identity = createFilesystemIdentity()) {
    const channel = new MessageChannel(); channel.port2.close(); ports.push(channel.port1);
    return { ...identity, port: channel.port1 };
  }
  const runtime = processRuntimeFixture({ fork: () => connect(), connect, revoke() {}, reap() {}, async quiesce() {} } as unknown as SharedFilesystem);
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    request!: RunRequest;
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(request: RunRequest) { this.request = request; requests.set(request.pid!, request); }
    terminate() { this.terminated = true; }
  }
  async function received(pid: number): Promise<RunRequest> {
    const deadline = performance.now() + 1000;
    while (!requests.has(pid) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
    const request = requests.get(pid);
    if (!request) throw new Error(`worker ${pid} did not receive its run request`);
    return request;
  }
  try {
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
    Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    for (const engine of engines) {
      runs.push(startRun({ engine, module: new WebAssembly.Module(wasm), args: [], env: {}, runtime, moduleScope: false }, { stdout() {}, stderr() {} }));
    }
    const roots = workers.slice();
    for (const worker of roots) {
      const deadline = performance.now() + 1000;
      while (!worker.request && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
      expect(worker.request).toBeDefined();
      const root = worker.request;
      const host = new SubprocessHost({ identity: runtime.identities.buffer, pid: root.pid, jobId: root.jobId, output() {},
        launch(meta, child) {
          worker.onmessage?.({ data: { type: "spawn", request: {
            executable: meta.argv[0]!, argv: meta.argv, cwd: "/", env: {}, pid: child.pid, parentPid: child.parentPid,
            jobId: child.jobId, child, filesystem: createFilesystemIdentity(), trace: false, spawnBroker: true,
          } } } as MessageEvent);
          return { terminate() {} };
        },
      });
      hosts.push(host);
      for (const alias of ["bun", "/bun", "node", "/node", "/usr/local/bin/bun", "/usr/local/bin/node"]) {
        const pid = host.spawn(JSON.stringify({ argv: [alias] }));
        const child = await received(pid);
        expect(child.engine).toBe(root.engine);
        expect(child.adapter).toBe("bun");
        workers.find(worker => worker.request?.pid === pid)!.onmessage?.({ data: { type: "exit", code: 0, sleep: "atomics" } } as MessageEvent);
        const deadline = performance.now() + 1000;
        while (host.wait(pid) === -2 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
        expect(host.wait(pid)).toBe(0);
        host.close(pid);
      }
    }
    expect(roots.every(worker => !worker.terminated)).toBe(true);
  } finally {
    for (const host of hosts) { host.detach(); host.dispose(); }
    for (const run of runs) run.kill(9);
    try { await Promise.all(runs.map(run => run.done)); await runtime.dispose(); }
    finally {
      for (const worker of workers) worker.terminate();
      for (const port of ports) port.close();
      fetch.mockRestore();
      globalThis.Worker = originalWorker;
      if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
      if (originalIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", originalIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
    }
  }
});

test("one isolated Ctrl-C claims DEFAULT 130 immediately before quiescent physical stop", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    expect(state.request.signalState).toBeInstanceOf(SharedArrayBuffer);
    expect(state.request.outcome).toBeInstanceOf(SharedArrayBuffer);
    const waiting = runConfirmation(state.run);
    state.run.kill();
    expect(readOutcome(outcomeWord(state.request.outcome))).toEqual({ kind: "signaled", code: 2, status: 130 });
    await Promise.resolve();
    expect(waiting.confirmed()).toBe(false);
    expect(state.revoked()).toBe(1);
    expect(state.worker.terminated).toBe(0);
    state.worker.exit(0);
    await Promise.resolve();
    expect(waiting.confirmed()).toBe(false);
    state.release();
    expect(await waiting.result).toEqual({ code: 130 });
    expect(state.worker.terminated).toBe(1);
  } finally { await state.dispose(); }
});

for (const code of [0, 23, 130]) {
  test(`handled root INT keeps ordinary guest exit ${code}`, async () => {
    const state = isolatedRoot();
    try {
      await state.ready;
      const signalState = createSignalState(state.request.signalState);
      setSignalDisposition(signalState, 2, 2);
      state.run.kill();
      expect(takeSignal(signalState)).toBe(2);
      expect(takeSignal(signalState)).toBe(0);
      expect(readOutcome(outcomeWord(state.request.outcome))).toBeNull();
      expect(state.revoked()).toBe(0);
      state.worker.exit(code);
      expect(await state.run.done).toEqual({ code });
      expect(readOutcome(outcomeWord(state.request.outcome))).toEqual({ kind: "exited", code, status: code });
      expect(state.reaped()).toBe(1);
    } finally { await state.dispose(); }
  });
}

test("root IGNORE leaves no pending signal or terminal result", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    const signalState = createSignalState(state.request.signalState);
    setSignalDisposition(signalState, 2, 1);
    state.run.kill();
    expect(takeSignal(signalState)).toBe(0);
    expect(Atomics.load(new Int32Array(state.request.interrupt!), 0)).toBe(0);
    expect(readOutcome(outcomeWord(state.request.outcome))).toBeNull();
    expect(state.revoked()).toBe(0);
    state.worker.exit(0);
    expect(await state.run.done).toEqual({ code: 0 });
  } finally { await state.dispose(); }
});

test("removing a root handler restores the next explicit INT default", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    const signalState = createSignalState(state.request.signalState);
    setSignalDisposition(signalState, 2, 2);
    state.run.kill(2);
    expect(takeSignal(signalState)).toBe(2);
    expect(setSignalDisposition(signalState, 2, 0)).toBe(false);
    state.run.kill(2);
    state.release();
    expect(await state.run.done).toEqual({ code: 130 });
    expect(readOutcome(outcomeWord(state.request.outcome))?.kind).toBe("signaled");
  } finally { await state.dispose(); }
});

test.each([0, 143])("a root exit already claimed as %s wins a later default signal", async code => {
  const state = isolatedRoot();
  try {
    await state.ready;
    claimOutcome(outcomeWord(state.request.outcome), { kind: "exited", code });
    state.run.kill(2);
    state.release();
    expect(await state.run.done).toEqual({ code });
    expect(readOutcome(outcomeWord(state.request.outcome))).toEqual({ kind: "exited", code, status: code });
  } finally { await state.dispose(); }
});

test("root acknowledgement adopts a previously claimed typed signal rather than ordinary 143", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    claimOutcome(outcomeWord(state.request.outcome), { kind: "signaled", code: 15 });
    state.worker.exit(143);
    expect(await state.run.done).toEqual({ code: 143 });
    expect(readOutcome(outcomeWord(state.request.outcome))).toEqual({ kind: "signaled", code: 15, status: 143 });
  } finally { await state.dispose(); }
});

for (const signal of [2, 9, 13, 15]) {
  test(`a root's caught default ${signal} is observed without a worker exit acknowledgement`, async () => {
    const state = isolatedRoot();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await state.ready;
      claimOutcome(outcomeWord(state.request.outcome), { kind: "signaled", code: signal });
      const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("root signal outcome was not observed")), 250); });
      const waiting = runConfirmation(state.run);
      await new Promise(resolve => setTimeout(resolve, 12));
      expect(waiting.confirmed()).toBe(false);
      expect(state.reaped()).toBe(0);
      expect(state.revoked()).toBe(1);
      expect(state.worker.terminated).toBe(0);
      state.release();
      expect(await Promise.race([waiting.result, timeout])).toEqual({ code: 128 + signal });
      expect(state.worker.terminated).toBe(1);
    } finally { clearTimeout(timer); await state.dispose(); }
  });
}

test("root capability messages cannot cross a selected fatal outcome before its timer observes it", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    claimOutcome(outcomeWord(state.request.outcome), { kind: "signaled", code: 15 });
    state.worker.onmessage?.({ data: { type: "stdout", data: new TextEncoder().encode("late output") } } as MessageEvent);
    state.worker.onmessage?.({ data: { type: "phase", name: "late-phase", duration: 0 } } as MessageEvent);
    expect(state.output).toEqual([]);
    expect(state.phases).toEqual([]);
    state.release();
    expect(await state.run.done).toEqual({ code: 143 });
    expect(state.reaped()).toBe(0);
  } finally { await state.dispose(); }
});

test.each([false, true])("an unadmitted spawn after root fatal selection releases its transport (already observed: %s)", async observed => {
  const state = isolatedRoot();
  await state.ready;
  let transport!: ChildTransport;
  const host = new SubprocessHost({ identity: state.runtime.identities.buffer, output() {}, launch(_meta, child) { transport = child; return { terminate() {} }; } });
  try {
    const pid = host.spawn(JSON.stringify({ argv: ["fixture"] }));
    claimOutcome(outcomeWord(state.request.outcome), { kind: "signaled", code: 15 });
    if (observed) { state.run.kill(2); state.release(); await state.run.done; }
    state.worker.onmessage?.({ data: { type: "spawn", request: {
      executable: "fixture", argv: ["fixture"], cwd: "/", env: {}, pid, parentPid: 1,
      jobId: transport.jobId, child: transport, filesystem: createFilesystemIdentity(), trace: false, spawnBroker: true,
    } } } as MessageEvent);
    expect(host.wait(pid)).toBe(137);
    expect(state.rejected()).toBe(1);
    expect(Atomics.load(new Int32Array(transport.budget), transport.slot + 2)).toBe(0);
    state.release();
    expect(await state.run.done).toEqual({ code: 143 });
  } finally { host.detach(); host.dispose(); await state.dispose(); }
});

test("a second implicit UI stop still force-kills a root that handled the first Ctrl-C", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    const signalState = createSignalState(state.request.signalState);
    setSignalDisposition(signalState, 2, 2);
    state.run.kill();
    expect(takeSignal(signalState)).toBe(2);
    expect(readOutcome(outcomeWord(state.request.outcome))).toBeNull();
    state.run.kill();
    state.release();
    expect(await state.run.done).toEqual({ code: 137 });
    expect(readOutcome(outcomeWord(state.request.outcome))).toEqual({ kind: "signaled", code: 9, status: 137 });
  } finally { await state.dispose(); }
});

for (const code of [1, 126]) {
  test(`root crash acknowledgement preserves selected ordinary ${code} and diagnostic stack`, async () => {
    const state = isolatedRoot();
    try {
      await state.ready;
      claimOutcome(outcomeWord(state.request.outcome), { kind: "exited", code });
      state.worker.onmessage?.({ data: { type: "error", code, message: "crash details\nstack frame", sleep: "atomics" } } as MessageEvent);
      expect(await state.run.done).toEqual({ code, error: "bun.wasm crashed: crash details\r\nstack frame" });
      expect(state.reaped()).toBe(1);
    } finally { await state.dispose(); }
  });
}

test("typed fatal winner suppresses a later ordinary crash diagnostic", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    claimOutcome(outcomeWord(state.request.outcome), { kind: "signaled", code: 15 });
    state.worker.onmessage?.({ data: { type: "error", code: 1, message: "stale crash", sleep: "atomics" } } as MessageEvent);
    expect(await state.run.done).toEqual({ code: 143 });
  } finally { await state.dispose(); }
});

for (const signal of [2, 9, 13, 15]) {
  test(`non-isolated default ${signal} notification is terminal but not a quiescent acknowledgement`, async () => {
    const state = isolatedRoot(false);
    try {
      await state.ready;
      expect(state.request.outcome).toBeUndefined();
      const waiting = runConfirmation(state.run);
      state.worker.onmessage?.({ data: { type: "default-signal", signal } } as MessageEvent);
      await Promise.resolve();
      expect(waiting.confirmed()).toBe(false);
      expect(state.revoked()).toBe(1);
      expect(state.reaped()).toBe(0);
      expect(state.worker.terminated).toBe(0);
      state.worker.exit(0);
      await Promise.resolve();
      expect(waiting.confirmed()).toBe(false);
      state.release();
      expect(await waiting.result).toEqual({ code: 128 + signal });
      expect(state.worker.terminated).toBe(1);
    } finally { await state.dispose(); }
  });
}

test("an earlier ordinary root winner does not inherit a losing crash diagnostic", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    claimOutcome(outcomeWord(state.request.outcome), { kind: "exited", code: 0 });
    state.worker.onmessage?.({ data: { type: "error", code: 1, message: "losing crash", sleep: "atomics" } } as MessageEvent);
    expect(await state.run.done).toEqual({ code: 0 });
  } finally { await state.dispose(); }
});

for (const acknowledged of [false, true]) test(`runner root job completion uses its own filesystem fence (acknowledged ${acknowledged})`, async () => {
  let broker!: SubprocessBroker;
  const original = SubprocessBroker.prototype.register;
  const register = spyOn(SubprocessBroker.prototype, "register").mockImplementation(function(this: SubprocessBroker, name, entry) {
    broker = this;
    original.call(this, name, entry);
  });
  const state = isolatedRoot();
  try {
    await state.ready;
    const supervisor = await broker.ready();
    const background = supervisor.reserveSpawn(1, { executable: "bun", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    const waiting = runConfirmation(state.run);
    if (acknowledged) state.worker.exit(23);
    else state.run.kill(9);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(waiting.confirmed()).toBe(acknowledged);
    expect(supervisor.get(1)!.result?.status ?? null).toBe(acknowledged ? 23 : null);
    expect(supervisor.jobEmpty(1, 1)).toBe(acknowledged);
    // Runner physical stop and supervisor confirmation share exactly one fence.
    expect(state.revoked()).toBe(acknowledged ? 0 : 1);
    state.release();
    expect((await waiting.result).code).toBe(acknowledged ? 23 : 137);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(supervisor.get(1)!.result?.status).toBe(acknowledged ? 23 : 137);
    expect(supervisor.jobEmpty(1, 1)).toBe(true);
    expect(supervisor.get(background)!.result).toBeNull();
    expect(state.worker.terminated).toBe(1);
  } finally { register.mockRestore(); await state.dispose(); broker.dispose(); }
});

test("run.done waits for deferred root activation and descriptor release", async () => {
  const proc = await import("../../runtime/proc");
  let broker!: SubprocessBroker;
  let activate!: () => void;
  const activation = new Promise<void>(resolve => { activate = resolve; });
  const original = SubprocessBroker.prototype.register;
  const register = spyOn(SubprocessBroker.prototype, "register").mockImplementation(function(this: SubprocessBroker, name, entry) {
    broker = this;
    original.call(this, name, entry);
  });
  let released = false;
  class DescriptorSupervisor extends proc.ProcessSupervisor {
    override createRoot(options: RootProcessOptions): number {
      const pid = super.createRoot(options);
      this.get(pid)!.descriptors.open({
        kind: "terminal", read: () => 0, write: () => 0,
        readiness: () => ({ readable: false, writable: true, hangup: false }),
      }, 0n, 0n, () => { released = true; });
      return pid;
    }
  }
  // Install the descriptor before readiness resolves: the generic owner may observe the
  // selected root outcome before a caller's subsequent .then callback runs.
  const state = isolatedRoot(true, "browser", { activate: async () => { await activation; return { ...proc, ProcessSupervisor: DescriptorSupervisor }; } });
  const supervisor = broker.ready();
  try {
    await state.ready;
    const waiting = runConfirmation(state.run);
    state.run.kill(9);
    state.release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(waiting.confirmed()).toBe(false);
    expect(released).toBe(false);
    expect(state.worker.terminated).toBe(0);
    activate();
    const active = await supervisor;
    expect(await waiting.result).toEqual({ code: 137 });
    expect(released).toBe(true);
    expect(active.get(1)!.result?.status).toBe(137);
    expect(state.revoked()).toBe(1);
    expect(state.worker.terminated).toBe(1);
  } finally {
    activate();
    await supervisor;
    register.mockRestore();
    await state.dispose();
    broker.dispose();
  }
});

for (const partial of [false, true]) test(`run.done safely handles rejected deferred process activation (partial root ${partial})`, async () => {
  const proc = await import("../../runtime/proc");
  let broker!: SubprocessBroker;
  let failActivation!: () => void;
  const failure = new Error("process module could not initialize");
  let released = false;
  class PartialSupervisor extends proc.ProcessSupervisor {
    override createRoot(options: RootProcessOptions): never {
      const pid = super.createRoot(options);
      this.get(pid)!.descriptors.open({
        kind: "terminal", read: () => 0, write: () => 0,
        readiness: () => ({ readable: false, writable: true, hangup: false }),
      }, 0n, 0n, () => { released = true; });
      throw failure;
    }
  }
  const activation = new Promise<typeof proc>((resolve, reject) => {
    failActivation = () => partial ? resolve({ ...proc, ProcessSupervisor: PartialSupervisor }) : reject(failure);
  });
  const original = SubprocessBroker.prototype.register;
  const register = spyOn(SubprocessBroker.prototype, "register").mockImplementation(function(this: SubprocessBroker, name, entry) {
    broker = this;
    original.call(this, name, entry);
  });
  const report = spyOn(console, "error").mockImplementation(() => {});
  const state = isolatedRoot(true, "browser", { activate: () => activation });
  // Observe the explicit ready request too; rootExit must handle only its activation
  // rejection, while the runner's own filesystem fence remains mandatory.
  const attempted = broker.ready().catch(error => error);
  try {
    await state.ready;
    const waiting = runConfirmation(state.run);
    state.run.kill(9);
    failActivation();
    expect(await attempted).toBe(failure);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(waiting.confirmed()).toBe(false);
    expect(state.worker.terminated).toBe(0);
    expect(state.revoked()).toBe(1);
    expect(report).toHaveBeenCalledWith("runtime: process controller failed", failure);
    expect(released).toBe(partial);
    state.release();
    expect(await waiting.result).toEqual({ code: 137 });
    expect(state.worker.terminated).toBe(1);
  } finally {
    failActivation();
    register.mockRestore();
    await state.dispose();
    broker.dispose();
    // dispose observes the same failed activation asynchronously.
    await new Promise(resolve => setTimeout(resolve, 0));
    report.mockRestore();
  }
});

test("run.done confirms after the filesystem fence without awaiting physical worker termination", async () => {
  const state = isolatedRoot();
  await state.ready;
  let release!: () => void;
  const physicalTermination = new Promise<void>(resolve => { release = resolve; });
  const terminate = spyOn(state.worker, "terminate").mockImplementation(() => physicalTermination);
  try {
    const waiting = runConfirmation(state.run);
    state.run.kill(9);
    await Promise.resolve();
    expect(waiting.confirmed()).toBe(false);
    expect(terminate).not.toHaveBeenCalled();
    state.release();
    expect(await waiting.result).toEqual({ code: 137 });
    expect(terminate).toHaveBeenCalledTimes(1);
    // The returned physical-termination promise is deliberately still unresolved.
  } finally { release(); terminate.mockRestore(); await state.dispose(); }
});
