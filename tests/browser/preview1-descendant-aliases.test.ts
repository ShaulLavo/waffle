import { expect, test } from "bun:test";
import { DescriptorTable } from "@bun-wasm/runtime/core/descriptors";
import { createFilesystemIdentity } from "@bun-wasm/runtime/fs";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState, type WorkerProcessMessage } from "@bun-wasm/runtime/proc/worker-client";
import { WorkerPipeHost } from "@bun-wasm/runtime/proc/worker-pipes";
import type { PipeEndpoint } from "@bun-wasm/runtime/proc/pipes";
import type { RuntimeWorkerRequest } from "@bun-wasm/runtime/browser/worker";
import type { RuntimeFilesystem } from "@bun-wasm/runtime";
import { SubprocessBroker } from "../src/subprocess-broker";
import { processRuntimeFixture } from "./process-runtime-fixture";

async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 0)); }
  throw new Error("descendant launch did not settle");
}

test("recursive Preview1 aliases retain inherited writers across ordinary parent exit before admission", async () => {
  const originalWorker = globalThis.Worker;
  const ports: MessagePort[] = [];
  const workers = new Map<number, FakeWorker>();
  const tables: DescriptorTable[] = [];
  class FakeWorker {
    onmessage?: (event: MessageEvent) => void;
    request!: RuntimeWorkerRequest;
    constructor(readonly url: string) {}
    postMessage(request: RuntimeWorkerRequest) {
      this.request = request;
      workers.set(workerProcessState(request.runtimeProcess!).pid, this);
    }
    terminate() {}
    exit() { this.onmessage?.({ data: { type: "exit", code: 0 } } as MessageEvent); }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const runtime = processRuntimeFixture({
    connect(identity) { const channel = new MessageChannel(); ports.push(channel.port1, channel.port2); return { ...identity, port: channel.port1 }; },
    revoke() {}, reap() {}, async quiesce() {},
  } as RuntimeFilesystem);
  const root = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
  root.data = { filesystem: createFilesystemIdentity() };
  const broker = new SubprocessBroker("https://example.test/worker.js", runtime, { engine: "browser", aliasExecutable: "preview1-root" });
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  broker.register("preview1-root", { module, adapter: "preview1", cooperative: true });
  try {
    await broker.adoptRuntimeRoot(root);
    const service = await runtime.processes(), supervisor = await service.ready();
    const pending: WorkerProcessMessage[] = [];
    const post = (message: WorkerProcessMessage) => { pending.push(message); };
    const makeClient = (transport: typeof root) => {
      const descriptors = new DescriptorTable(); tables.push(descriptors);
      const registry = (transport.data as { pipeRegistry: ConstructorParameters<typeof WorkerPipeHost>[0]["registry"] }).pipeRegistry;
      const pipes = new WorkerPipeHost({ transport, registry, postMessage: post });
      const client = new WorkerProcessClient({ transport, descriptors, codec: pipes.codec(), postMessage: post,
        prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(), pipeRegistry: pipes.registry.handle() } }),
      });
      client.installBindings();
      return { client, descriptors, pipes };
    };
    const parent = makeClient(root);
    const [reader, writer] = parent.pipes.createPipe();
    const fd = parent.descriptors.open(writer, 0xffffn, 0xffffn);
    const leaderPid = parent.client.spawn(parent.client.pid, { executable: "bun", argv: ["leader"], env: {}, cwd: "/", job: 0, fds: [{ child: 1, parent: fd }] });
    parent.descriptors.close(fd);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(-6);
    for (const message of pending.splice(0)) await broker.runtimeMessage(message, parent.client.pid);
    await until(() => workers.has(leaderPid));
    const leaderWorker = workers.get(leaderPid)!;
    expect(leaderWorker.request.interruptible).toBe(false);
    const leader = makeClient(leaderWorker.request.runtimeProcess!);
    const descendantPid = leader.client.spawn(leaderPid, { executable: "bun", argv: ["descendant"], env: {}, cwd: "/", job: workerProcessState(leaderWorker.request.runtimeProcess!).job, fds: [{ child: 1, parent: 1 }] });
    // The guest retains its child's writer synchronously, before either the spawn notification
    // reaches the page or the parent's ordinary completion closes its own transferred lifetime.
    leader.descriptors.dispose();
    leaderWorker.exit();
    expect(reader.tryRead([new Uint8Array(1)])).toBe(-6);
    const spawn = pending.shift()!;
    leaderWorker.onmessage!({ data: spawn } as MessageEvent);
    await until(() => workers.has(descendantPid) || !!supervisor.get(descendantPid)?.result);
    const descendantWorker = workers.get(descendantPid);
    expect(descendantWorker).toBeDefined();
    expect(descendantWorker!.url).toBe("https://example.test/preview1-worker.js");
    expect(supervisor.get(descendantPid)!.request!.executable).toBe("preview1-root");
    const descendant = makeClient(descendantWorker!.request.runtimeProcess!);
    const output = descendant.descriptors.get(1)!.resource as PipeEndpoint;
    expect(output.tryWrite([new Uint8Array([68])])).toBe(1);
    const bytes = new Uint8Array(1);
    await until(() => reader.readiness().readable);
    expect(reader.tryRead([bytes])).toBe(1);
    expect(bytes[0]).toBe(68);
    descendant.descriptors.dispose(); descendantWorker!.exit();
    await until(() => reader.readiness().hangup);
    expect(reader.tryRead([bytes])).toBe(0);
    reader.close();
  } finally {
    for (const table of tables) table.dispose();
    broker.dispose(); await runtime.dispose();
    for (const port of ports) port.close();
    globalThis.Worker = originalWorker;
  }
});
