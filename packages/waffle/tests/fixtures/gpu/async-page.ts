import { createRuntime, type Runtime } from "../../../runtime.js";
import { BrowserProcessBroker } from "../../../browser/process-broker.js";
import type { GraphicsGrant } from "../../../browser/display/protocol.js";
import { DescriptorTable } from "../../../core/descriptors.js";
import { RIGHTS_ALL } from "../../../core/rights.js";
import { PipeController, type PipeEndpoint } from "../../../proc/pipes.js";
import {
  WorkerProcessClient,
  createWorkerProcessTransport,
  type WorkerProcessMessage,
} from "../../../proc/worker-client.js";
import { createWorkerPipeCodec } from "../../../proc/worker-pipes.js";
import { bytes, declareSharedMemoryPlatform } from "../../../memory/index.js";

type Run = {
  pid: number;
  input: PipeEndpoint;
  output: PipeEndpoint;
  grant: GraphicsGrant;
  text: string;
};
let runtime: Runtime | undefined;
let client: WorkerProcessClient;
let descriptors: DescriptorTable;
let rootPid = 0;
let grant: GraphicsGrant | undefined;
const notices: WorkerProcessMessage[] = [];
const runs = new Map<number, Run>();
const errors: string[] = [];
const workers: { worker: Worker; url: string; stopped: boolean }[] = [];
const NativeWorker = Worker;

/** @browserEntry */
export async function openAsync() {
  if (runtime) throw new Error("Async runtime already open");
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      workers.push({ worker: this, url: String(url), stopped: false });
    }
    override terminate() {
      const owner = workers.find((entry) => entry.worker === this);
      if (owner) owner.stopped = true;
      return super.terminate();
    }
  };
  runtime = createRuntime({
    sharedMemory: declareSharedMemoryPlatform({
      kind: "bounded",
      budgetBytes: bytes(3 * 1024 ** 3),
      counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
    }),
    filesystem: { mode: "memory", workerURL: "/fs-worker.js" },
    processHost: (options) =>
      new BrowserProcessBroker({ ...options, onError: (error) => errors.push(String(error)) }),
  });
  runtime.registerAdapter("gpu", (context, service) =>
    service.launchWorker(context, {
      workerUrl: "/gpu-guest.js",
      graphics: grant,
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        interruptible: context.interruptible,
      },
    }),
  );
  const response = await fetch("/async.wasm");
  if (!response.ok) throw new Error("Missing verified C async fixture");
  runtime.registerProgram("/bin/async", {
    adapter: "gpu",
    source: new Uint8Array(await response.arrayBuffer()),
  });
  await runtime.filesystem.writeFile("/bin/async", "registered");
  const service = await runtime.processes();
  descriptors = new DescriptorTable();
  const root = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
    capacity: 32,
  });
  root.data = { filesystem: runtime.filesystem.createIdentity() };
  rootPid = root.pid;
  client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: createWorkerPipeCodec(),
    postMessage: (message) => notices.push(message),
    prepareSpawn: () => ({ data: { filesystem: readyRuntime().filesystem.createIdentity() } }),
  });
  await service.adoptRuntimeRoot(root, { memory: [], stop: () => descriptors.dispose() });
  await runtime.display();
}
function readyRuntime(): Runtime {
  if (!runtime) throw new Error("Async runtime not open");
  return runtime;
}
/** @browserEntry */
export async function launchAsync(args: string[] = [], slot = 0) {
  if (runs.has(slot)) throw new Error("Async slot still owned");
  const runtime = readyRuntime(),
    service = await runtime.processes(),
    supervisor = await service.ready();
  const stdout = new PipeController({ relay: "manual" }),
    stdin = new PipeController({ relay: "manual" });
  const input = stdin.retain(rootPid, "write"),
    output = stdout.retain(rootPid, "read");
  descriptors.close(0);
  descriptors.close(1);
  descriptors.close(2);
  descriptors.openAt(0, stdin.retain(rootPid, "read"), RIGHTS_ALL, RIGHTS_ALL);
  descriptors.openAt(1, stdout.retain(rootPid, "write"), RIGHTS_ALL, RIGHTS_ALL);
  descriptors.openAt(2, stdout.retain(rootPid, "write"), RIGHTS_ALL, RIGHTS_ALL);
  grant = (await runtime.display()).grant({ surfaces: [], gpu: true });
  const pid = client.spawn(rootPid, {
    executable: "/bin/async",
    argv: ["async"].concat(args),
    env: {},
    cwd: "/",
    job: -1,
    fds: [
      { parent: 0, child: 0 },
      { parent: 1, child: 1 },
      { parent: 2, child: 2 },
    ],
  });
  runs.set(slot, { pid, input, output, grant, text: "" });
  while (notices.length) await service.runtimeMessage(notices.shift()!, rootPid);
  await supervisor.start(pid);
  return { pid };
}
function run(slot: number): Run {
  const value = runs.get(slot);
  if (!value) throw new Error("Unknown async guest slot");
  return value;
}
/** @browserEntry */
export function drainAsync(slot = 0) {
  const value = run(slot),
    buffer = new Uint8Array(8192);
  for (let part = 0; part < 32; part++) {
    const count = value.output.tryRead([buffer]);
    if (count <= 0) break;
    value.text += new TextDecoder().decode(buffer.subarray(0, count));
  }
  return { text: value.text, errors: errors.slice() };
}
/** @browserEntry */
export function revokeAsync(slot = 0) {
  run(slot).grant.dispose();
}
/** @browserEntry */
export async function finishAsync(slot = 0, kill = false) {
  const value = run(slot),
    runtime = readyRuntime(),
    service = await runtime.processes(),
    supervisor = await service.ready();
  if (kill) await service.kill(value.pid, 9);
  const exit = await supervisor.waitForExit(rootPid, value.pid);
  await value.grant.retired();
  const deadline = performance.now() + 10000;
  while (service.workerMemory().some((worker) => worker.pid === value.pid)) {
    if (performance.now() > deadline) throw new Error("Async guest physical cleanup deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const result = { exit, ...drainAsync(slot), snapshot: runtime.sharedMemory.snapshot() };
  value.input.close();
  value.output.close();
  runs.delete(slot);
  return result;
}
/** @browserEntry */
export async function closeAsync() {
  try {
    await runtime?.dispose();
  } finally {
    for (const value of runs.values()) {
      value.input.close();
      value.output.close();
    }
    runs.clear();
    runtime = undefined;
    globalThis.Worker = NativeWorker;
  }
  if (workers.some((owner) => !owner.stopped)) throw new Error("Async fixture leaked a Worker");
  return { errors: errors.slice(), workers: workers.map(({ url, stopped }) => ({ url, stopped })) };
}
/** @browserEntry */
export function resumeAsync(slot = 0) {
  return run(slot).input.tryWrite([new Uint8Array([10])]);
}
