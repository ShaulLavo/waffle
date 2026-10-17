// Bun's legacy subprocess adapter. The page runtime owns admission and supervision.
import type { ChildExitEvent, ProcessContext, ProcessExit, ProcessSupervisor, RootProcessOptions, Signal } from "@bun-wasm/runtime/proc";
import { checkedSignal } from "@bun-wasm/runtime/proc/types";
import { createSignalState, requestSignal, type SignalTransport } from "@bun-wasm/runtime/proc/signals";
import { isRevoked } from "@bun-wasm/runtime/fs/protocol";
import { claimOutcome, outcomeWord, readOutcome } from "@bun-wasm/runtime/proc/outcome";
import type { Runtime, ProcessService, RuntimeFilesystem } from "@bun-wasm/runtime";
import { childTransport, createProcessBudget } from "./subprocess.ts";
import type { Engine, RunRequest, SpawnRequest, WorkerMessage } from "./worker";
import type { WorkerProcessMessage, WorkerProcessTransport } from "@bun-wasm/runtime/proc/worker-client";

type CompiledExecutable = WebAssembly.Module | (() => Promise<WebAssembly.Module>);
export type ExecutableRegistration =
  | { module: CompiledExecutable; adapter: "bun"; engine?: Engine }
  | { module: CompiledExecutable; adapter: "preview1"; cooperative: true }
  | { bytes: Uint8Array | (() => Uint8Array | Promise<Uint8Array>); adapter: "preview1"; cooperative?: false };

interface Child {
  spawn: SpawnRequest;
  context?: ProcessContext;
  worker?: Worker;
  request?: RunRequest;
  signal: number;
  acknowledged: boolean;
  confirmed: boolean;
  closed: boolean;
  stopped: boolean;
  stopping?: Promise<void>;
  quiescence?: Promise<void>;
}

export class SubprocessBroker {
  private disposed = false;
  private children = new Map<number, Child>();
  private activation?: Promise<ProcessSupervisor>;
  private service?: ProcessService;
  private rootPrepared = false;
  private pendingAdmissions = new Set<Promise<() => void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private root?: SignalTransport & { pid: number; job: number };
  private rootIdentity: { pid: number; job: number };
  private filesystem: RuntimeFilesystem;
  constructor(private workerUrl: string, private runtime: Runtime,
    private options: {
      root?: RootProcessOptions;
      rootIdentity?: { pid: number; job: number };
      budget?: SharedArrayBuffer;
      output?(fd: 1 | 2, data: Uint8Array): void;
      quiesceRoot?(): void | Promise<void>;
      rootFilesystem?: import("@bun-wasm/runtime/fs").FilesystemIdentity;
      rootAcknowledged?(): boolean;
      stopRoot?(): void | Promise<void>;
      engine?: Engine;
      aliasExecutable?: string;
    } = {}) {
    this.filesystem = runtime.filesystem;
    this.rootIdentity = { pid: options.root?.pid ?? options.rootIdentity?.pid ?? runtime.identities.pid(), job: options.root?.job ?? options.rootIdentity?.job ?? runtime.identities.job() };
    runtime.identities.observePid(this.rootIdentity.pid); runtime.identities.observeJob(this.rootIdentity.job);
    installBunAdapters(runtime, workerUrl);
    if (options.root) { this.rootTransport(); controllersFor(runtime).set(this.root!.pid, this); }
  }
  private rootTransport(): SignalTransport & { pid: number; job: number } {
    const source = this.options.root;
    return this.root ??= {
      pid: this.rootIdentity.pid, job: this.rootIdentity.job,
      signalState: createSignalState(source?.signalState), outcome: outcomeWord(source?.outcome),
      interrupt: source?.interrupt instanceof Int32Array ? source.interrupt : new Int32Array(source?.interrupt ?? new SharedArrayBuffer(4)),
      requestedSignal: source?.requestedSignal instanceof Int32Array ? source.requestedSignal : new Int32Array(source?.requestedSignal ?? new SharedArrayBuffer(4)),
    };
  }

  register(name: string, entry: ExecutableRegistration): void {
    if (entry.adapter === "preview1" && !("bytes" in entry) && entry.cooperative !== true) throw new TypeError("Third-party preview1 programs require source bytes or an explicit cooperative assertion");
    const adapter = entry.adapter === "bun" ? `bun:${entry.engine ?? "browser"}` : "preview1";
    this.runtime.registerProgram(name, "bytes" in entry ? { adapter, source: entry.bytes }
      : { adapter, module: entry.module, cooperative: true });
  }
  qualifyExecutable(name: string): string {
    return this.options.engine && ["bun", "/bun", "node", "/node", "/usr/local/bin/bun", "/usr/local/bin/node"].includes(name)
      ? this.options.aliasExecutable ?? `bun-${this.options.engine}` : name;
  }
  private async processService(): Promise<ProcessService> { return this.service ??= await this.runtime.processes(); }
  async prepareRoot(): Promise<void> {
    const service = await this.processService();
    if (!this.root) this.rootTransport();
    if (this.rootPrepared) return;
    const root = this.root!;
    service.reserveRoot({ ...this.options.root, ...root }, {
      filesystem: this.options.rootFilesystem, acknowledged: this.options.rootAcknowledged,
      quiesce: this.options.quiesceRoot, stop: this.options.stopRoot,
      retired: () => controllersFor(this.runtime).delete(root.pid),
      wake: () => this.wakeBudget(this.options.budget),
    });
    controllersFor(this.runtime).set(root.pid, this);
    this.rootPrepared = true;
  }
  ready(): Promise<ProcessSupervisor> {
    return this.activation ??= this.prepareRoot().then(async () => {
      await Promise.all(this.pendingAdmissions);
      return await this.service!.ready() as ProcessSupervisor;
    });
  }
  async adoptRuntimeRoot(transport: WorkerProcessTransport): Promise<void> {
    if (this.disposed) throw new Error("Process broker is disposed");
    const { workerProcessState } = await import("@bun-wasm/runtime/proc/worker-client");
    const state = workerProcessState(transport);
    if (this.root) controllersFor(this.runtime).delete(this.root.pid);
    this.root = { pid: state.pid, job: state.job, ...state.signals };
    controllersFor(this.runtime).set(state.pid, this);
    const service = await this.processService();
    if (this.disposed) throw new Error("Process broker is disposed");
    await service.adoptRuntimeRoot(transport, {
      filesystem: this.options.rootFilesystem, acknowledged: this.options.rootAcknowledged,
      output: this.options.output, quiesce: this.options.quiesceRoot, stop: this.options.stopRoot,
      retired: () => controllersFor(this.runtime).delete(state.pid),
      wake: () => this.wakeBudget(this.options.budget),
    });
    this.rootPrepared = true;
  }
  async runtimeMessage(message: WorkerProcessMessage, senderPid: number): Promise<void> {
    if (message.operation === "spawn") message = { ...message, request: { ...message.request, executable: this.qualifyExecutable(message.request.executable) } };
    return (await this.processService()).runtimeMessage(message, senderPid);
  }
  rejectRuntimeMessage(message: WorkerProcessMessage, senderPid = this.root?.pid): void {
    void this.processService().then(service => service.rejectRuntimeMessage(message, senderPid)).catch(error => this.report(error));
  }
  handleAdapterMessage(message: unknown, context: ProcessContext): void {
    const data = message as WorkerMessage;
    const fatal = readOutcome(context.outcome)?.kind === "signaled";
    if (data.type === "spawn") {
      if (fatal || isRevoked(data.request.filesystem) || data.request.parentPid !== context.pid) this.cancel(data.request);
      else this.spawn(data.request);
    } else if (data.type === "child-close" && !fatal && data.parentPid === context.pid) this.close(data.parentPid, data.pid);
  }
  revokeRuntimeProcess(pid: number): void { this.service?.revokeRuntimeProcess(pid); }
  private exited(supervisor: ProcessSupervisor, event: ChildExitEvent): void {
    const child = this.children.get(event.pid);
    if (child) {
      child.confirmed = true;
      childTransport(child.spawn.child).finish(event.result.status, event.result.kind === "signaled" ? event.result.code : undefined);
      if (!child.acknowledged) this.filesystem.revoke(child.spawn.filesystem);
      if (!child.worker || child.stopped) this.children.delete(event.pid);
    }
    const parent = supervisor.get(event.parentPid);
    // A live parent owns its waitable result until it closes the handle. Orphans have no
    // possible waiter; reap their metadata without turning parent exit into background kill.
    // Generic identities share a non-recycled directory. Keep their ancestry until service
    // disposal: a retained descendant spawn may still be queued behind lazy admission.
    if (event.parentPid !== 0 && (child?.closed || !parent || parent.result)) { supervisor.reap(event.parentPid, event.pid); this.service?.releaseLegacyJob(event.job); }
    const completed = Array.from(supervisor.table.values()).filter(record => record.parentPid === event.pid && record.result && !this.service?.transportFor(record.pid));
    for (const record of completed) { supervisor.reap(event.pid, record.pid); this.service?.releaseLegacyJob(record.job); }
  }

  spawn(spawn: SpawnRequest): void {
    if (this.disposed) { this.cancel(spawn); return; }
    spawn = { ...spawn, executable: this.qualifyExecutable(spawn.executable) };
    this.rootTransport();
    const child: Child = { spawn, signal: 0, acknowledged: false, confirmed: false, closed: false, stopped: false };
    this.children.set(spawn.pid, child);
    // Publish pending ancestry before lazy admission. Root exit waits only for these lease
    // acquisitions, never worker startup; the table takes over retention at reservation.
    let release!: () => void;
    const retention = this.service && this.rootPrepared
      ? Promise.resolve(release = this.service.retainRoot(this.root!.pid))
      : this.prepareRoot().then(() => release = this.service!.retainRoot(this.root!.pid));
    this.pendingAdmissions.add(retention);
    // No import, compile, worker startup or wait is on the synchronous spawn path.
    void this.ready().then(supervisor => {
      try {
        if (this.disposed) return;
        this.service!.registerController(spawn.pid, {
          filesystem: spawn.filesystem, acknowledged: () => child.acknowledged,
          launch: context => this.launch(context),
          quiesce: () => this.quiesceChild(child),
          exited: event => this.exited(supervisor, event),
          startFailed: error => { childTransport(spawn.child).stderr.write(new TextEncoder().encode(`bun-wasm: process start failed: ${String(error)}\n`)); },
          revoke: () => this.cancel(spawn),
          stop: () => this.physicallyStop(child),
          wake: () => this.wakeBudget(spawn.child.budget),
        });
        // This request was admitted while its sender still held filesystem authority. A root
        // exit during lazy activation must not erase an already accepted independent job.
        supervisor.reserveAdmittedSpawn(spawn.parentPid, {
          executable: spawn.executable, argv: spawn.argv, env: spawn.env, cwd: spawn.cwd,
          job: spawn.job ?? spawn.jobId, fds: [],
        }, { pid: spawn.pid, job: spawn.jobId, interrupt: spawn.child.interrupt, requestedSignal: spawn.child.requestedSignal, signalState: spawn.child.signalState, outcome: spawn.child.outcome });
        const signal = Atomics.load(new Int32Array(spawn.child.requestedSignal), 0);
        if (signal) { child.signal = signal; supervisor.observeSignal(spawn.pid, signal); }
        return supervisor.start(spawn.pid);
      } finally { release(); }
    }).catch(error => {
      childTransport(spawn.child).stderr.write(new TextEncoder().encode(`bun-wasm: process start failed: ${String(error)}\n`));
      childTransport(spawn.child).finish(126);
      this.filesystem.revoke(spawn.filesystem);
      this.children.delete(spawn.pid);
    }).finally(() => { release?.(); this.pendingAdmissions.delete(retention); });
    this.watch();
  }

  private launch(context: ProcessContext) {
    const child = this.children.get(context.pid);
    if (!child || this.disposed) throw new Error("Process no longer has a live controller");
    const spawn = child.spawn;
    child.context = context;
    const preview1 = context.adapter === "preview1";
    const interruptible = context.interruptible;
    if (!preview1 && !/^bun:(browser|quickjs|jsc)$/.test(context.adapter)) throw new Error(`Unknown Bun adapter: ${context.adapter}`);
    const engine = preview1 ? "browser" : context.adapter.slice(4) as Engine;
    const request: RunRequest = {
      module: context.module, engine, adapter: preview1 ? "preview1" : "bun", interruptible,
      args: spawn.argv, env: { ...spawn.env, PWD: spawn.cwd },
      filesystem: this.filesystem.connect(spawn.filesystem), child: spawn.child,
      pid: spawn.pid, jobId: spawn.jobId, identity: spawn.child.identity, interrupt: spawn.child.interrupt,
      signalState: spawn.child.signalState, requestedSignal: spawn.child.requestedSignal, outcome: spawn.child.outcome,
      trace: spawn.trace, slots: spawn.slots, spawnBroker: true, net: null, moduleCache: null,
    };
    if (!preview1 && engine === "browser" && new URL(this.workerUrl).pathname.endsWith("/__bunwasm/worker.js")) request.moduleCache = `bunwasm-m-${crypto.randomUUID()}`;
    child.request = request;
    let worker: Worker;
    try { worker = new Worker(this.workerUrl, { type: "module" }); }
    catch (error) { request.filesystem.port.close(); throw error; }
    child.worker = worker;
    context.registerRevocation(() => {
      if (!this.runtime.disposed) this.filesystem.revoke(spawn.filesystem);
      const transport = childTransport(spawn.child);
      if (!spawn.child.inheritedStdin) transport.stdin.close();
      transport.stdout.close(); transport.stderr.close();
    });
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      const selected = readOutcome(outcomeWord(spawn.child.outcome));
      if (data.type === "cleanup-error") {
        console.error("bun-wasm: child cleanup failed", data.message);
        // Cleanup faults are not ordered release acknowledgements. Preserve the chosen
        // terminal status, but require the host's admission fence before confirmation.
        if (data.signal) context.defaultSignal(data.signal);
        else context.exit(data.code);
        this.stopSafely(child);
        return;
      }
      if (data.type === "runtime-proc") {
        if (selected?.kind === "signaled" || isRevoked(spawn.filesystem)) this.rejectRuntimeMessage(data, context.pid);
        else void this.runtimeMessage(data, context.pid).catch(error => this.report(error));
        return;
      }
      if (selected?.kind === "signaled" && data.type !== "exit" && data.type !== "error") {
        // Reject queued capabilities even when fatal publication preceded filesystem revocation.
        if (data.type === "spawn") this.cancel(data.request);
        return;
      }
      if (data.type === "spawn") {
        if (isRevoked(spawn.filesystem) || data.request.parentPid !== context.pid) this.cancel(data.request);
        else this.spawn(data.request);
        return;
      }
      if (data.type === "child-close") {
        if (!isRevoked(spawn.filesystem) && data.parentPid === context.pid) this.close(data.parentPid, data.pid);
        return;
      }
      if (data.type !== "exit" && data.type !== "error") return;
      if (data.cleanupErrors?.length) console.error("bun-wasm: child cleanup failed", data.cleanupErrors);
      child.acknowledged = true;
      this.filesystem.reap(spawn.filesystem);
      if (data.type === "exit" && data.signal) context.defaultSignal(data.signal as Signal);
      else if (data.type === "exit") context.exit(data.code);
      else context.fail(new Error(data.message));
      this.stopSafely(child);
    };
    worker.onerror = event => {
      event.preventDefault();
      childTransport(spawn.child).stderr.write(new TextEncoder().encode(`bun-wasm: child worker failed: ${event.message}\n`));
      context.fail(new Error(event.message));
      // Error events are not quiescent acknowledgements. The outcome is already selected,
      // but filesystem work must drain before exit confirmation or physical termination.
      this.stopSafely(child);
    };
    try { worker.postMessage(request, [request.filesystem.port]); }
    catch (error) {
      request.filesystem.port.close();
      this.stopSafely(child);
      throw error;
    }
    return { terminate: () => this.stop(child) };
  }

  private quiesceChild(child: Child): void | Promise<void> {
    if (child.acknowledged) return;
    return child.quiescence ??= this.filesystem.quiesce(child.spawn.filesystem);
  }
  async wait(pid: number): Promise<ProcessExit> {
    const child = this.children.get(pid);
    const supervisor = await this.ready();
    return supervisor.waitForExit(child?.spawn.parentPid ?? supervisor.get(pid)?.parentPid ?? this.options.root?.pid ?? 1, pid);
  }
  private childSignalTransport(child: Child): SignalTransport {
    const transport = child.spawn.child;
    return { signalState: createSignalState(transport.signalState), interrupt: new Int32Array(transport.interrupt),
      requestedSignal: new Int32Array(transport.requestedSignal), outcome: outcomeWord(transport.outcome) };
  }
  private wakeBudget(budget?: SharedArrayBuffer): void {
    if (!budget) return;
    const cells = new Int32Array(budget); Atomics.add(cells, 1, 1); Atomics.notify(cells, 1);
  }
  private deliver(targets: { pid: number; transport: SignalTransport; child?: Child }[], signal: number): Promise<void> {
    // Publication has no callbacks. Every default member's terminal choice precedes any revoke,
    // stream closure, or worker stop, including reentrant exits caused by those operations.
    const deliveries = targets.map(target => ({ ...target, delivery: requestSignal(target.transport, signal) }));
    for (const { pid, child, delivery } of deliveries) {
      if (delivery.action === "handled" || delivery.outcome?.kind === "signaled") {
        // Signal interrupt hints are not the readiness word on which hostPoll sleeps.
        // Preserve that existing pipe/child wake source, including roots without children.
        this.wakeBudget(child?.spawn.child.budget ?? (pid === this.root?.pid ? this.options.budget : undefined));
      }
      if (delivery.outcome?.kind === "signaled") this.revokeRuntimeProcess(pid);
    }
    for (const { child, delivery } of deliveries) {
      if (!child) continue;
      if (delivery.action !== "ignore") child.signal = Atomics.load(new Int32Array(child.spawn.child.requestedSignal), 0);
      if (delivery.outcome) {
        this.filesystem.revoke(child.spawn.filesystem);
        childTransport(child.spawn.child).finish(delivery.outcome.status, delivery.outcome.kind === "signaled" ? delivery.outcome.code : undefined);
        if (child.worker) this.stopSafely(child);
      }
    }
    if (!this.activation) return Promise.resolve();
    return this.activation.then(supervisor => {
      for (const { pid, delivery } of deliveries) {
        if (delivery.action !== "ignore" && supervisor.get(pid)) supervisor.observeSignal(pid, signal);
      }
    });
  }
  kill(pid: number, signal: number): Promise<void> {
    const sig = checkedSignal(signal), child = this.children.get(pid);
    if (child) return this.deliver([{ pid, child, transport: this.childSignalTransport(child) }], sig);
    if (this.root?.pid === pid) return this.service ? this.service.kill(pid, sig) : this.deliver([{ pid, transport: this.root }], sig);
    // Generic children belong to the page service, including their executor-specific
    // wake hooks. Calling the supervisor directly queues SIGINT but strands host-poll.
    return this.processService().then(service => service.kill(pid, sig));
  }
  killJob(job: number, signal: number): Promise<void> {
    const sig = checkedSignal(signal);
    const targets = Array.from(this.children.values()).filter(child => child.spawn.jobId === job)
      .map(child => ({ pid: child.spawn.pid, child, transport: this.childSignalTransport(child) }));
    // Root and child workers share these exact words with a later lazy supervisor instance.
    // Never publish locally and then call supervisor.killJob: that could replay a consumed bit.
    const root: { pid: number; transport: SignalTransport; child?: Child }[] = this.root?.job === job
      ? [{ pid: this.root.pid, transport: this.root }] : [];
    if (!this.service) return this.deliver(root.concat(targets), sig);
    const all = root.concat(targets);
    const delivered = this.service.killJob(job, sig, all.map(target => ({ pid: target.pid, signals: target.transport })));
    // Generic publication includes pending legacy reservations. Legacy completion words and
    // pipes remain a separate ABI, updated only after every member selected its outcome.
    for (const target of all) {
      this.wakeBudget(target.child?.spawn.child.budget ?? (target.pid === this.root?.pid ? this.options.budget : undefined));
      const result = readOutcome(target.transport.outcome);
      if (!target.child || !result) continue;
      this.filesystem.revoke(target.child.spawn.filesystem);
      childTransport(target.child.spawn.child).finish(result.status, result.kind === "signaled" ? result.code : undefined);
      if (target.child.worker) this.stopSafely(target.child);
    }
    return delivered;
  }
  /** Guest handle ownership, not process ancestry. Close makes an existing wait resolve before
   * reaping; closing a completed child simply releases its retained argv/env/job metadata.
   */
  close(parentPid: number, pid: number): void {
    const child = this.children.get(pid);
    if (child && child.spawn.parentPid !== parentPid) return;
    if (child) child.closed = true;
    if (!this.activation) return;
    void this.activation.then(supervisor => {
      const record = supervisor.get(pid);
      if (!record || record.parentPid !== parentPid) return;
      if (!record.result) {
        // Completion reaches the parent through shared memory before this page necessarily
        // receives the worker's exit message. Preserve that acknowledgement's outcome kind.
        const completed = child && Atomics.load(new Int32Array(child.spawn.child.control), 0);
        const killed = child && Atomics.load(new Int32Array(child.spawn.child.requestedSignal), 0) === 9;
        if (completed && !killed) return;
        supervisor.kill(pid, 9);
      }
      if (supervisor.get(pid)?.result) { supervisor.reap(parentPid, pid); this.service?.releaseLegacyJob(record.job); }
    }).catch(error => this.report(error));
  }
  /** A run exits only its root; it never owns shared service teardown. */
  rootExit(code: number): void | Promise<void> {
    if (!this.root) return;
    const pid = this.root.pid;
    this.revokeRuntimeProcess(pid);
    if (!this.activation && !this.service && !this.pendingAdmissions.size) return;
    return this.prepareRoot().then(async () => {
      await Promise.all(this.pendingAdmissions);
      return this.service!.rootExit(pid, code);
    });
  }

  private cleanupCache(child: Child): void { if (child.request?.moduleCache) void caches.delete(child.request.moduleCache); }
  private physicallyStop(child: Child): void {
    if (child.stopped) return;
    child.stopped = true;
    child.worker?.terminate();
    this.cleanupCache(child);
    // Physical stop can precede supervisor confirmation on the same filesystem fence.
    // Preserve handle-close ownership until exited() has used it to reap the safe result.
    if (child.confirmed || this.runtime.disposed) this.children.delete(child.spawn.pid);
  }
  private stop(child: Child): void | Promise<void> {
    // The owning broker fences disposed runtimes and invokes the explicit physical-stop hook.
    if (this.runtime.disposed) return;
    if (child.stopped) return;
    if (child.acknowledged) { this.physicallyStop(child); return; }
    return child.stopping ??= Promise.resolve(this.quiesceChild(child)).then(() => this.physicallyStop(child));
  }
  private stopSafely(child: Child): void {
    try { const pending = this.stop(child); if (pending) void pending.catch(error => this.report(error)); }
    catch (error) { this.report(error); }
  }
  private report(error: unknown): void { console.error("bun-wasm: process controller failed", error); }
  /** Release an unadmitted request whose sender has already lost process authority. */
  rejectSpawn(spawn: SpawnRequest): void { this.cancel(spawn); }
  private cancel(spawn: SpawnRequest): void {
    const result = claimOutcome(outcomeWord(spawn.child.outcome), { kind: "signaled", code: 9 });
    if (result.kind === "signaled" && result.code === 9) {
      Atomics.store(new Int32Array(spawn.child.requestedSignal), 0, 9);
      Atomics.store(new Int32Array(spawn.child.interrupt), 0, 9);
    }
    if (!this.runtime.disposed) this.filesystem.revoke(spawn.filesystem);
    childTransport(spawn.child).finish(result.status, result.kind === "signaled" ? result.code : undefined);
  }
  private watch(): void {
    if (this.timer !== null || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.ready().then(supervisor => {
        for (const [pid, child] of this.children) {
          const record = supervisor.get(pid);
          if (!record || record.result) continue;
          // A publisher can stop after the atomic decision but before writing the wake header.
          // Adopt that decision; physical teardown still waits for filesystem quiescence.
          const result = readOutcome(record.outcome);
          if (result) {
            if (result.kind === "signaled") supervisor.defaultSignal(pid, result.code);
            else supervisor.exit(pid, result.code);
            continue;
          }
          const signal = Atomics.load(new Int32Array(child.spawn.child.requestedSignal), 0);
          if (!signal || signal === child.signal) continue;
          child.signal = signal;
          supervisor.observeSignal(pid, signal);
        }
      }).catch(error => this.report(error));
      if (this.children.size) this.watch();
    }, 4);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    // Only legacy children belonging to this adapter. The runtime owns shared consumers.
    for (const child of Array.from(this.children.values())) {
      this.cancel(child.spawn);
      if (child.worker) this.stopSafely(child); else this.children.delete(child.spawn.pid);
    }
  }
}

const installedAdapters = new WeakSet<Runtime>();
const runtimeControllers = new WeakMap<Runtime, Map<number, SubprocessBroker>>();
function controllersFor(runtime: Runtime): Map<number, SubprocessBroker> {
  let controllers = runtimeControllers.get(runtime);
  if (!controllers) runtimeControllers.set(runtime, controllers = new Map());
  return controllers;
}
/** Immutable engine-qualified registrations; concurrent runs never replace a global engine alias. */
export function installBunAdapters(runtime: Runtime, workerUrl: string): void {
  if (installedAdapters.has(runtime)) return;
  installedAdapters.add(runtime);
  const originController = async (context: ProcessContext, service: ProcessService) => {
    const supervisor = await service.ready();
    let parent = context.parentPid;
    let controller: SubprocessBroker | undefined;
    while (parent && !controller) { controller = controllersFor(runtime).get(parent); parent = supervisor.table.parentOf(parent) ?? 0; }
    return controller;
  };
  runtime.registerAdapter("preview1", async (context, service) => {
    const controller = await originController(context, service);
    return service.launchWorker(context, {
      workerUrl: new URL("./preview1-worker.js", workerUrl).href,
      request: { module: context.module, args: context.request.argv, env: { ...context.request.env, PWD: context.request.cwd }, interruptible: context.interruptible },
      // Alias selection belongs to this Bun composition root, including recursive Preview1
      // guests. The reusable worker/broker never guesses that an unknown executable is Bun.
      executableName: name => controller?.qualifyExecutable(name) ?? name,
    });
  });
  for (const engine of ["quickjs", "jsc", "browser"] as const) runtime.registerAdapter(`bun:${engine}`, async (context, service) => {
    const controller = await originController(context, service);
    const moduleCache = engine === "browser" && new URL(workerUrl).pathname.endsWith("/__bunwasm/worker.js") ? `bunwasm-m-${crypto.randomUUID()}` : null;
    const budget = createProcessBudget();
    return service.launchWorker<RunRequest>(context, {
      workerUrl,
      request: { engine, adapter: "bun", module: context.module, args: context.request.argv,
        env: { ...context.request.env, PWD: context.request.cwd }, pid: context.pid, jobId: context.job,
        budget, trace: false, spawnBroker: true, net: null, moduleCache },
      cleanup: () => { if (moduleCache) void caches.delete(moduleCache); },
      onMessage: message => controller?.handleAdapterMessage(message, context),
      executableName: name => controller?.qualifyExecutable(name) ?? name,
      wake: () => { const cells = new Int32Array(budget); Atomics.add(cells, 1, 1); Atomics.notify(cells, 1); },
      // Bun legacy children retain their separate pipe/slot adapter. Runtime-owned worker
      // transport uses only the generic process protocol; it never guesses legacy payloads.
    });
  });
}
