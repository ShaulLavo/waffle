import { expect, spyOn, test } from "bun:test";
import { ENGINES, startRun, type Engine } from "../src/runner";
import { SubprocessBroker } from "../src/subprocess-broker";
import type { SharedFilesystem } from "../src/shared-fs";
import type { RunRequest } from "../src/worker";
import { claimOutcome, outcomeWord, readOutcome } from "../../runtime/proc/outcome";
import { createSignalState, setSignalDisposition, takeSignal } from "../../runtime/proc/signals";
import { SubprocessHost, type ChildTransport } from "../src/subprocess";
import { createFilesystemIdentity } from "../../runtime/fs";

test.each([{ signal: undefined, code: 130 }, { signal: 9 as const, code: 137 }])("non-isolated root commands start without SharedArrayBuffer and stop with $code", async ({ signal, code }) => {
  const originalWorker = globalThis.Worker;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const originalShared = globalThis.SharedArrayBuffer;
  let sent: RunRequest | undefined;
  let terminated = 0;
  let revoked = 0;
  const channel = new MessageChannel();
  let release!: () => void;
  const section = new Promise<void>(resolve => { release = resolve; });
  try {
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
    Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: false });
    globalThis.SharedArrayBuffer = undefined as unknown as typeof SharedArrayBuffer;
    globalThis.Worker = class {
      postMessage(request: RunRequest) { sent = request; }
      terminate() { terminated++; }
    } as unknown as typeof Worker;
    const filesystem = { fork: () => ({ port: channel.port1 }), async quiesce() { revoked++; await section; } } as unknown as SharedFilesystem;
    const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const run = startRun({ engine: "browser", module, args: ["-e", "0"], env: {}, filesystem, moduleScope: false }, { stdout() {}, stderr() {} });
    expect(sent?.interrupt).toBeUndefined();
    expect(sent?.net).toBeNull();
    run.kill(signal);
    expect(await run.done).toEqual({ code });
    expect(terminated).toBe(0);
    expect(revoked).toBe(1);
    release();
    await section;
    await Promise.resolve();
    expect(terminated).toBe(1);
  } finally {
    release();
    globalThis.Worker = originalWorker;
    globalThis.SharedArrayBuffer = originalShared;
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
    if (originalIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", originalIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
    channel.port1.close(); channel.port2.close();
  }
});

function isolatedRoot(isolated = true, engine: Engine = "browser") {
  const originalWorker = globalThis.Worker;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const channel = new MessageChannel();
  let request!: RunRequest;
  let worker!: FakeWorker;
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
    postMessage(value: RunRequest) { request = value; worker = this; }
    terminate() { this.terminated++; }
    exit(code: number, signal?: number) { this.onmessage?.({ data: { type: "exit", code, signal, sleep: "atomics" } } as MessageEvent); }
  }
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: isolated });
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const filesystem = {
    fork: () => ({ port: channel.port1 }),
    reap() { reaped++; },
    revoke() { rejected++; },
    async quiesce() { revoked++; await quiescence; },
  } as unknown as SharedFilesystem;
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const run = startRun({ engine, module, args: ["-e", "0"], env: {}, filesystem, moduleScope: false }, {
    stdout(data) { output.push(new TextDecoder().decode(data)); }, stderr() {}, phase(name) { phases.push(name); },
  });
  return {
    run, request, worker, release, quiescence, output, phases,
    revoked: () => revoked, reaped: () => reaped, rejected: () => rejected,
    async dispose() {
      run.kill(9);
      release();
      await run.done;
      await quiescence;
      globalThis.Worker = originalWorker;
      if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
      if (originalIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", originalIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
      channel.port1.close(); channel.port2.close();
    },
  };
}

const engines: Engine[] = ["quickjs", "jsc", "browser"];

for (const engine of engines) {
  test(`${engine} roots register bun/node aliases with their selected engine and existing module`, async () => {
    const register = spyOn(SubprocessBroker.prototype, "register");
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Root engine aliases must not download another guest"));
    const state = isolatedRoot(false, engine);
    try {
      const entries = new Map(register.mock.calls);
      for (const name of ["bun", "/bun", "node", "/node", "/usr/local/bin/bun", "/usr/local/bin/node"]) {
        const entry = entries.get(name);
        if (!entry) throw new Error(`Missing executable registration: ${name}`);
        expect(entry.engine).toBe(engine);
        expect(entry.adapter).toBe("bun");
        const module = typeof entry.module === "function" ? await entry.module() : entry.module;
        expect(module).toBe(state.request.module);
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      try { await state.dispose(); }
      finally { register.mockRestore(); fetch.mockRestore(); }
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
      const entries = new Map(register.mock.calls);
      const loaded = new Set<WebAssembly.Module>();
      for (const selected of engines) {
        const entry = entries.get(`bun-${selected}`);
        if (!entry) throw new Error(`Missing explicit engine registration: ${selected}`);
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

test("one isolated Ctrl-C claims DEFAULT 130 immediately before quiescent physical stop", async () => {
  const state = isolatedRoot();
  try {
    expect(state.request.signalState).toBeInstanceOf(SharedArrayBuffer);
    expect(state.request.outcome).toBeInstanceOf(SharedArrayBuffer);
    state.run.kill();
    expect(readOutcome(outcomeWord(state.request.outcome))).toEqual({ kind: "signaled", code: 2, status: 130 });
    expect(await state.run.done).toEqual({ code: 130 });
    expect(state.revoked()).toBe(1);
    expect(state.worker.terminated).toBe(0);
    state.worker.exit(0);
    expect(await state.run.done).toEqual({ code: 130 });
    state.release();
    await state.quiescence;
    await Promise.resolve();
    expect(state.worker.terminated).toBe(1);
  } finally { await state.dispose(); }
});

for (const code of [0, 23, 130]) {
  test(`handled root INT keeps ordinary guest exit ${code}`, async () => {
    const state = isolatedRoot();
    try {
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
    const signalState = createSignalState(state.request.signalState);
    setSignalDisposition(signalState, 2, 2);
    state.run.kill(2);
    expect(takeSignal(signalState)).toBe(2);
    expect(setSignalDisposition(signalState, 2, 0)).toBe(false);
    state.run.kill(2);
    expect(await state.run.done).toEqual({ code: 130 });
    expect(readOutcome(outcomeWord(state.request.outcome))?.kind).toBe("signaled");
  } finally { await state.dispose(); }
});

test.each([0, 143])("a root exit already claimed as %s wins a later default signal", async code => {
  const state = isolatedRoot();
  try {
    claimOutcome(outcomeWord(state.request.outcome), { kind: "exited", code });
    state.run.kill(2);
    expect(await state.run.done).toEqual({ code });
    expect(readOutcome(outcomeWord(state.request.outcome))).toEqual({ kind: "exited", code, status: code });
  } finally { await state.dispose(); }
});

test("root acknowledgement adopts a previously claimed typed signal rather than ordinary 143", async () => {
  const state = isolatedRoot();
  try {
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
      claimOutcome(outcomeWord(state.request.outcome), { kind: "signaled", code: signal });
      const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("root signal outcome was not observed")), 250); });
      expect(await Promise.race([state.run.done, timeout])).toEqual({ code: 128 + signal });
      expect(state.reaped()).toBe(0);
      expect(state.revoked()).toBe(1);
      expect(state.worker.terminated).toBe(0);
      state.release();
      await state.quiescence;
      await Promise.resolve();
      expect(state.worker.terminated).toBe(1);
    } finally { clearTimeout(timer); await state.dispose(); }
  });
}

test("root capability messages cannot cross a selected fatal outcome before its timer observes it", async () => {
  const state = isolatedRoot();
  try {
    claimOutcome(outcomeWord(state.request.outcome), { kind: "signaled", code: 15 });
    state.worker.onmessage?.({ data: { type: "stdout", data: new TextEncoder().encode("late output") } } as MessageEvent);
    state.worker.onmessage?.({ data: { type: "phase", name: "late-phase", duration: 0 } } as MessageEvent);
    expect(state.output).toEqual([]);
    expect(state.phases).toEqual([]);
    expect(await state.run.done).toEqual({ code: 143 });
    expect(state.reaped()).toBe(0);
  } finally { await state.dispose(); }
});

test.each([false, true])("an unadmitted spawn after root fatal selection releases its transport (already observed: %s)", async observed => {
  const state = isolatedRoot();
  let transport!: ChildTransport;
  const host = new SubprocessHost({ output() {}, launch(_meta, child) { transport = child; return { terminate() {} }; } });
  try {
    const pid = host.spawn(JSON.stringify({ argv: ["fixture"] }));
    claimOutcome(outcomeWord(state.request.outcome), { kind: "signaled", code: 15 });
    if (observed) { state.run.kill(2); await state.run.done; }
    state.worker.onmessage?.({ data: { type: "spawn", request: {
      executable: "fixture", argv: ["fixture"], cwd: "/", env: {}, pid, parentPid: 1,
      jobId: transport.jobId, child: transport, filesystem: createFilesystemIdentity(), trace: false, spawnBroker: true,
    } } } as MessageEvent);
    expect(host.wait(pid)).toBe(137);
    expect(state.rejected()).toBe(1);
    expect(Atomics.load(new Int32Array(transport.budget), transport.slot + 2)).toBe(0);
    expect(await state.run.done).toEqual({ code: 143 });
  } finally { host.detach(); host.dispose(); await state.dispose(); }
});

test("a second implicit UI stop still force-kills a root that handled the first Ctrl-C", async () => {
  const state = isolatedRoot();
  try {
    const signalState = createSignalState(state.request.signalState);
    setSignalDisposition(signalState, 2, 2);
    state.run.kill();
    expect(takeSignal(signalState)).toBe(2);
    expect(readOutcome(outcomeWord(state.request.outcome))).toBeNull();
    state.run.kill();
    expect(await state.run.done).toEqual({ code: 137 });
    expect(readOutcome(outcomeWord(state.request.outcome))).toEqual({ kind: "signaled", code: 9, status: 137 });
  } finally { await state.dispose(); }
});

for (const code of [1, 126]) {
  test(`root crash acknowledgement preserves selected ordinary ${code} and diagnostic stack`, async () => {
    const state = isolatedRoot();
    try {
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
    claimOutcome(outcomeWord(state.request.outcome), { kind: "signaled", code: 15 });
    state.worker.onmessage?.({ data: { type: "error", code: 1, message: "stale crash", sleep: "atomics" } } as MessageEvent);
    expect(await state.run.done).toEqual({ code: 143 });
  } finally { await state.dispose(); }
});

for (const signal of [2, 9, 13, 15]) {
  test(`non-isolated default ${signal} notification is terminal but not a quiescent acknowledgement`, async () => {
    const state = isolatedRoot(false);
    try {
      expect(state.request.outcome).toBeUndefined();
      state.worker.onmessage?.({ data: { type: "default-signal", signal } } as MessageEvent);
      const result = await state.run.done;
      expect(result).toEqual({ code: 128 + signal });
      expect(state.revoked()).toBe(1);
      expect(state.reaped()).toBe(0);
      expect(state.worker.terminated).toBe(0);
      state.worker.exit(0);
      expect(await state.run.done).toEqual(result);
      state.release();
      await state.quiescence;
      await Promise.resolve();
      expect(state.worker.terminated).toBe(1);
    } finally { await state.dispose(); }
  });
}

test("an earlier ordinary root winner does not inherit a losing crash diagnostic", async () => {
  const state = isolatedRoot();
  try {
    claimOutcome(outcomeWord(state.request.outcome), { kind: "exited", code: 0 });
    state.worker.onmessage?.({ data: { type: "error", code: 1, message: "losing crash", sleep: "atomics" } } as MessageEvent);
    expect(await state.run.done).toEqual({ code: 0 });
  } finally { await state.dispose(); }
});
