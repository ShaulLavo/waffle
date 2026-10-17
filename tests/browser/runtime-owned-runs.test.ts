import { expect, test } from "bun:test";
import { createRuntime } from "@bun-wasm/runtime";
import { FilesystemSection } from "@bun-wasm/runtime/fs/protocol";
import { createWorkerProcessTransport } from "@bun-wasm/runtime/proc/worker-client";
import { startRun } from "../src/runner";
import { SubprocessHost } from "../src/subprocess";
import type { RunRequest, SpawnRequest, WorkerMessage } from "../src/worker";

async function until(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 0)); }
  throw new Error("worker startup did not complete");
}

test("page disposal fences active legacy and generic roots plus an independent legacy child before stopping consumers", async () => {
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
    const disposal = runtime.dispose();
    expect(runtime.disposed).toBe(true);
    await Promise.resolve();
    expect(workers.filter(worker => !worker.filesystem).every(worker => worker.terminated === 0)).toBe(true);
    expect(events).not.toContain("filesystem:stop");
    section.exit(); entered = false;
    await disposal;
    expect(await legacy.done).toEqual({ code: 137 });
    expect(await generic.done).toEqual({ code: 137 });
    expect(workers.every(worker => worker.terminated === 1)).toBe(true);
    expect(events.at(-1)).toBe("filesystem:stop");
  } finally {
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
