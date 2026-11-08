import type { Runtime } from "../../../runtime.js";
import { createGpuFixtureRuntime, gpuFixturePipes } from "./fixture-runtime.js";
import { DescriptorTable } from "../../../core/descriptors.js";
import type { PipeEndpoint } from "../../../proc/pipes.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../../../proc/worker-client.js";
import { createWorkerPipeCodec } from "../../../proc/worker-pipes.js";
import type { RuntimeDisplay, DisplaySurface } from "../../../browser/display/owner.js";
import type { GraphicsGrant, GraphicsOpen } from "../../../browser/display/protocol.js";
import { pressureBurst } from "./qualification-contract.js";
import { ownershipPeerInput } from "./peer-input.js";

interface Run {
  pid: number;
  surface: number;
  authorityToken: string;
  input: PipeEndpoint;
  output: PipeEndpoint;
  grant: GraphicsGrant | undefined;
  text: string;
  imports: unknown[];
}
let runtime: Runtime | undefined;
let display: RuntimeDisplay;
let client: WorkerProcessClient;
let rootPid = 0;
let currentGrant: GraphicsGrant | undefined;
const errors: string[] = [];
const authority: unknown[] = [];
const ownAuthority = new Map<string, unknown[]>();
const workers: {
  url: string;
  worker: Worker;
  stopped: boolean;
  createdAt: number;
}[] = [];
const nativeWorker = Worker;
let descriptors: DescriptorTable;
const notices: WorkerProcessMessage[] = [];
const runs = new Map<number, Run>();
const surfaces = new Map<number, DisplaySurface>();
const canvases = new Map<number, HTMLCanvasElement>();
let lastServiceSnapshot: unknown;
let suppress = false;
let holdMode = "";
const importEvents = new Map<string, unknown[]>();
const disposalGuests = new Map<Worker, { pid: number; token: string; surface: number }>();
const disposalOpens: { grant: number; open: GraphicsOpen }[] = [];
let disposalAudit: SharedArrayBuffer | undefined;
const workerStops: { id: number; url: string; at: number }[] = [];
let disposalArmed = false;
let runtimeEpoch = 0;
let peerPump: ReturnType<typeof setInterval> | undefined;

/** @browserEntry */
export async function openIntegration(
  suppressTransfer = false,
  hold = "",
  freezeSnapshots = false,
) {
  lastServiceSnapshot = freezeSnapshots ? { presents: 0, frameTexturesLive: 0 } : undefined;
  holdMode = hold;
  suppress = suppressTransfer;
  rootPid = 0;
  errors.length = 0;
  workers.length = 0;
  authority.length = 0;
  ownAuthority.clear();
  importEvents.clear();
  disposalOpens.length = workerStops.length = 0;
  disposalAudit = undefined;
  disposalArmed = false;
  disposalGuests.clear();
  globalThis.Worker = class extends nativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      const path = String(url).includes("/gpu/service-worker.ts")
        ? `${holdMode === "ownership" ? "/gpu/service-worker.ts/ownership" : url}?suppress=${suppress ? "1" : "0"}&hold=${holdMode}`
        : url;
      super(path, options);
      workers.push({
        url: String(path),
        worker: this,
        stopped: false,
        createdAt: performance.now(),
      });
      this.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
        if (typeof data !== "object" || data === null) return;
        if ("gpuSnapshot" in data && !freezeSnapshots) lastServiceSnapshot = data.gpuSnapshot;
        if ("gpuImport" in data) recordImport(data.gpuImport);
        if ("gpuAuthority" in data) {
          authority.push(data.gpuAuthority);
          if ("gpuAuthorityToken" in data && typeof data.gpuAuthorityToken === "string")
            ownAuthority.get(data.gpuAuthorityToken)?.push(data.gpuAuthority);
        }
      });
    }
    override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      captureDisposalOpen(message);
      captureDisposalGuest(this, message);
      if (Array.isArray(options)) return super.postMessage(message, options);
      return super.postMessage(message, options);
    }
    override terminate() {
      const found = workers.find((item) => item.worker === this);
      if (found) {
        found.stopped = true;
        workerStops.push({
          id: workers.indexOf(found) + 1,
          url: found.url,
          at: performance.now(),
        });
      }
      return super.terminate();
    }
  };
  runtimeEpoch++;
  runtime = createGpuFixtureRuntime(
    () => currentGrant,
    (error) => errors.push(String(error)),
  );
  for (const name of ["triangle", "scene"]) {
    const source = new Uint8Array(await (await fetch(`/${name}.wasm`)).arrayBuffer());
    runtime.registerProgram(`/bin/${name}`, { adapter: "gpu", source });
    await runtime.filesystem.writeFile(`/bin/${name}`, "registered");
  }
  return {
    workers: workers.map((item) => item.url),
    snapshot: runtime.sharedMemory.snapshot(),
  };
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
    prepareSpawn: () => ({
      data: { filesystem: runtime!.filesystem.createIdentity() },
    }),
  });
  await service.adoptRuntimeRoot(root, {
    memory: [],
    stop: () => descriptors.dispose(),
  });
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
  surfaceSlot = slot,
  suppliedGrant?: GraphicsGrant,
) {
  const service = await root(),
    supervisor = await service.ready();
  const previous = runs.get(slot);
  previous?.input.close();
  previous?.output.close();
  const { input, output } = gpuFixturePipes(descriptors, rootPid);
  currentGrant =
    grant === "none"
      ? undefined
      : (suppliedGrant ??
        display.grant({
          surfaces: [ensureSurface(surfaceSlot)],
          gpu: grant === "gpu",
        }));
  const authorityToken = crypto.randomUUID();
  const imports: unknown[] = [];
  importEvents.set(authorityToken, imports);
  ownAuthority.set(authorityToken, []);
  const pid = client.spawn(rootPid, {
    executable: `/bin/${program}`,
    argv: Array.of<string>(program).concat(args),
    env: {
      GPU_POISON: poison ? "1" : "0",
      GPU_GRANT_QUOTA: args.includes("--grant-quota") ? "1" : "0",
      GPU_FORGE: forge ? "1" : "0",
      GPU_AUTHORITY_TOKEN: authorityToken,
      GPU_OWNERSHIP_TOKEN: holdMode === "ownership" ? authorityToken : "",
      GPU_OWNERSHIP_VICTIM: holdMode === "ownership" && slot === 2 ? "1" : "0",
    },
    cwd: "/",
    job: -1,
    fds: [
      { parent: 0, child: 0 },
      { parent: 1, child: 1 },
      { parent: 2, child: 2 },
    ],
  });
  runs.set(slot, {
    pid,
    surface: ensureSurface(surfaceSlot).id,
    authorityToken,
    input,
    output,
    grant: currentGrant,
    text: "",
    imports,
  });
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
    grantRetired: true,
    physicallyStopped: true,
    pid: run.pid,
    ownAuthority: ownAuthority.get(run.authorityToken) ?? [],
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
export async function closeIntegration(captureRetirement = false) {
  let snapshot: unknown;
  try {
    clearInterval(peerPump);
    peerPump = undefined;
    await runtime?.dispose();
    if (captureRetirement) snapshot = runtime!.sharedMemory.snapshot();
  } finally {
    for (const run of runs.values()) {
      run.input.close();
      run.output.close();
    }
    runs.clear();
    ownAuthority.clear();
    importEvents.clear();
    surfaces.clear();
    for (const canvas of canvases.values()) canvas.remove();
    canvases.clear();
    disposalGuests.clear();
    disposalOpens.length = 0;
    disposalAudit = undefined;
    globalThis.Worker = nativeWorker;
    runtime = undefined;
  }
  if (workers.some((worker) => !worker.stopped)) throw new Error("Integration worker leaked");
  return {
    workers: workers.map(({ url, stopped }) => ({ url, stopped })),
    errors,
    snapshot,
  };
}

/** @browserEntry */
export async function serviceCommand(
  test:
    | "snapshot"
    | "release"
    | "pressure"
    | "fairness-arm"
    | "fairness-settled"
    | "ownership-observe"
    | "ownership-arm"
    | "ownership-snapshot"
    | "ownership-release"
    | "malformed-release"
    | "malformed-late"
    | "admission-coverage"
    | "service-hold-open",
  detail?: {
    token: string;
    surface: number;
    mode:
      | "append"
      | "completions"
      | "header"
      | "chunk"
      | "nesting"
      | "admission"
      | "regrant"
      | "disposal";
  },
) {
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
    worker.postMessage({
      test,
      id,
      ...detail,
      audit: test === "ownership-arm" && detail?.mode === "disposal" ? disposalAudit : undefined,
    });
  });
}

/** @browserEntry */
export function canvasBackground(colour: string, slot = 0) {
  canvases.get(slot)!.style.backgroundColor = colour;
}

function recordImport(value: unknown): void {
  if (
    typeof value !== "object" ||
    value === null ||
    !("token" in value) ||
    typeof value.token !== "string"
  )
    throw new Error("Uncorrelated GPU import observation");
  const events = importEvents.get(value.token);
  if (!events || events.length >= 32768)
    throw new Error("Missing or overflowing GPU import observer");
  events.push(value);
}
/** @browserEntry */
export function quotaAccounting() {
  return runtime!.sharedMemory.snapshot();
}
/** @browserEntry */
export function ownershipGuest(slot = 0) {
  const run = runs.get(slot)!;
  return {
    pid: run.pid,
    token: run.authorityToken,
    surface: run.surface,
    events: run.imports.slice(),
    text: drainTriangle(slot, false).text,
  };
}
/** @browserEntry */
export function ownershipSurface(slot = 0) {
  return ensureSurface(slot).id;
}
/** @browserEntry */
export function ownershipPeer(pump: boolean, interval: 20 | 40 = 20) {
  clearInterval(peerPump);
  peerPump = undefined;
  if (!pump) return;
  let fed = 0;
  peerPump = setInterval(() => {
    const text = drainTriangle(1, false).text;
    const count = text.split("GPU_WAIT_STDIN stage=fairness-peer frame=").length - 1;
    const action = ownershipPeerInput(count, fed);
    if (action === "wait") return;
    if (action !== "feed") {
      if (action === "exceeded")
        errors.push("Ownership peer exceeded its bounded continuous workload");
      clearInterval(peerPump);
      peerPump = undefined;
      return;
    }
    fed = count;
    if (feedTriangle("\n", 1) !== 1) errors.push("Ownership peer input refused");
  }, interval);
}

/** @browserEntry */
export async function regrantTriangle() {
  const previous = runs.get(2)!;
  if (!previous.grant) throw new Error("Regrant needs the original grant");
  let retirementObserved = false;
  void previous.grant.retired().then(() => {
    retirementObserved = true;
  });
  previous.grant.dispose();
  const replacement = display.grant({
    surfaces: [ensureSurface(2)],
    gpu: true,
  });
  const retiredBeforeGrant = retirementObserved;
  const launched = await launchTriangle(
    ["blue"],
    "gpu",
    3,
    true,
    false,
    "triangle",
    2,
    replacement,
  );
  return {
    oldPid: previous.pid,
    replacementPid: launched.pid,
    surface: previous.surface,
    retiredBeforeGrant,
  };
}

function captureDisposalOpen(message: unknown) {
  if (!disposalArmed || typeof message !== "object" || message === null) return;
  if (!("type" in message) || message.type !== "open" || !("open" in message)) return;
  if (!("grant" in message) || typeof message.grant !== "number") return;
  const open = message.open;
  if (typeof open !== "object" || open === null || !("id" in open)) return;
  if (typeof open.id !== "number" || !("control" in open) || !("commands" in open)) return;
  if (!("replies" in open) || !("arena" in open)) return;
  const { control, commands, replies, arena } = open;
  if (
    !(control instanceof SharedArrayBuffer) ||
    !(commands instanceof SharedArrayBuffer) ||
    !(replies instanceof SharedArrayBuffer) ||
    !(arena instanceof SharedArrayBuffer)
  )
    throw new Error("Disposal open observer needs actual shared buffers");
  disposalOpens.push({
    grant: message.grant,
    open: { type: "open", id: open.id, control, commands, replies, arena },
  });
}
/** @browserEntry */
export function observeActiveDisposal() {
  disposalArmed = true;
  disposalAudit = new SharedArrayBuffer(2 * 1024 * 1024);
}
function disposalRing(buffer: SharedArrayBuffer) {
  const publication = Atomics.load(new BigInt64Array(buffer, 0, 1), 0);
  return {
    head: Number(publication & 0xffffffffn),
    tail: Atomics.load(new Int32Array(buffer), 2),
    terminal: Number((publication >> 32n) & 0xffffffffn),
  };
}
function disposalControls() {
  return disposalOpens.map(({ grant, open }) => ({
    grant,
    connection: open.id,
    status: Atomics.load(new Int32Array(open.control), 0),
    reason: Atomics.load(new Int32Array(open.control), 1),
    arenaTerminal: Atomics.load(new Int32Array(open.arena), 0),
    commands: disposalRing(open.commands),
    replies: disposalRing(open.replies),
  }));
}
/** @browserEntry */
export async function disposeActiveIntegration() {
  if (!runtime || !disposalArmed) throw new Error("Active disposal observer not armed");
  const retained = runtime,
    processes = await retained.processes(),
    supervisor = await processes.ready();
  const guests = Array.from(runs.entries(), ([slot, run]) => ({
    slot,
    pid: run.pid,
    token: run.authorityToken,
    surface: run.surface,
    grant: run.grant,
    exit: supervisor.waitForExit(rootPid, run.pid),
  }));
  const workersBefore = disposalWorkers();
  const memoryBefore = processes.workerMemory();
  const controlsBefore = disposalControls();
  clearInterval(peerPump);
  peerPump = undefined;
  const startedAt = performance.now();
  const disposal = retained.dispose();
  const synchronous = {
    disposed: retained.disposed,
    controls: disposalControls(),
    revocations: guests.map(({ pid, grant }) => ({
      pid,
      value: grant ? Atomics.load(new Int32Array(grant.connection.revocation), 0) : -1,
    })),
  };
  await disposal;
  const finishedAt = performance.now();
  const exits = await Promise.all(
    guests.map(async ({ slot, pid, token, surface, grant, exit }) => {
      await grant?.retired();
      return {
        slot,
        pid,
        token,
        surface,
        exit: await exit,
        grantRetired: grant !== undefined,
        events: importEvents.get(token)?.slice() ?? [],
      };
    }),
  );
  const stopped = {
    disposed: retained.disposed,
    workers: disposalWorkers(),
    controls: disposalControls(),
    snapshot: retained.sharedMemory.snapshot(),
    audits: readDisposalAudits(),
  };
  await new Promise((resolve) => setTimeout(resolve, 100));
  pressureBurst();
  const after = {
    workers: disposalWorkers(),
    controls: disposalControls(),
    snapshot: retained.sharedMemory.snapshot(),
    audits: readDisposalAudits(),
  };
  return {
    startedAt,
    finishedAt,
    workersBefore,
    memoryBefore,
    controlsBefore,
    synchronous,
    exits,
    stopped,
    after,
    workerStops: workerStops.slice(),
    errors: errors.slice(),
  };
}

function readDisposalAudit(slot: number): unknown {
  const buffer = disposalAudit;
  if (!buffer) throw new Error("Missing disposal audit backing");
  const length = Atomics.load(new Int32Array(buffer, slot * 1048576, 1), 0);
  if (length <= 0 || length > 1048572) throw new Error(`Missing disposal audit ${slot}: ${length}`);
  const copy = new Uint8Array(buffer, slot * 1048576 + 4, length).slice();
  return JSON.parse(new TextDecoder().decode(copy));
}
function readDisposalAudits(): unknown[] {
  return [0, 1].map(readDisposalAudit);
}
/** @browserEntry */
export function activeDisposalAuditControl() {
  return readDisposalAudit(0);
}

function disposalWorkers() {
  return workers.map(({ url, stopped, worker, createdAt }, index) => ({
    id: index + 1,
    url,
    stopped,
    createdAt,
    ...disposalGuests.get(worker),
  }));
}
function captureDisposalGuest(worker: Worker, message: unknown) {
  if (!disposalArmed || typeof message !== "object" || message === null) return;
  if (!("runtimeProcess" in message) || !("env" in message) || !("graphics" in message)) return;
  const process = message.runtimeProcess,
    env = message.env,
    graphics = message.graphics;
  if (typeof process !== "object" || process === null || !("pid" in process)) return;
  if (typeof env !== "object" || env === null || !("GPU_AUTHORITY_TOKEN" in env)) return;
  if (typeof graphics !== "object" || graphics === null || !("surfaces" in graphics)) return;
  if (!Array.isArray(graphics.surfaces) || graphics.surfaces.length !== 1) return;
  const surface: unknown = graphics.surfaces[0];
  if (typeof surface !== "object" || surface === null || !("id" in surface)) return;
  if (
    typeof process.pid !== "number" ||
    typeof env.GPU_AUTHORITY_TOKEN !== "string" ||
    typeof surface.id !== "number"
  )
    return;
  disposalGuests.set(worker, {
    pid: process.pid,
    token: env.GPU_AUTHORITY_TOKEN,
    surface: surface.id,
  });
}

/** @browserEntry */
export function serviceFailureState() {
  return {
    audit: activeDisposalAuditControl(),
    runtimeEpoch,
    disposed: runtime!.disposed,
    workers: disposalWorkers(),
    controls: disposalControls(),
    workerStops: workerStops.slice(),
    revocations: Array.from(runs.values(), (run) => ({
      pid: run.pid,
      value: run.grant ? Atomics.load(new Int32Array(run.grant.connection.revocation), 0) : -1,
    })),
    snapshot: runtime!.sharedMemory.snapshot(),
  };
}
/** @browserEntry */
export async function failGpuService() {
  const entry = workers.find(
    (item) => item.url.includes("/gpu/service-worker.ts") && !item.stopped,
  );
  if (!entry || !runtime || runtime.disposed)
    throw new Error("Missing live service failure target");
  const before = serviceFailureState(),
    id = crypto.randomUUID();
  const error = new Promise<{
    trusted: boolean;
    message: string;
    at: number;
    worker: number;
  }>((resolve, reject) => {
    const observed = (event: ErrorEvent) => {
      clearTimeout(timer);
      resolve({
        trusted: event.isTrusted,
        message: event.message,
        at: performance.now(),
        worker: workers.indexOf(entry) + 1,
      });
    };
    const timer = setTimeout(() => {
      entry.worker.removeEventListener("error", observed);
      reject(new Error("Service failure event deadline"));
    }, 10000);
    entry.worker.addEventListener("error", observed, { once: true });
  });
  const startedAt = performance.now();
  entry.worker.postMessage({ test: "service-failure", id });
  const fault = await error;
  await Promise.all(Array.from(runs.values(), (run) => run.grant!.retired()));
  clearInterval(peerPump);
  peerPump = undefined;
  const stopped = serviceFailureState();
  const exits = [];
  for (const slot of [1, 2, 3]) {
    feedTriangle("\n", slot);
    const exit = await stopTriangle(false, slot, false);
    exits.push({ slot, guest: ownershipGuest(slot), ...exit });
  }
  entry.worker.postMessage({
    test: "ownership-release",
    id: crypto.randomUUID(),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  pressureBurst();
  return {
    id,
    startedAt,
    before,
    fault,
    stopped,
    exits,
    after: serviceFailureState(),
    audit: activeDisposalAuditControl(),
  };
}
