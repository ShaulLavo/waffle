import { testSharedMemory } from "./fixtures/shared-memory-platform.js";
import { createRuntime, type Runtime, type RuntimeSupervisor } from "../runtime.js";
import { DescriptorTable } from "../core/descriptors.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { WorkerPipeHost } from "../proc/worker-pipes.js";
import type { FilesystemIdentity } from "../fs/protocol.js";
import {
  auditFilesystem,
  assertFilesystemStopped,
  assertFilesystemQuiet,
} from "./filesystem-stop-observer.js";
import {
  CONTROL_CHUNKS,
  CONTROL_FENCED,
  CONTROL_HEARTBEAT,
  CONTROL_LIVE_SHARDS,
  CONTROL_WORDS,
  ShardPool,
  ShardPoolError,
  processFence,
  type ShardFailureReason,
} from "../search/shards.js";
import type {
  SearchDiagnosticsMessage,
  SearchWorkerRequest,
} from "./fixtures/search-count-worker.js";

const SEARCH_WORKER = "/search-worker.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const pause = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(ready: () => boolean, label: string, ms = 20_000): Promise<void> {
  const end = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${label}`);
    await pause();
  }
}

/** Exports memory and an empty _start: the admitted module the host program runs in place of. */
function admittedModule(): Uint8Array {
  return new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109,
    101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
  ]);
}

interface Termination extends Readonly<ReturnType<typeof auditFilesystem>> {
  readonly liveShards: number;
  readonly fenced: boolean;
}
interface Launch {
  readonly pid: number;
  readonly filesystem: FilesystemIdentity;
  control?: Int32Array;
  shards?: number;
  /** Audited when the exit acknowledgement arrives, before the page reaps the identity. */
  acknowledged?: Termination;
  terminated?: Termination;
  /** How long helper activity continued after the process Worker was stopped. */
  quietMs?: number;
}

function audit(identity: FilesystemIdentity, control: Int32Array): Termination {
  return {
    ...auditFilesystem(identity),
    liveShards: Atomics.load(control, CONTROL_LIVE_SHARDS),
    fenced: Atomics.load(control, CONTROL_FENCED) === 1,
  };
}

/** Tracks every search process Worker; audits its identity at the moment the page stops it. */
function trackSearchWorkers(launches: Map<SharedArrayBuffer, Launch>) {
  const NativeWorker = globalThis.Worker;
  const controls = new WeakMap<Worker, SharedArrayBuffer>();
  const created: Worker[] = [];
  const stopped = new Set<Worker>();
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      if (String(url) !== SEARCH_WORKER) return;
      created.push(this);
      // Registered before the broker's onmessage, so this runs before it reaps the identity.
      this.addEventListener("message", ({ data }) => {
        if (data?.type === "search-diagnostics") controls.set(this, data.control);
        if (data?.type !== "exit" && data?.type !== "error" && data?.type !== "cleanup-error")
          return;
        const control = controls.get(this);
        const launch = control && launches.get(control);
        if (launch) launch.acknowledged ??= audit(launch.filesystem, new Int32Array(control));
      });
    }
    override terminate() {
      const control = controls.get(this);
      const launch = control && launches.get(control);
      if (launch && !launch.terminated)
        launch.terminated = audit(launch.filesystem, new Int32Array(control));
      stopped.add(this);
      super.terminate();
    }
  };
  return {
    restore: () => {
      globalThis.Worker = NativeWorker;
    },
    leaked: () => created.filter((worker) => !stopped.has(worker)).length,
  };
}

class Harness {
  readonly byPid = new Map<number, Launch>();
  readonly output = new Map<number, number[]>();
  readonly descriptors = new DescriptorTable();
  private readonly notices: WorkerProcessMessage[] = [];
  shards: number | null = 4;
  shardWorker = "/shard-worker.js";
  private supervisor!: RuntimeSupervisor;
  private client!: WorkerProcessClient;
  pipes!: WorkerPipeHost;
  private root = createWorkerProcessTransport();
  private stdout: number[] = [];
  private constructor(
    readonly runtime: Runtime,
    private readonly launches: Map<SharedArrayBuffer, Launch>,
  ) {}
  static async create(launches: Map<SharedArrayBuffer, Launch>): Promise<Harness> {
    const runtime = createRuntime({
      sharedMemory: testSharedMemory,
      filesystem: { workerURL: "/fs-worker.js", mode: "memory" },
    });
    const harness = new Harness(runtime, launches);
    await harness.start();
    return harness;
  }
  private async start(): Promise<void> {
    const runtime = this.runtime;
    runtime.registerAdapter("search", (context, service) => {
      const launch: Launch = {
        pid: context.pid,
        filesystem: service.networkPathScope(context, 0).filesystem,
      };
      this.byPid.set(context.pid, launch);
      return service.launchWorker<SearchWorkerRequest>(context, {
        workerUrl: SEARCH_WORKER,
        request: {
          module: context.module,
          args: context.request.argv,
          env: context.request.env,
          interruptible: context.interruptible,
          search: { shardWorker: this.shardWorker, shards: this.shards, diagnostics: true },
        },
        onMessage: (message) => {
          const data = message as SearchDiagnosticsMessage;
          if (data?.type !== "search-diagnostics") return;
          launch.control = new Int32Array(data.control);
          launch.shards = data.shards;
          this.launches.set(data.control, launch);
        },
      });
    });
    runtime.registerProgram("/usr/bin/count", { adapter: "search", source: admittedModule() });
    await runtime.filesystem.writeFile("/usr/bin/count", admittedModule());
    this.root = createWorkerProcessTransport({
      pid: runtime.identities.pid(),
      job: runtime.identities.job(),
      identity: runtime.identities.buffer,
    });
    this.root.data = { filesystem: runtime.filesystem.createIdentity() };
    const service = await runtime.processes();
    await service.adoptRuntimeRoot(this.root, { memory: [] });
    this.pipes = new WorkerPipeHost({
      transport: this.root,
      registry: (this.root.data as { pipeRegistry: never }).pipeRegistry,
      postMessage: (message) => this.notices.push(message),
      pipe: { capacity: 256, maxWriters: 4, maxReaders: 4 },
    });
    this.client = new WorkerProcessClient({
      transport: this.root,
      descriptors: this.descriptors,
      codec: this.pipes.codec(),
      postMessage: (message) => this.notices.push(message),
      prepareSpawn: (pid) => {
        this.pipes.registry.registerProcess(pid);
        return {
          data: {
            filesystem: runtime.filesystem.createIdentity(),
            pipeRegistry: this.pipes.registry.handle(),
          },
          cancel: () => this.pipes.registry.collectProcess(pid),
        };
      },
    });
    this.supervisor = await service.ready();
  }
  get text(): string {
    return new TextDecoder().decode(new Uint8Array(this.stdout));
  }
  resetOutput(): void {
    this.stdout = [];
  }
  /** Spawns with stdout and stderr on one page-drained pipe, or stdout on a caller's writer. */
  async spawn(
    argv: string[],
    stdout?: ReturnType<WorkerPipeHost["createPipe"]>[1],
  ): Promise<number> {
    const [reader, writer] = stdout ? [undefined, stdout] : this.pipes.createPipe();
    const fd = this.descriptors.open(writer, 127n, 63n);
    const fds = [{ parent: fd, child: 1 }].concat(stdout ? [] : [{ parent: fd, child: 2 }]);
    let pid: number;
    try {
      pid = this.client.spawn(this.root.pid, {
        executable: "/usr/bin/count",
        argv,
        env: {},
        cwd: "/",
        job: -1,
        fds,
      });
    } finally {
      this.descriptors.close(fd);
    }
    if (reader) this.drains.set(pid, this.drain(reader));
    const service = await this.runtime.processes();
    while (this.notices.length) await service.runtimeMessage(this.notices.shift()!, this.root.pid);
    await this.supervisor.start(pid);
    return pid;
  }
  private readonly drains = new Map<number, Promise<void>>();
  private async drain(reader: ReturnType<WorkerPipeHost["createPipe"]>[0]): Promise<void> {
    const buffer = new Uint8Array(4096);
    try {
      for (;;) {
        const read = reader.tryRead!([buffer]);
        if (read === 0) return;
        if (read < 0) await pause(1);
        for (let i = 0; i < read; i++) this.stdout.push(buffer[i]!);
      }
    } finally {
      reader.close();
    }
  }
  kill(pid: number, signal: number): void {
    this.supervisor.kill(pid, signal);
  }
  async wait(pid: number): Promise<number> {
    const result = await this.supervisor.waitForExit(this.root.pid, pid);
    this.client.wait(this.root.pid, pid);
    await this.drains.get(pid);
    this.drains.delete(pid);
    const service = await this.runtime.processes();
    while (this.notices.length) await service.runtimeMessage(this.notices.shift()!, this.root.pid);
    check(result.status !== null, `pid ${pid} failed to start`);
    return result.status;
  }
  launch(pid: number): Launch {
    const launch = this.byPid.get(pid);
    check(launch, `no search launch for pid ${pid}`);
    return launch;
  }
  async dispose(): Promise<void> {
    this.descriptors.dispose();
    await this.runtime.dispose();
  }
}

function lines(count: number, width: number): Uint8Array {
  const line = `${"x".repeat(width - 1)}\n`;
  return new TextEncoder().encode(line.repeat(count));
}

async function writeTree(runtime: Runtime, root: string, files: number, bytes: Uint8Array) {
  await runtime.filesystem.mkdirp(root);
  for (let i = 0; i < files; i++)
    await runtime.filesystem.writeFile(`${root}/f${String(i).padStart(4, "0")}`, bytes);
}

function expected(root: string, files: number, count: number): string {
  let text = "";
  for (let i = 0; i < files; i++) text += `${root}/f${String(i).padStart(4, "0")}:${count}\n`;
  return text;
}

/** Stops shards, then the process Worker, with no section or lock left by its identity. */
async function assertStopped(launch: Launch, label: string): Promise<void> {
  await until(() => launch.terminated !== undefined, `${label} worker stop`);
  const audits = [launch.acknowledged, launch.terminated].filter((audit) => audit !== undefined);
  for (const audited of audits) assertFilesystemStopped(audited, label);
  // A process that acknowledged exit reaped its own identity in fs.dispose(); every shard must
  // have acknowledged stop before that. Without an acknowledgement the page fence stopped it.
  const ack = launch.acknowledged;
  check(
    !ack || ack.liveShards === 0 || ack.fenced,
    `${label}: exit with ${ack?.liveShards} live shards and no fence`,
  );
  const control = launch.control!;
  launch.quietMs = await quiet(
    () => Atomics.load(control, CONTROL_HEARTBEAT) + Atomics.load(control, CONTROL_CHUNKS),
    () => assertFilesystemQuiet(launch.filesystem, label),
    label,
  );
}

/** Browsers stop nested workers asynchronously after terminate() returns. Safety was already
 * proven at the stop instant by revocation followed by zero sections. A later admission raises
 * the sections word before it aborts, and termination can strand that count. During quiet we
 * check revocation and storage locks while waiting for helper activity to cease. */
async function quiet(activity: () => number, sample: () => void, label: string): Promise<number> {
  const started = performance.now();
  let last = activity();
  let since = started;
  while (performance.now() - since < 100) {
    sample();
    if (performance.now() - started > 5_000) throw new Error(`${label}: helpers kept running`);
    await pause(5);
    const now = activity();
    if (now !== last) [last, since] = [now, performance.now()];
  }
  return Math.round(since - started);
}

/** Returns once a shard has read and the process's section word is nonzero. The page spins in
 * short bursts and yields between them: WebKit routes nested worker traffic through it. */
async function midRead(harness: Harness, pid: number): Promise<Launch> {
  await until(() => harness.byPid.get(pid)?.control !== undefined, "search diagnostics");
  const launch = harness.launch(pid);
  const sections = new Int32Array(launch.filesystem.sections);
  const reading = () =>
    Atomics.load(launch.control!, CONTROL_CHUNKS) > 0 && Atomics.load(sections, 0) > 0;
  const end = performance.now() + 20_000;
  while (performance.now() < end) {
    const burst = performance.now() + 20;
    while (performance.now() < burst) if (reading()) return launch;
    await pause(0);
  }
  throw new Error("no shard entered a shared-slot read");
}

const BIG_FILES = 16;
const BIG = lines(256 * 1024, 32); // 8 MiB, 262144 records

async function countCase(harness: Harness): Promise<Record<string, unknown>> {
  await writeTree(harness.runtime, "/small", 40, lines(3, 8));
  await harness.runtime.filesystem.writeFile("/small/tail", new TextEncoder().encode("a\nb"));
  await harness.runtime.filesystem.writeFile("/small/empty", new Uint8Array());
  const result: Record<string, unknown> = {};
  for (const shards of [4, 0]) {
    harness.shards = shards;
    harness.resetOutput();
    const pid = await harness.spawn(["count", "/small", "/missing"]);
    const code = await harness.wait(pid);
    const launch = harness.launch(pid);
    await assertStopped(launch, `count shards=${shards}`);
    const want = `/small/empty:0\n${expected("/small", 40, 3)}/small/tail:2\n`;
    const [stdout, stderr = ""] = splitStreams(harness.text);
    check(stdout === want, `count shards=${shards} stdout ${JSON.stringify(stdout)}`);
    check(stderr.includes("count: /missing: No such file or directory"), `stderr ${stderr}`);
    check(code === 2, `count shards=${shards} exited ${code}`);
    check(Atomics.load(launch.control!, CONTROL_LIVE_SHARDS) === 0, "a shard missed stop");
    result[`shards${shards}`] = { shards: launch.shards, code };
  }
  harness.shards = 4;
  return result;
}

// Root output merges both streams; stderr lines are the "count:" diagnostics.
function splitStreams(text: string): [string, string] {
  const all = text.split(/(?<=\n)/);
  return [
    all.filter((line) => !line.startsWith("count: ")).join(""),
    all.filter((line) => line.startsWith("count: ")).join(""),
  ];
}

async function killCase(harness: Harness, signal: 9 | 2): Promise<Record<string, unknown>> {
  harness.resetOutput();
  const pid = await harness.spawn(["count", "/big"]);
  const launch = await midRead(harness, pid);
  harness.kill(pid, signal);
  const code = await harness.wait(pid);
  check(code === 128 + signal, `signal ${signal} exited ${code}`);
  const atExit = harness.text.length;
  await assertStopped(launch, `signal ${signal}`);
  check(harness.text.length === atExit, `signal ${signal}: output after exit`);
  check(/^(\/big\/f\d{4}:262144\n)*$/.test(harness.text), `torn output ${harness.text}`);
  harness.resetOutput();
  const successor = await harness.spawn(["count", "/big"]);
  check((await harness.wait(successor)) === 0, "successor failed");
  check(harness.text === expected("/big", BIG_FILES, 262144), "successor read stale data");
  await assertStopped(harness.launch(successor), "successor");
  return { code, audits: auditSummary(launch), outputAtExit: atExit };
}

function auditSummary(launch: Launch): string {
  const ack = launch.acknowledged;
  if (!ack) return `fence-terminated quietMs=${launch.quietMs}`;
  return ack.fenced ? "exit-ack after shard fence" : `exit-ack liveShards=${ack.liveShards}`;
}

async function revokeCase(harness: Harness): Promise<Record<string, unknown>> {
  harness.resetOutput();
  const pid = await harness.spawn(["count", "/big"]);
  const launch = await midRead(harness, pid);
  harness.runtime.filesystem.revoke(launch.filesystem);
  await until(
    () => Atomics.load(new Int32Array(launch.filesystem.sections), 0) === 0,
    "shards to leave their sections after revocation",
  );
  const code = await harness.wait(pid);
  check(code !== 0, "revoked search reported success");
  await assertStopped(launch, "revoke");
  return { code, audits: auditSummary(launch) };
}

/** A helper whose stop handler throws: the process must exit with an error, never hang or
 * acknowledge exit while that helper or a sibling could still enter a section. */
async function helperFaultCase(harness: Harness): Promise<Record<string, unknown>> {
  harness.resetOutput();
  harness.shardWorker = "/fault-shard.js?mode=stop-throws";
  try {
    const pid = await harness.spawn(["count", "/small"]);
    const code = await harness.wait(pid);
    const launch = harness.launch(pid);
    await assertStopped(launch, "helper fault");
    check(code === 1, `helper fault exited ${code}`);
    check(launch.acknowledged?.fenced === true, "helper fault exited without the shard fence");
    check(launch.acknowledged.sections === 0, "helper fault exit inside a section");
    return { code, audits: auditSummary(launch) };
  } finally {
    harness.shardWorker = "/shard-worker.js";
  }
}

async function pipeCase(harness: Harness): Promise<Record<string, unknown>> {
  await writeTree(harness.runtime, "/many", 400, lines(1, 4));
  const [reader, writer] = harness.pipes.createPipe();
  const pid = await harness.spawn(["count", "/many"], writer);
  const buffer = new Uint8Array(64);
  let read = 0;
  await until(() => (read = reader.tryRead!([buffer])) > 0, "first piped record");
  reader.close();
  const started = performance.now();
  const code = await harness.wait(pid);
  check(code === 141, `head-closed pipe exited ${code}`);
  await assertStopped(harness.launch(pid), "pipe");
  return {
    code,
    first: new TextDecoder().decode(buffer.subarray(0, read)).split("\n")[0],
    msToExit: Math.round(performance.now() - started),
  };
}

/** Helpers the page creates directly, with the moment each was terminated. */
function trackHelpers() {
  const NativeWorker = globalThis.Worker;
  const created: Worker[] = [];
  const terminated = new Set<Worker>();
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      created.push(this);
    }
    override terminate() {
      terminated.add(this);
      super.terminate();
    }
  };
  return {
    created,
    terminated,
    restore: () => {
      globalThis.Worker = NativeWorker;
      for (const worker of created) worker.terminate();
    },
  };
}

const FAULT_TIMING = { startup: 10_000, liveness: 300, stopAck: 600, poll: 20 };

/** One real ShardPool with a fault in helper 0. close() must not settle until every helper is
 * terminated, must fence the process identity first, and no helper may run afterwards. */
async function poolFault(
  runtime: Runtime,
  mode: "stop-throws" | "silent" | "mute" | "lose-batch" | "none",
  count: number,
  expected: ShardFailureReason | null,
): Promise<Record<string, unknown>> {
  const helpers = trackHelpers();
  const identity = runtime.filesystem.createIdentity();
  const control = new SharedArrayBuffer(CONTROL_WORDS * 4);
  const cells = new Int32Array(control);
  try {
    const pool = await ShardPool.start({
      url: `/fault-shard.js?mode=${mode}`,
      count,
      start: {
        type: "start",
        identity,
        control,
        program: { kind: "count-lines" },
        fileBytes: 16,
        heartbeat: true,
      },
      fence: () => processFence(identity),
      timing: FAULT_TIMING,
    });
    let running: string | null = null;
    if (mode === "lose-batch") {
      pool.submit(1, [{ index: 0, path: "lost", handle: 0x7ffffff0, size: 1 }]);
      running = await pool.next().then(
        () => "resolved",
        (error) =>
          error instanceof ShardPoolError
            ? `${error.retirement}:${error.failures[0]?.reason}`
            : String(error),
      );
      check(running === "owned:unresponsive", `${mode}: next() ${running}`);
    }
    const started = performance.now();
    const outcome = await pool.close().then(
      () => null,
      (error: unknown) => error,
    );
    const closeMs = Math.round(performance.now() - started);
    const terminated = helpers.terminated.size;
    check(terminated === count, `${mode}: ${terminated}/${count} helpers terminated at close`);
    const quietMs = await quiet(
      () => Atomics.load(cells, CONTROL_HEARTBEAT),
      () => {},
      mode,
    );
    const revoked = Atomics.load(new Int32Array(identity.revocations[0]!), 0);
    const sections = Atomics.load(new Int32Array(identity.sections), 0);
    check(sections === 0, `${mode}: ${sections} sections after close`);
    if (expected === null) {
      check(outcome === null, `${mode}: clean close rejected ${String(outcome)}`);
      check(
        revoked === 0 && Atomics.load(cells, CONTROL_FENCED) === 0,
        `${mode}: clean close fenced`,
      );
      check(Atomics.load(cells, CONTROL_LIVE_SHARDS) === 0, `${mode}: a helper missed stop`);
      return { closeMs, quietMs, fenced: false };
    }
    check(outcome instanceof ShardPoolError, `${mode}: close ${String(outcome)}`);
    check(outcome.retirement === "fenced", `${mode}: retirement ${outcome.retirement}`);
    check(
      outcome.failures.some((failure) => failure.reason === expected),
      `${mode}: ${outcome.message}`,
    );
    check(
      revoked !== 0 && Atomics.load(cells, CONTROL_FENCED) === 1,
      `${mode}: terminated without the fence`,
    );
    return {
      closeMs,
      quietMs,
      fenced: true,
      running,
      failures: outcome.failures.map((failure) => failure.reason),
    };
  } finally {
    helpers.restore();
    runtime.filesystem.reap(identity);
  }
}

async function poolFaultCases(runtime: Runtime): Promise<Record<string, unknown>> {
  return {
    clean: await poolFault(runtime, "none", 2, null),
    stopThrows: await poolFault(runtime, "stop-throws", 2, "error"),
    silent: await poolFault(runtime, "silent", 1, "unresponsive"),
    mute: await poolFault(runtime, "mute", 2, "stop-unacknowledged"),
    loseBatch: await poolFault(runtime, "lose-batch", 1, "unresponsive"),
  };
}

/** @browserEntry Called by the browser bundle through its runtime URL. */
export async function searchExecutorBrowserCases(): Promise<Record<string, unknown>> {
  const launches = new Map<SharedArrayBuffer, Launch>();
  const tracking = trackSearchWorkers(launches);
  const harness = await Harness.create(launches);
  try {
    const stage = (name: string) => console.log(`search case ${name}`);
    stage("pool faults");
    const results: Record<string, unknown> = { poolFaults: await poolFaultCases(harness.runtime) };
    stage("count");
    results.count = await countCase(harness);
    stage("write big");
    await writeTree(harness.runtime, "/big", BIG_FILES, BIG);
    stage("sigkill");
    results.sigkill = await killCase(harness, 9);
    stage("sigint");
    results.sigint = await killCase(harness, 2);
    stage("revoke");
    results.revoke = await revokeCase(harness);
    stage("helper fault");
    results.helperFault = await helperFaultCase(harness);
    stage("pipe");
    results.pipe = await pipeCase(harness);
    results.nestedWorkers = (results.count as { shards4: { shards: number } }).shards4.shards;
    return results;
  } finally {
    await harness.dispose();
    tracking.restore();
    check(tracking.leaked() === 0, "runtime disposal retained a search worker");
  }
}
