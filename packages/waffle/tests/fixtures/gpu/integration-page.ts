import { createRuntime, type Runtime } from "../../../runtime.js";
import { BrowserProcessBroker } from "../../../browser/process-broker.js";
import { DescriptorTable } from "../../../core/descriptors.js";
import { RIGHTS_ALL } from "../../../core/rights.js";
import { PipeController, type PipeEndpoint } from "../../../proc/pipes.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../../../proc/worker-client.js";
import { createWorkerPipeCodec } from "../../../proc/worker-pipes.js";
import type { RuntimeDisplay, DisplaySurface } from "../../../browser/display/owner.js";
import type { GraphicsGrant } from "../../../browser/display/protocol.js";
import { bytes, declareSharedMemoryPlatform } from "../../../memory/index.js";
import { pressureBurst } from "./qualification-contract.js";

interface Run {
  pid: number;
  input: PipeEndpoint;
  output: PipeEndpoint;
  grant: GraphicsGrant | undefined;
  text: string;
}
let runtime: Runtime | undefined;
let display: RuntimeDisplay;
let client: WorkerProcessClient;
let rootPid = 0;
let currentGrant: GraphicsGrant | undefined;
const errors: string[] = [];
const authority: unknown[] = [];
const workers: { url: string; worker: Worker; stopped: boolean }[] = [];
const nativeWorker = Worker;
let descriptors: DescriptorTable;
const notices: WorkerProcessMessage[] = [];
const runs = new Map<number, Run>();
const surfaces = new Map<number, DisplaySurface>();
const canvases = new Map<number, HTMLCanvasElement>();
let lastServiceSnapshot: unknown;
let suppress = false;
let holdMode = "";

/** @browserEntry */
export async function openIntegration(suppressTransfer = false, hold = "") {
  holdMode = hold;
  suppress = suppressTransfer;
  rootPid = 0;
  errors.length = 0;
  workers.length = 0;
  authority.length = 0;
  globalThis.Worker = class extends nativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      const path = String(url).includes("/gpu/service-worker.ts")
        ? `${url}?suppress=${suppress ? "1" : "0"}&hold=${holdMode}`
        : url;
      super(path, options);
      workers.push({ url: String(path), worker: this, stopped: false });
      this.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
        if (typeof data !== "object" || data === null) return;
        if ("gpuSnapshot" in data) lastServiceSnapshot = data.gpuSnapshot;
        if ("gpuAuthority" in data) authority.push(data.gpuAuthority);
      });
    }
    override terminate() {
      const found = workers.find((item) => item.worker === this);
      if (found) found.stopped = true;
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
      graphics: currentGrant,
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        interruptible: context.interruptible,
      },
    }),
  );
  for (const name of ["triangle", "scene"]) {
    const source = new Uint8Array(await (await fetch(`/${name}.wasm`)).arrayBuffer());
    runtime.registerProgram(`/bin/${name}`, { adapter: "gpu", source });
    await runtime.filesystem.writeFile(`/bin/${name}`, "registered");
  }
  return { workers: workers.map((item) => item.url), snapshot: runtime.sharedMemory.snapshot() };
}
/** @browserEntry */
export async function activateDisplay() {
  display = await runtime!.display();
  ensureSurface(0);
  return workers.map((item) => item.url);
}
function ensureSurface(slot: number): DisplaySurface {
  const found = surfaces.get(slot);
  if (found) return found;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  canvas.id = `triangle-${slot}`;
  document.body.append(canvas);
  canvases.set(slot, canvas);
  const surface = display.createSurface(canvas);
  surfaces.set(slot, surface);
  return surface;
}
async function root() {
  const service = await runtime!.processes();
  if (rootPid) return service;
  descriptors = new DescriptorTable();
  const root = createWorkerProcessTransport({
    pid: runtime!.identities.pid(),
    job: runtime!.identities.job(),
    identity: runtime!.identities.buffer,
    capacity: 32,
  });
  root.data = { filesystem: runtime!.filesystem.createIdentity() };
  rootPid = root.pid;
  client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: createWorkerPipeCodec(),
    postMessage: (message) => notices.push(message),
    prepareSpawn: () => ({ data: { filesystem: runtime!.filesystem.createIdentity() } }),
  });
  await service.adoptRuntimeRoot(root, { memory: [], stop: () => descriptors.dispose() });
  return service;
}
/** @browserEntry */
export async function launchTriangle(
  args: string[] = [],
  grant: "gpu" | "surface" | "none" = "gpu",
  slot = 0,
  poison = false,
  forge = false,
  program: "triangle" | "scene" = "triangle",
) {
  const service = await root(),
    supervisor = await service.ready();
  const previous = runs.get(slot);
  previous?.input.close();
  previous?.output.close();
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
  currentGrant =
    grant === "none"
      ? undefined
      : display.grant({ surfaces: [ensureSurface(slot)], gpu: grant === "gpu" });
  const pid = client.spawn(rootPid, {
    executable: `/bin/${program}`,
    argv: Array.of<string>(program).concat(args),
    env: { GPU_POISON: poison ? "1" : "0", GPU_FORGE: forge ? "1" : "0" },
    cwd: "/",
    job: -1,
    fds: [
      { parent: 0, child: 0 },
      { parent: 1, child: 1 },
      { parent: 2, child: 2 },
    ],
  });
  runs.set(slot, { pid, input, output, grant: currentGrant, text: "" });
  while (notices.length) await service.runtimeMessage(notices.shift()!, rootPid);
  await supervisor.start(pid);
  return { pid };
}
/** @browserEntry */
export function launchScene(args: string[] = [], grant: "gpu" | "surface" | "none" = "gpu") {
  return launchTriangle(args, grant, 0, true, false, "scene");
}
/** @browserEntry */
export function drainTriangle(slot = 0, detailed = true) {
  const run = runs.get(slot)!;
  const bytes = new Uint8Array(8192);
  for (let part = 0; part < 32; part++) {
    const count = run.output.tryRead([bytes]);
    if (count <= 0) break;
    run.text += new TextDecoder().decode(bytes.subarray(0, count));
  }
  return {
    text: run.text,
    errors,
    authority,
    snapshot: detailed ? runtime!.sharedMemory.snapshot() : undefined,
    service: lastServiceSnapshot,
    workers: workers.map(({ url, stopped }) => ({ url, stopped })),
  };
}
/** @browserEntry */
export function feedTriangle(text = "\n", slot = 0) {
  return runs.get(slot)!.input.tryWrite([new TextEncoder().encode(text)]);
}
/** @browserEntry */
export async function stopTriangle(kill = false, slot = 0, feed = true) {
  const run = runs.get(slot)!,
    service = await runtime!.processes(),
    supervisor = await service.ready();
  if (kill) await service.kill(run.pid, 9);
  else if (feed) feedTriangle("\n", slot);
  const exit = await supervisor.waitForExit(rootPid, run.pid);
  await run.grant?.retired();
  const deadline = performance.now() + 10000;
  while (service.workerMemory().some((worker) => worker.pid === run.pid)) {
    if (performance.now() > deadline) throw new Error("Physical guest cleanup deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const snapshot = await serviceCommand("snapshot");
  return {
    exit,
    snapshot: runtime!.sharedMemory.snapshot(),
    service: snapshot,
    text: drainTriangle(slot).text,
    authority,
  };
}
/** @browserEntry */
export function pressure() {
  return pressureBurst();
}
/** @browserEntry */
export async function closeIntegration() {
  try {
    await runtime?.dispose();
  } finally {
    for (const run of runs.values()) {
      run.input.close();
      run.output.close();
    }
    runs.clear();
    surfaces.clear();
    for (const canvas of canvases.values()) canvas.remove();
    canvases.clear();
    globalThis.Worker = nativeWorker;
    runtime = undefined;
  }
  if (workers.some((worker) => !worker.stopped)) throw new Error("Integration worker leaked");
  return { workers: workers.map(({ url, stopped }) => ({ url, stopped })), errors };
}

/** @browserEntry */
export async function serviceCommand(test: "snapshot" | "release" | "pressure") {
  const worker = workers.find(
    (entry) => entry.url.includes("/gpu/service-worker.ts") && !entry.stopped,
  )?.worker;
  if (!worker) return undefined;
  const id = crypto.randomUUID();
  return new Promise<unknown>((resolve, reject) => {
    const done = ({ data }: MessageEvent<unknown>) => {
      if (
        typeof data !== "object" ||
        data === null ||
        !("testId" in data) ||
        data.testId !== id ||
        !("gpuSnapshot" in data)
      )
        return;
      clearTimeout(timer);
      worker.removeEventListener("message", done);
      resolve(data.gpuSnapshot);
    };
    const timer = setTimeout(() => {
      worker.removeEventListener("message", done);
      reject(new Error("Service command deadline"));
    }, 10000);
    worker.addEventListener("message", done);
    worker.postMessage({ test, id });
  });
}

/** @browserEntry */
export function canvasBackground(colour: string, slot = 0) {
  canvases.get(slot)!.style.backgroundColor = colour;
}
