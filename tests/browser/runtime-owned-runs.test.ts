import { expect, spyOn, test } from "bun:test";
import { createRuntime } from "@bun-wasm/runtime";
import { FilesystemSection } from "@bun-wasm/runtime/fs/protocol";
import { createWorkerProcessTransport } from "@bun-wasm/runtime/proc/worker-client";
import { BrowserProcessBroker } from "@bun-wasm/runtime/browser/process-broker";
import { SubprocessBroker } from "../src/subprocess-broker";
import { startRun } from "../src/runner";
import { SubprocessHost } from "../src/subprocess";
import type { RunRequest, SpawnRequest, WorkerMessage } from "../src/worker";

async function until(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 0)); }
  throw new Error("worker startup did not complete");
}

for (const close of ["none", "queued", "reentrant"] as const) for (const alreadyFinishing of [false, true]) test(`page disposal fences legacy and generic roots plus an independent legacy child (root already finishing: ${alreadyFinishing}, close: ${close})`, async () => {
  const previousWorker = globalThis.Worker;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const previousIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const workers: FakeWorker[] = [], events: string[] = [], ports: MessagePort[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
    request?: RunRequest;
    terminated = 0;
    filesystem: boolean;
    constructor(url: string | URL) { this.filesystem = String(url).includes("fs-worker"); workers.push(this); }
    addEventListener() {}
    postMessage(message: RunRequest | { connect: { port: MessagePort } }) {
      if ("connect" in message) ports.push(message.connect.port); else this.request = message;
    }
    terminate() { this.terminated++; events.push(this.filesystem ? "filesystem:stop" : "process:stop"); }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  const runtime = createRuntime({ filesystem: { workerURL: "https://example.test/fs-worker.js", persistence: false } });
  let host: SubprocessHost | undefined;
  let section: FilesystemSection | undefined;
  let entered = false;
  const diagnostics = spyOn(console, "error").mockImplementation(() => {});
  try {
    const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const hooks = { stdout() {}, stderr() {} };
    const legacy = startRun({ runtime, engine: "browser", module, args: [], env: {}, moduleScope: false }, hooks);
    const transport = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
    const generic = startRun({ runtime, engine: "quickjs", module, args: [], env: {}, runtimeProcess: transport, moduleScope: false }, hooks);
    await until(() => workers.filter(worker => worker.request).length === 2);
    const root = workers.find(worker => worker.request?.pid === 1)!;
    host = new SubprocessHost({ identity: runtime.identities.buffer, pid: root.request!.pid, jobId: root.request!.jobId,
      output() {}, launch(meta, child) {
        const request: SpawnRequest = { executable: "bun", argv: meta.argv, cwd: "/", env: {}, pid: child.pid,
          parentPid: root.request!.pid!, jobId: child.jobId, job: -1, filesystem: runtime.filesystem.createIdentity(),
          child, trace: false, spawnBroker: true };
        root.onmessage!({ data: { type: "spawn", request } } as MessageEvent<WorkerMessage>);
        return { terminate() {} };
      },
    });
    const childPid = host.spawn(JSON.stringify({ argv: ["bun"], job: -1 }));
    await until(() => workers.some(worker => worker.request?.pid === childPid));
    section = new FilesystemSection(root.request!.filesystem);
    section.enter(); entered = true;
    let disposal: Promise<void> | undefined;
    if (close === "reentrant") {
      const supervisor = await runtime.processes().then(service => service.ready());
      supervisor.registerRevocation(childPid, () => { disposal = runtime.dispose(); });
    }
    if (close !== "none") root.onmessage!({ data: { type: "child-close", parentPid: root.request!.pid!, pid: childPid } } as MessageEvent<WorkerMessage>);
    if (alreadyFinishing) legacy.kill(15);
    // No drain between the queued close and owner disposal. The reentrant case
    // disposes the same owner synchronously from close's process revocation hook.
    if (close === "reentrant") await until(() => runtime.disposed);
    else disposal = runtime.dispose();
    expect(runtime.disposed).toBe(true);
    await Promise.resolve();
    expect(workers.filter(worker => !worker.filesystem).every(worker => worker.terminated === 0)).toBe(true);
    expect(events).not.toContain("filesystem:stop");
    section.exit(); entered = false;
    await disposal;
    expect(await legacy.done).toEqual({ code: alreadyFinishing ? 143 : 137 });
    expect(await generic.done).toEqual({ code: 137 });
    expect(workers.every(worker => worker.terminated === 1)).toBe(true);
    expect(events.at(-1)).toBe("filesystem:stop");
    expect(diagnostics.mock.calls.map(call => call.map(value => value instanceof Error ? value.stack : value))).toEqual([]);
  } finally {
    diagnostics.mockRestore();
    if (entered) section!.exit();
    host?.detach(); host?.dispose();
    await runtime.dispose();
    for (const worker of workers) worker.request?.filesystem.port.close();
    for (const port of ports) port.close();
    globalThis.Worker = previousWorker;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation); else Reflect.deleteProperty(globalThis, "location");
    if (previousIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", previousIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
  }
});

for (const phase of ["supervisor", "service"] as const) test(`page disposal owns an accepted legacy child's filesystem fence before lazy ${phase} admission`, async () => {
  const previousWorker = globalThis.Worker;
  const ports: MessagePort[] = [];
  let filesystemStops = 0, childStarts = 0;
  globalThis.Worker = class {
    onmessage: ((event: MessageEvent) => void) | null = null;
    addEventListener() {}
    postMessage(message: { connect?: { port: MessagePort } }) {
      if (message.connect) ports.push(message.connect.port);
      else childStarts++;
    }
    terminate() { filesystemStops++; }
  } as unknown as typeof Worker;
  let releaseActivation!: () => void, enteredActivation!: () => void;
  const activation = new Promise<void>(resolve => { releaseActivation = resolve; });
  const entered = new Promise<void>(resolve => { enteredActivation = resolve; });
  const errors: unknown[] = [];
  const unhandled = (error: unknown) => { errors.push(error); };
  process.on("unhandledRejection", unhandled);
  const runtime = createRuntime({ filesystem: { workerURL: "https://example.test/fs-worker.js", persistence: false },
    processHost: options => new BrowserProcessBroker({ ...options, activate: async () => {
      enteredActivation(); await activation; return import("../../runtime/proc");
    } }),
  });
  const broker = new SubprocessBroker("https://example.test/worker.js", runtime);
  let host: SubprocessHost | undefined, section: FilesystemSection | undefined, held = false;
  let disposal: Promise<void> | undefined;
  try {
    if (phase === "supervisor") await broker.prepareRoot();
    host = new SubprocessHost({ pid: 1, jobId: 1, identity: runtime.identities.buffer, output() {}, launch(meta, child) {
      const filesystem = runtime.filesystem.createIdentity();
      section = new FilesystemSection(filesystem); section.enter(); held = true;
      broker.spawn({ executable: "fixture", argv: meta.argv, cwd: "/", env: {}, pid: child.pid, parentPid: 1,
        jobId: child.jobId, job: -1, filesystem, child, trace: false, spawnBroker: true });
      return { terminate() {} };
    } });
    const pid = host.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
    if (phase === "supervisor") await entered;
    disposal = runtime.dispose();
    releaseActivation();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(filesystemStops).toBe(0);
    expect(host.wait(pid)).toBe(137);
    expect(childStarts).toBe(0);
    section!.exit(); held = false;
    await disposal;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(errors.map(error => error instanceof Error ? error.stack : error)).toEqual([]);
    expect(host.wait(pid)).toBe(137);
    expect(childStarts).toBe(0);
    expect(filesystemStops).toBe(1);
  } finally {
    releaseActivation();
    if (held) section!.exit();
    host?.dispose(); broker.dispose();
    try { await (disposal ?? runtime.dispose()); } finally {
      process.off("unhandledRejection", unhandled);
      for (const port of ports) port.close();
      globalThis.Worker = previousWorker;
    }
  }
});

for (const generic of [false, true]) test(`same-task page disposal owns an unadmitted root worker (generic: ${generic})`, async () => {
  const previousWorker = globalThis.Worker;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const previousIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const ports: MessagePort[] = [], workers: { filesystem: boolean; starts: number; stops: number }[] = [];
  class FakeWorker {
    state: { filesystem: boolean; starts: number; stops: number };
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(url: string | URL) { this.state = { filesystem: String(url).includes("fs-worker"), starts: 0, stops: 0 }; workers.push(this.state); }
    addEventListener() {}
    postMessage(message: { connect?: { port: MessagePort }; filesystem?: { port: MessagePort } }) {
      if (message.connect) ports.push(message.connect.port);
      else { this.state.starts++; if (message.filesystem) ports.push(message.filesystem.port); }
    }
    terminate() { this.state.stops++; }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  const runtime = createRuntime({ filesystem: { workerURL: "https://example.test/fs-worker.js", persistence: false } });
  const diagnostics = spyOn(console, "error").mockImplementation(() => {});
  let section: FilesystemSection | undefined, held = false, disposal: Promise<void> | undefined;
  try {
    const transport = generic ? createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer }) : undefined;
    if (transport) {
      const filesystem = runtime.filesystem.createIdentity();
      transport.data = { filesystem };
      section = new FilesystemSection(filesystem); section.enter(); held = true;
    }
    const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const run = startRun({ runtime, engine: "quickjs", module, args: [], env: {}, moduleScope: false, runtimeProcess: transport }, { stdout() {}, stderr() {} });
    // No preparation/microtask drain between physical Worker creation and page disposal.
    disposal = runtime.dispose();
    await new Promise(resolve => setTimeout(resolve, 0));
    if (held) {
      expect(workers.filter(worker => worker.filesystem).every(worker => worker.stops === 0)).toBe(true);
      section!.exit(); held = false;
    }
    await disposal;
    expect(workers.filter(worker => !worker.filesystem)).toHaveLength(1);
    expect(workers.every(worker => worker.stops === 1)).toBe(true);
    expect(workers.every(worker => worker.starts === 0)).toBe(true);
    expect(await run.done).toEqual({ code: 137 });
    expect(diagnostics.mock.calls.map(call => call.map(value => value instanceof Error ? value.stack : value))).toEqual([]);
  } finally {
    if (held) section!.exit();
    await (disposal ?? runtime.dispose());
    diagnostics.mockRestore();
    for (const port of ports) port.close();
    globalThis.Worker = previousWorker;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation); else Reflect.deleteProperty(globalThis, "location");
    if (previousIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", previousIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
  }
});
