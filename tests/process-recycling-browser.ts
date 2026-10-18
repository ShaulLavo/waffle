import { BrowserProcessBroker } from "../browser/process-broker";
import { DescriptorTable } from "../core/descriptors";
import { createFilesystemIdentity, revokeFilesystem } from "../fs/protocol";
import { controlAdd, controlCas, controlExchange, controlLoad, controlStore } from "../proc/control";
import { directoryJobs, directorySlots } from "../proc/directory";
import { claimOutcome, readOutcome } from "../proc/outcome";
import { ProcessTable } from "../proc/table";
import { ProcessIdentityAllocator } from "../proc/identity";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessSupervisor } from "../proc/supervisor";
import { ProcessErrno, ProcessError, type ProcessExit, type SpawnRequest } from "../proc/types";
import { WorkerProcessBroker } from "../proc/worker-broker";
import {
  createWorkerProcessTransport, WorkerProcessClient, workerProcessState,
  type WorkerDescriptorCodec, type WorkerProcessMessage, type WorkerProcessTransport,
} from "../proc/worker-client";

type Command =
  | { operation: "spawn"; job?: number }
  | { operation: "wait"; pid: number }
  | { operation: "wait-job" | "job-empty"; job: number }
  | { operation: "kill"; pid: number; signal: number }
  | { operation: "kill-job"; job: number; signal: number }
  | { operation: "snapshot" | "mutate-captured" }
  | { operation: "exit"; code: number };
type Request = { id: number } & ({ operation: "init"; transport: WorkerProcessTransport } | Command);
type Failure = { name: string; message: string; errno?: number; stack?: string };
type Response = { id: number; result?: unknown; error?: Failure };
type WorkerFatal = { type: "process-test-fatal"; error: Failure };
const emptyCodec: WorkerDescriptorCodec = {
  export() { throw new Error("Process fixture unexpectedly exported a descriptor"); },
  import() { throw new Error("Process fixture unexpectedly imported a descriptor"); },
  discard() { throw new Error("Process fixture unexpectedly discarded a descriptor"); },
};

export interface ProcessWorkerBootstrapHost {
  onmessage: ((event: MessageEvent) => unknown) | null;
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
}
/** Self-contained: runner emits this TypeScript function's stripped source into its Worker.
 * The two optional dependencies let deterministic tests hold import completion explicitly. */
export async function installClientWorker(
  host: ProcessWorkerBootstrapHost = globalThis,
  load: () => Promise<{ installProcessTestWorker(): void }> = async () => {
    const modulePath = "/tests.js";
    return await import(modulePath);
  },
): Promise<void> {
  // Dynamic import yields to the Worker event loop. Own incoming init messages before
  // that first await, or a fast parent can dispatch init before any listener exists.
  const queued: MessageEvent[] = [];
  const buffer = (event: MessageEvent) => { queued.push(event); };
  host.onmessage = buffer;
  const fatal = (phase: string, error: unknown) => {
    host.postMessage({ type: "process-test-fatal", error: {
      name: error instanceof Error ? error.name : "Error",
      message: `Process Worker ${phase}: ${error instanceof Error ? error.message : String(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
    } });
  };
  host.addEventListener("error", event => {
    const error = event as ErrorEvent;
    fatal("uncaught error", error.error ?? `${error.message} at ${error.filename}:${error.lineno}:${error.colno}`);
    event.preventDefault();
  });
  host.addEventListener("unhandledrejection", event => {
    fatal("unhandled rejection", (event as PromiseRejectionEvent).reason); event.preventDefault();
  });
  try {
    const tests = await load();
    tests.installProcessTestWorker();
    const handler = host.onmessage;
    if (!handler || handler === buffer) throw new Error("Process fixture did not install a message handler");
    for (const event of queued) handler.call(host, event);
    queued.length = 0;
  } catch (error) { fatal("bootstrap failed", error); }
}

/** Runs in a real module Worker; no emulated postMessage or replacement Worker globals. */
export function installProcessTestWorker(): void {
  const descriptors = new DescriptorTable();
  let client: WorkerProcessClient | undefined;
  let captured: ReturnType<typeof workerProcessState> | undefined;
  globalThis.onmessage = (event: MessageEvent<Request>) => {
    const request = event.data;
    try {
      let result: unknown;
      if (request.operation === "init") {
        if (client) throw new Error("Process fixture initialized twice");
        client = new WorkerProcessClient({ transport: request.transport, descriptors, codec: emptyCodec,
          postMessage(message) { globalThis.postMessage(message); } });
        client.installBindings();
        captured = workerProcessState(request.transport);
        result = { pid: client.pid, job: client.job, isolated: crossOriginIsolated,
          shared: request.transport.directory instanceof SharedArrayBuffer };
      } else {
        if (!client) throw new Error("Process fixture not initialized");
        switch (request.operation) {
          case "spawn": result = client.spawn(client.pid, spawnRequest(request.job ?? -1)); break;
          case "wait": result = client.wait(client.pid, request.pid); break;
          case "wait-job": result = client.waitJob(client.pid, request.job); break;
          case "job-empty": result = client.jobEmpty(client.pid, request.job); break;
          case "kill": client.kill(request.pid, request.signal); break;
          case "kill-job": client.killJob(request.job, request.signal); break;
          case "snapshot": result = snapshot(captured!); break;
          case "mutate-captured": result = mutateCaptured(client, captured!); break;
          case "exit": descriptors.dispose(); client.exit(request.code); break;
        }
      }
      globalThis.postMessage({ id: request.id, result } satisfies Response);
    } catch (error) {
      globalThis.postMessage({ id: request.id, error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        errno: error instanceof ProcessError ? error.errno : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      } } satisfies Response);
    }
  };
}

function snapshot(state: ReturnType<typeof workerProcessState>) {
  return { pid: state.pid, job: state.job,
    interrupt: controlLoad(state.signals.interrupt), requested: controlLoad(state.signals.requestedSignal),
    signals: Array.from({ length: state.signals.signalState.length }, (_, index) => controlLoad(state.signals.signalState, index)),
    confirmed: controlLoad(state.confirmed), jobConfirmed: controlLoad(state.jobConfirmed),
    jobPending: controlLoad(state.jobPending), parent: controlLoad(state.controlParent),
    jobParent: controlLoad(state.jobControlParent), outcome: readOutcome(state.signals.outcome),
    jobOutcome: readOutcome(state.jobOutcome) };
}
type MutationResult = { operation: string; errno: number | null };
function mutateCaptured(client: WorkerProcessClient, state: ReturnType<typeof workerProcessState>): MutationResult[] {
  const results: MutationResult[] = [];
  const attempt = (operation: string, action: () => unknown) => {
    try { action(); results.push({ operation, errno: null }); }
    catch (error) {
      if (!(error instanceof ProcessError)) throw error;
      results.push({ operation, errno: error.errno });
    }
  };
  for (const [name, cells, index] of [
    ["interrupt", state.signals.interrupt, 0], ["requestedSignal", state.signals.requestedSignal, 0],
    ["signalDisposition", state.signals.signalState, 15], ["confirmed", state.confirmed, 0],
    ["jobConfirmed", state.jobConfirmed, 0], ["jobPending", state.jobPending, 0],
    ["controlParent", state.controlParent, 0], ["jobControlParent", state.jobControlParent, 0],
  ] as const) {
    attempt(`${name}.store`, () => controlStore(cells, index, 9));
    attempt(`${name}.cas`, () => controlCas(cells, index, 0, 9));
    attempt(`${name}.add`, () => controlAdd(cells, index, 1));
    attempt(`${name}.exchange`, () => controlExchange(cells, index, 9));
  }
  attempt("outcome.claim", () => claimOutcome(state.signals.outcome, { kind: "exited", code: 99 }));
  attempt("jobOutcome.claim", () => claimOutcome(state.jobOutcome, { kind: "signaled", code: 9 }));
  attempt("client.spawn", () => client.spawn(client.pid, spawnRequest(-1)));
  attempt("client.exit", () => client.exit(99));
  attempt("client.kill", () => client.kill(client.pid, 9));
  attempt("client.defaultSignal", () => client.defaultSignal(client.pid, 9));
  attempt("client.waitJob", () => client.waitJob(client.pid, client.job));
  return results;
}

function spawnRequest(job: number): SpawnRequest {
  return { executable: "fixture", argv: ["fixture"], env: {}, cwd: "/", job, fds: [] };
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, label: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function exited(code: number): ProcessExit { return { kind: "exited", code, status: code }; }

export class ProcessWorker {
  private worker?: Worker;
  private failure?: Error;
  private sequence = 0;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>;
  }>();
  constructor(readonly transport: WorkerProcessTransport, readonly notify: (message: WorkerProcessMessage) => void,
    private readonly failed: (error: Error) => void,
    private readonly createWorker = () => new Worker("/process-client.js", { type: "module" })) {}
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    try { this.failed(error); }
    finally { this.stop(error); }
  }
  async start(): Promise<void> {
    this.worker = this.createWorker();
    this.worker.onmessage = (event: MessageEvent<Response | WorkerProcessMessage | WorkerFatal>) => {
      if ("type" in event.data) {
        if (event.data.type === "process-test-fatal") {
          this.fail(Object.assign(new Error(event.data.error.message), event.data.error));
        } else this.notify(event.data);
        return;
      }
      const response = event.data, pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id); clearTimeout(pending.timer);
      if (response.error) pending.reject(Object.assign(new Error(response.error.message), response.error));
      else pending.resolve(response.result);
    };
    this.worker.onerror = event => {
      event.preventDefault();
      this.fail(new Error(`Process Worker error: ${event.message || "unknown error"} at ${event.filename}:${event.lineno}:${event.colno}`));
    };
    this.worker.onmessageerror = () => this.fail(new Error("Process Worker response could not be decoded"));
    const result = await this.request<{ isolated: boolean; shared: boolean }>({ operation: "init", transport: this.transport });
    assert(result.isolated && result.shared, "Worker must have real cross-origin-isolated shared memory");
  }
  request<T = unknown>(command: Command | { operation: "init"; transport: WorkerProcessTransport }): Promise<T> {
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      if (!this.worker) { reject(this.failure ?? new Error("Process Worker has stopped")); return; }
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Process Worker ${command.operation} timed out`));
      }, 10_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.worker.postMessage({ ...command, id }); }
      catch (error) {
        this.pending.delete(id); clearTimeout(timer); reject(error);
      }
    });
  }
  stop(error = new Error("Process Worker stopped during teardown")): void {
    this.failure ??= error;
    this.worker?.terminate(); this.worker = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}

class ProcessFixture {
  readonly identities = new ProcessIdentityAllocator();
  readonly root = createWorkerProcessTransport({ pid: this.identities.pid(), job: this.identities.job(),
    identity: this.identities.buffer, capacity: 4 });
  readonly workers = new Map<number, ProcessWorker>();
  readonly notices: { sender: number; message: WorkerProcessMessage }[] = [];
  readonly errors: unknown[] = [];
  readonly releases = new Set<() => void>();
  readonly fences = new Map<number, Promise<void>>();
  readonly registry = new ExecutableRegistry();
  readonly supervisor = new ProcessSupervisor({ registry: this.registry,
    quiesce: pid => this.fences.get(pid),
    launch: async context => {
      const transport = this.broker.get(context.pid);
      assert(transport, `No transport for launched process ${context.pid}`);
      await this.worker(transport);
      // Logical exit is controlled explicitly, allowing tests to retain an old Worker.
      // The fixture, not a process slot, owns physical Worker teardown.
      return { terminate() {} };
    },
  });
  readonly broker = new WorkerProcessBroker({ supervisor: async () => this.supervisor, codec: emptyCodec,
    onError: error => this.errors.push(error) });
  private admissions: Promise<void>[] = [];
  async start(): Promise<void> {
    this.registry.register("fixture", { adapter: "fixture", interruptible: true,
      module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])) });
    const state = workerProcessState(this.root);
    this.supervisor.createRoot({ pid: state.pid, job: state.job, ...state.signals });
    this.broker.adoptRoot(this.root);
    await this.worker(this.root);
  }
  private async worker(transport: WorkerProcessTransport): Promise<ProcessWorker> {
    const pid = workerProcessState(transport).pid;
    const worker = new ProcessWorker(transport, message => {
      this.notices.push({ sender: pid, message });
      // Observe rejection immediately; flush() turns it into a case failure.
      const admission = this.broker.handle(message, pid);
      void admission.catch(() => {});
      this.admissions.push(admission);
    }, error => this.errors.push(error));
    this.workers.set(pid, worker); // Own Worker and all its RPC timers before allocation.
    await worker.start();
    return worker;
  }
  async flush(): Promise<void> {
    while (this.admissions.length) {
      const pending = this.admissions; this.admissions = [];
      await Promise.all(pending);
    }
    this.broker.pump();
  }
  async call<T = unknown>(caller: number, command: Command): Promise<T> {
    const worker = this.workers.get(caller);
    assert(worker, `No Worker for process ${caller}`);
    const result = await worker.request<T>(command);
    await this.flush();
    return result;
  }
  async spawn(parent = this.pid, job = -1): Promise<number> {
    const pid = await this.call<number>(parent, { operation: "spawn", job });
    await this.supervisor.start(pid);
    assert(this.workers.has(pid), `Spawn ${pid} did not launch a real Worker`);
    return pid;
  }
  get pid(): number { return workerProcessState(this.root).pid; }
  job(pid: number): number {
    const record = this.supervisor.get(pid);
    assert(record, `No host process ${pid}`);
    return record.job;
  }
  async exit(pid: number, code: number): Promise<void> {
    const record = this.supervisor.get(pid);
    assert(record, `No process to exit ${pid}`);
    // Orphan completion can collect the host record before the exit notification drains.
    const completion = this.supervisor.waitForExit(record.parentPid, pid);
    await this.call(pid, { operation: "exit", code });
    await completion;
  }
  fence(pid: number): () => void {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    this.releases.add(release); this.fences.set(pid, promise);
    return release;
  }
  async close(): Promise<void> {
    for (const release of this.releases) release();
    try {
      await this.flush();
    } finally {
      try { this.broker.dispose(); }
      finally {
        try { this.supervisor.dispose(); }
        finally { for (const worker of this.workers.values()) worker.stop(); this.workers.clear(); }
      }
    }
  }
}

type BrowserCase = { label: string; standalone?: boolean; run(fixture: ProcessFixture): Promise<void> };
// These cases deliberately use the existing observational wait and consuming waitJob.
// Direct child reap/waitpid assertions await ABI clearance.
const cases: BrowserCase[] = [
  { label: "shared Worker exit waits remain observational until job collection", async run(f) {
    const pid = await f.spawn(), job = f.job(pid);
    equal(await f.call(f.pid, { operation: "wait", pid }), null, "running child wait");
    await f.exit(pid, 23);
    for (let repeat = 0; repeat < 3; repeat++) equal(await f.call(f.pid, { operation: "wait", pid }), exited(23), "repeatable wait");
    equal(await f.call(f.pid, { operation: "wait-job", job }), exited(23), "job outcome");
    assert(!f.supervisor.get(pid), "Job collection must remove the host process record");
    await rejectsProcess(() => f.call(f.pid, { operation: "wait", pid }), "collected child wait");
  } },
  { label: "repeated real Worker spawn exit and job collection", async run(f) {
    let previous = f.pid;
    for (let iteration = 0; iteration < 64; iteration++) {
      const pid = await f.spawn(), job = f.job(pid), code = iteration % 31;
      assert(pid > previous, "Process identities must not be reused"); previous = pid;
      await f.exit(pid, code);
      equal(await f.call(f.pid, { operation: "wait-job", job }), exited(code), `iteration ${iteration}`);
      assert(!f.supervisor.get(pid) && !f.broker.get(pid), "Collected process must leave host and broker live records");
      // Do not accumulate OS threads or test-owned history while testing directory lifetime.
      f.workers.get(pid)!.stop();
      f.workers.delete(pid);
      f.notices.length = 0;
      equal(f.workers.size, 1, "remaining test-owned Workers");
      equal(directorySlots(f.root.directory), [f.root.slot], "remaining shared process slots");
      equal(directoryJobs(f.root.directory).length, 1, "remaining shared job slots");
    }
    equal(Array.from(f.supervisor.table.values(), record => record.pid), [f.pid], "remaining host processes");
  } },
  { label: "unreaped zombie keeps immutable outcome across late Worker messages", async run(f) {
    const pid = await f.spawn(), job = f.job(pid);
    await f.exit(pid, 7);
    await f.call(pid, { operation: "exit", code: 99 });
    equal(await f.call(f.pid, { operation: "wait", pid }), exited(7), "late exit cannot replace zombie outcome");
    assert(f.supervisor.get(pid) && f.broker.get(pid), "Uncollected zombie must remain addressable");
    equal(await f.call(f.pid, { operation: "wait-job", job }), exited(7), "zombie job collection");
  } },
  { label: "unreaped zombies retain capacity until consuming job wait", async run(f) {
    const zombies: { pid: number; job: number; slot: number }[] = [];
    for (let index = 0; index < 3; index++) {
      const pid = await f.spawn(), job = f.job(pid), slot = f.workers.get(pid)!.transport.slot;
      await f.exit(pid, index); zombies.push({ pid, job, slot });
    }
    equal(directorySlots(f.root.directory).length, 4, "zombies occupy all process slots");
    equal(directoryJobs(f.root.directory).length, 4, "zombies retain their job rows");
    await rejectsErrno(() => f.call(f.pid, { operation: "spawn" }), ProcessErrno.AGAIN, "full zombie directory");
    equal(await f.call(f.pid, { operation: "wait-job", job: zombies[0]!.job }), exited(0), "release one zombie");
    const replacement = await f.spawn(), replacementJob = f.job(replacement);
    equal(f.workers.get(replacement)!.transport.slot, zombies[0]!.slot, "collected zombie row reused");
    await f.exit(replacement, 12);
    equal(await f.call(f.pid, { operation: "wait-job", job: replacementJob }), exited(12), "replacement collection");
    for (let index = 1; index < zombies.length; index++) {
      equal(await f.call(f.pid, { operation: "wait-job", job: zombies[index]!.job }), exited(index), "other zombie remains intact");
    }
    equal(directorySlots(f.root.directory), [f.root.slot], "all zombie process rows collected");
    equal(directoryJobs(f.root.directory).length, 1, "all zombie job rows collected");
  } },
  { label: "still-running stale Worker cannot mutate a reused process or job row", async run(f) {
    const oldPid = await f.spawn(), oldJob = f.job(oldPid), oldWorker = f.workers.get(oldPid)!;
    const oldState = workerProcessState(oldWorker.transport);
    await f.exit(oldPid, 5);
    equal(await f.call(f.pid, { operation: "wait-job", job: oldJob }), exited(5), "old job collection");
    const delayed = f.notices.filter(notice => notice.message.operation !== "spawn" || notice.message.transport.pid === oldPid);
    delayed.push({ sender: oldPid, message: { type: "runtime-proc", operation: "signal", transport: oldWorker.transport, targets: [oldPid] } });
    const newPid = await f.spawn(), newJob = f.job(newPid), newWorker = f.workers.get(newPid)!;
    const newState = workerProcessState(newWorker.transport);
    equal(newWorker.transport.slot, oldWorker.transport.slot, "replacement uses captured process row");
    equal(newState.jobSlot, oldState.jobSlot, "replacement uses captured job row");
    assert(newPid !== oldPid && newJob !== oldJob, "Replacement must have fresh immutable process and job identities");
    const before = await f.call(newPid, { operation: "snapshot" });
    const mutations = await f.call<MutationResult[]>(oldPid, { operation: "mutate-captured" });
    assert(mutations.length >= 39, "Stale Worker must attempt every captured control and outcome mutation");
    for (const mutation of mutations) equal(mutation.errno, ProcessErrno.SRCH, `${mutation.operation} rejects captured stale identity`);
    for (const notice of delayed) await f.broker.handle(structuredClone(notice.message), notice.sender);
    await f.flush();
    equal(await f.call(newPid, { operation: "snapshot" }), before, "stale writes and delayed notices leave replacement untouched");
    equal(await f.call(f.pid, { operation: "wait", pid: newPid }), null, "replacement remains running");
    assert(!f.supervisor.get(oldPid) && !f.broker.get(oldPid), "Delayed notices must not recreate collected identities");
    await f.exit(newPid, 17);
    equal(await f.call(f.pid, { operation: "wait-job", job: newJob }), exited(17), "replacement completes normally");
  } },
  { label: "host resource fence hides child and job completion", async run(f) {
    const pid = await f.spawn(), job = f.job(pid), release = f.fence(pid);
    await f.call(pid, { operation: "exit", code: 11 });
    equal(await f.call(f.pid, { operation: "wait", pid }), null, "fenced child wait");
    equal(await f.call(f.pid, { operation: "wait-job", job }), null, "fenced job wait");
    release();
    await f.supervisor.waitForExit(f.pid, pid);
    equal(await f.call(f.pid, { operation: "wait-job", job }), exited(11), "released fence outcome");
  } },
  { label: "collected orphan leader preserves live grandchild job signalling and outcome", async run(f) {
    const parent = await f.spawn(), parentJob = f.job(parent);
    const leader = await f.spawn(parent), job = f.job(leader);
    const grandchild = await f.spawn(leader, job);
    const leaderSlot = f.workers.get(leader)!.transport.slot;
    await f.exit(leader, 21);
    await f.exit(parent, 3);
    equal(await f.call(f.pid, { operation: "wait-job", job: parentJob }), exited(3), "collect exited ancestor job");
    assert(!f.supervisor.get(leader), "Exited orphan leader must be auto-collected");
    assert(!directorySlots(f.root.directory).includes(leaderSlot), "Orphan leader process row must not pin its job metadata");
    equal(await f.call(f.pid, { operation: "wait-job", job }), null, "live grandchild keeps job pending");
    const completion = f.supervisor.waitForExit(leader, grandchild);
    await f.call(f.pid, { operation: "kill-job", job, signal: 9 });
    equal(await completion, { kind: "signaled", code: 9, status: 137 }, "root can still reach orphan grandchild");
    equal(await f.call(f.pid, { operation: "wait-job", job }), exited(21), "job preserves original leader outcome");
    equal(directorySlots(f.root.directory), [f.root.slot], "orphan chain process cleanup");
    equal(directoryJobs(f.root.directory).length, 1, "orphan chain job cleanup");
  } },
  { label: "root exit collects directory and job rows with lazy and eager activation", standalone: true,
    async run() { await rootCleanupCase(); } },
  { label: "orphan background job remains collectible after its parent job", async run(f) {
    const parent = await f.spawn(), parentJob = f.job(parent);
    const child = await f.spawn(parent), childJob = f.job(child);
    await f.exit(parent, 3);
    equal(await f.call(f.pid, { operation: "wait-job", job: parentJob }), exited(3), "parent job collection");
    assert(!f.supervisor.get(parent), "Parent process must be collected");
    equal(await f.call(f.pid, { operation: "wait-job", job: childJob }), null, "orphan remains live");
    await f.exit(child, 19);
    equal(await f.call(f.pid, { operation: "wait-job", job: childJob }), exited(19), "orphan job collection");
    equal(Array.from(f.supervisor.table.values(), record => record.pid), [f.pid], "orphan host cleanup");
  } },
];

async function rootCleanupCase(): Promise<void> {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  const diagnostics: unknown[] = [], workers = new Map<number, ProcessWorker>();
  const notices: WorkerProcessMessage[] = [];
  let retired = 0;
  const broker = new BrowserProcessBroker({ identities, table, registry: new ExecutableRegistry(),
    filesystem: { connect() { throw new Error("Root fixture must not allocate filesystem channels"); },
      revoke: revokeFilesystem, reap: revokeFilesystem, async quiesce() {} },
    launch() { throw new Error("Root fixture must not launch an unrequested child"); },
    onError: error => diagnostics.push(error) });
  try {
    for (const activation of ["lazy", "eager"] as const) {
      const transport = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer, capacity: 4 });
      transport.data = { filesystem: createFilesystemIdentity() };
      const pid = transport.pid, job = workerProcessState(transport).job;
      await broker.adoptRuntimeRoot(transport, { retired() { retired++; } });
      if (activation === "eager") await broker.ready();
      // Exit's directory outcome is already published; rootExit owns host completion.
      // Keep the real Worker notice to replay after retirement, as a queued late message.
      const worker = new ProcessWorker(transport, message => notices.push(message), error => diagnostics.push(error));
      workers.set(pid, worker);
      await worker.start();
      await worker.request({ operation: "exit", code: 0 });
      equal(notices.length, 1, "one real Worker root-exit notice");
      const exitNotice = notices.pop()!;
      equal(exitNotice.operation, "exit", "root Worker published exit notice");
      await broker.rootExit(pid, 0);
      equal(directorySlots(transport.directory), [], `${activation} root process row cleanup`);
      equal(directoryJobs(transport.directory), [], `${activation} root job row cleanup`);
      assert(!broker.transportFor(pid) && !table.get(pid) && !table.job(job), `${activation} root must leave no live host metadata`);
      await broker.runtimeMessage(exitNotice, pid);
      equal(directorySlots(transport.directory), [], "late root exit does not resurrect directory state");
      worker.stop(); workers.delete(pid);
    }
    equal(retired, 2, "one retirement callback per completed root");
    equal(Array.from(table.values()).length, 0, "all root host records collected");
  } finally {
    try { await broker.dispose(); }
    finally {
      for (const worker of workers.values()) worker.stop(); workers.clear();
    }
  }
  equal(diagnostics.map(String), [], "root retirement diagnostics");
}

async function rejectsErrno(action: () => Promise<unknown>, expected: number, label: string): Promise<void> {
  try { await action(); }
  catch (error) { equal((error as Failure).errno, expected, label); return; }
  throw new Error(`${label}: unexpectedly succeeded`);
}

async function rejectsProcess(action: () => Promise<unknown>, label: string): Promise<void> {
  try { await action(); }
  catch (error) {
    const errno = (error as Failure).errno;
    assert(errno === ProcessErrno.CHILD || errno === ProcessErrno.SRCH, `${label}: wrong rejection ${String(error)}`);
    return;
  }
  throw new Error(`${label}: unexpectedly succeeded`);
}

export function processBrowserCases(): string[] { return cases.map(test => test.label); }
export async function runProcessBrowserCase(label: string): Promise<string> {
  assert(crossOriginIsolated && typeof SharedArrayBuffer !== "undefined", "Process tests require COOP/COEP shared memory");
  const test = cases.find(test => test.label === label);
  assert(test, `Unknown process browser case ${label}`);
  const fixture = new ProcessFixture(); // Cleanup ownership exists before any Worker is created.
  try {
    if (!test.standalone) await fixture.start();
    await test.run(fixture);
  } finally { await fixture.close(); }
  equal(fixture.errors.map(String), [], "unexpected broker or Worker diagnostics");
  return label;
}
