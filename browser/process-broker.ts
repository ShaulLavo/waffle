import type { FilesystemConnection, FilesystemIdentity } from "../fs/protocol";
import { isRevoked } from "../fs/protocol";
import type { ProcessSupervisor, RootProcessOptions } from "../proc/supervisor";
import type { ExecutableRegistry } from "../proc/registry";
import type { ProcessIdentityAllocator } from "../proc/identity";
import type { ProcessTable } from "../proc/table";
import type { ChildExitEvent, ProcessContext, ProcessHandle } from "../proc/types";
import { checkedSignal } from "../proc/types";
import { requestSignal, createSignalState, type SignalTransport } from "../proc/signals";
import { claimOutcome, outcomeWord, readOutcome } from "../proc/outcome";
import { WorkerProcessBroker } from "../proc/worker-broker";
import { confirmWorkerProcessJob, installWorkerBindings, wakeWorkerProcess, workerProcessDirectoryId, workerProcessSlots, workerProcessState, type WorkerProcessMessage, type WorkerProcessTransport } from "../proc/worker-client";
import { createFilesystemDescriptorCodec } from "../proc/filesystem-codec";
import { WorkerPipeBroker } from "../proc/worker-pipes";
import { attachPipePublicationRegistry, PipePublicationRegistry } from "../proc/pipes";
import { createRuntimeTerminalCodec } from "./runtime-terminals";
import type { RuntimeWorkerRequest } from "./worker";
import type { GuestReservation, LaunchedAdmission, SharedMemoryLedger } from "../memory";

export interface ProcessFilesystem {
  fork?(): FilesystemConnection;
  connect(identity: FilesystemIdentity): FilesystemConnection;
  revoke(identity: FilesystemIdentity): void;
  reap(identity: FilesystemIdentity): void;
  quiesce(identity: FilesystemIdentity): Promise<void>;
  sweep?(): void;
}
export interface ProcessController {
  filesystem?: FilesystemIdentity;
  acknowledged?(): boolean;
  launch?(context: ProcessContext): ProcessHandle | Promise<ProcessHandle>;
  startFailed?(error: unknown): void;
  canConfirmExit?(): boolean;
  quiesce?(): void | Promise<void>;
  exited?(event: ChildExitEvent): void;
  revoke?(): void;
  /** Physical consumer cleanup, after its filesystem admission fence. */
  stop?(): void | Promise<void>;
  wake?(): void;
  /** Release adapter ancestry after this root and its descendants no longer need it. */
  retired?(): void;
}
export interface BrowserProcessBrokerOptions {
  filesystem: ProcessFilesystem;
  /** Injectable lazy supervisor module loader; pipe-only roots never invoke it. */
  activate?: () => Promise<typeof import("../proc")>;
  identities: ProcessIdentityAllocator;
  registry: ExecutableRegistry;
  table: ProcessTable;
  launch(context: ProcessContext): ProcessHandle | Promise<ProcessHandle>;
  sharedMemory?: SharedMemoryLedger;
  onError?(error: unknown): void;
}
export interface RuntimeRootOptions {
  filesystem?: FilesystemIdentity;
  acknowledged?(): boolean;
  output?(fd: 1 | 2, data: Uint8Array): void;
  quiesce?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  wake?(): void;
  retired?(): void;
}
export interface WorkerLaunchOptions<T extends RuntimeWorkerRequest = RuntimeWorkerRequest> {
  workerUrl: string;
  request: Omit<T, "filesystem" | "runtimeProcess">;
  cleanup?(): void;
  onMessage?(message: unknown, context: ProcessContext): void;
  wake?(): void;
  executableName?(name: string): string;
  /** Required guest reservation; admission happens before filesystem connect or Worker construction. */
  reservation: GuestReservation;
}
interface RuntimeChild {
  filesystem: FilesystemIdentity;
  context: ProcessContext;
  worker: Worker;
  acknowledged: boolean;
  failed: boolean;
  stopped: boolean;
  quiescence?: Promise<void>;
  stopping?: Promise<void>;
  cleanup?(): void;
  wake?(): void;
  admission?: LaunchedAdmission;
}

/** Page-owned process admission and descriptor transport. Guest adapter policy is injected. */
export class BrowserProcessBroker {
  private suspended = false;
  private disposing?: Promise<void>;
  private activation?: Promise<ProcessSupervisor>;
  private supervisor?: ProcessSupervisor;
  private readonly pipes = new WorkerPipeBroker();
  private readonly roots = new Map<number, WorkerProcessTransport>();
  private readonly reservedRoots = new Map<number, RootProcessOptions & SignalTransport & { pid: number; job: number }>();
  private readonly completedRoots = new Set<number>();
  private readonly rootLeases = new Map<number, number>();
  private readonly controllers = new Map<number, ProcessController>();
  private readonly outputs = new Map<number, RuntimeRootOptions["output"]>();
  private readonly registries = new Map<number, PipePublicationRegistry>();
  private readonly children = new Map<number, RuntimeChild>();
  private readonly fences = new Map<number, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly transport: WorkerProcessBroker;
  constructor(private readonly options: BrowserProcessBrokerOptions) {
    this.transport = new WorkerProcessBroker({
      supervisor: () => this.ready(), codec: transport => this.descriptorCodec(transport),
      onPipe: handle => this.pipes.attach(handle as import("../proc/pipes").PipeEndpointHandle),
      pumpPipes: () => this.pipes.pump(), onError: error => this.report(error),
      quiesce: (_pid, transport) => options.filesystem.quiesce(this.filesystem(transport)),
    });
  }
  ready(): Promise<ProcessSupervisor> {
    return this.activation ??= (this.options.activate?.() ?? import("../proc")).then(proc => {
      const supervisor = this.supervisor = new proc.ProcessSupervisor({
        registry: this.options.registry, table: this.options.table,
        launch: context => {
          if (this.suspended) throw new Error("Process broker is disposed");
          return this.controllers.get(context.pid)?.launch?.(context) ?? this.options.launch(context);
        },
        canConfirmExit: pid => {
          const child = this.children.get(pid);
          return this.suspended || (child ? child.acknowledged || child.failed : this.controllers.get(pid)?.canConfirmExit?.() ?? true);
        },
        quiesce: pid => this.quiesceProcess(pid), retainJobResults: true,
        startFailed: (pid, error) => {
          const controller = this.controllers.get(pid);
          if (controller?.startFailed) { controller.startFailed(error); return; }
          const stderr = this.options.table.get(pid)?.descriptors.get(2)?.resource;
          if (stderr?.kind === "pipe" || stderr?.kind === "terminal") {
            const bytes = new TextEncoder().encode(`runtime: process start failed: ${String(error)}\n`);
            (stderr.tryWrite ?? stderr.write).call(stderr, [bytes]);
          }
        },
        onError: error => this.report(error),
      });
      supervisor.onChildExit(event => {
        this.revokeRuntimeProcess(event.pid);
        const transport = this.transport.get(event.pid);
        if (transport && !this.children.get(event.pid)?.acknowledged) this.options.filesystem.revoke(this.filesystem(transport));
        this.controllers.get(event.pid)?.exited?.(event);
        this.retireRoots();
      });
      supervisor.onJobReap(() => this.retireRoots());
      for (const root of this.reservedRoots.values()) if (!supervisor.get(root.pid)) supervisor.createRoot(root);
      for (const transport of this.roots.values()) this.activateRuntimeRoot(supervisor, transport);
      if (this.suspended) supervisor.dispose();
      return supervisor;
    });
  }
  /** Register an explicit adapter controller (including legacy transports), not a default adapter. */
  registerController(pid: number, controller: ProcessController): void {
    if (this.suspended) throw new Error("Process broker is disposed");
    if (this.controllers.has(pid)) throw new Error(`Process ${pid} already has a controller`);
    this.controllers.set(pid, controller);
  }
  /** Reserve an externally executed root without activating the optional supervisor. */
  reserveRoot(root: RootProcessOptions, controller: ProcessController = {}): number {
    if (this.suspended) throw new Error("Process broker is disposed");
    const pid = root.pid ?? this.options.identities.pid(), job = root.job ?? this.options.identities.job();
    this.options.identities.observePid(pid);
    this.options.identities.observeJob(job);
    const word = (value?: Int32Array | SharedArrayBuffer) => value instanceof Int32Array ? value : new Int32Array(value ?? new SharedArrayBuffer(4));
    const reserved = { ...root, pid, job, signalState: createSignalState(root.signalState), outcome: outcomeWord(root.outcome), interrupt: word(root.interrupt), requestedSignal: word(root.requestedSignal) };
    this.registerController(pid, controller);
    this.reservedRoots.set(pid, reserved);
    if (this.supervisor) this.supervisor.createRoot(reserved);
    return pid;
  }
  /** Keep an accepted external spawn's ancestry until its asynchronous admission finishes. */
  retainRoot(pid: number): () => void {
    if (this.suspended) throw new Error("Process broker is disposed");
    if (!this.reservedRoots.has(pid)) throw new Error(`Unknown root process ${pid}`);
    this.rootLeases.set(pid, (this.rootLeases.get(pid) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.rootLeases.get(pid) ?? 1) - 1;
      if (remaining) this.rootLeases.set(pid, remaining);
      else this.rootLeases.delete(pid);
      this.retireRoots();
    };
  }
  private retireRoots(): void {
    if (this.suspended) return;
    for (const pid of this.completedRoots) {
      if (this.rootLeases.has(pid)) continue;
      const descendant = (child: number): boolean => {
        for (let parent = this.options.table.parentOf(child); parent; parent = this.options.table.parentOf(parent)) if (parent === pid) return true;
        return false;
      };
      if (Array.from(this.options.table.values()).some(record => descendant(record.pid))) continue;
      const transport = this.roots.get(pid);
      if (transport && workerProcessSlots(transport).some(slot => {
        const state = workerProcessState(transport, slot);
        return state.pid !== pid && (Atomics.load(state.confirmed, 0) === 0 ||
          (state.job !== workerProcessState(transport).job && Atomics.load(state.jobPending, 0) >= 0));
      })) continue;
      const root = this.reservedRoots.get(pid), controller = this.controllers.get(pid);
      this.transport.releaseRoot(pid);
      this.options.table.remove(pid);
      if (root && !this.options.table.job(root.job)?.members.size) this.options.table.removeJob(root.job);
      this.completedRoots.delete(pid);
      this.reservedRoots.delete(pid);
      this.controllers.delete(pid);
      this.roots.delete(pid);
      this.outputs.delete(pid);
      this.registries.delete(pid);
      this.fences.delete(pid);
      try { controller?.retired?.(); } catch (error) { this.report(error); }
    }
  }
  async adoptRoot(root: RootProcessOptions, controller: ProcessController = {}): Promise<number> {
    const pid = this.reserveRoot(root, controller);
    // Reservation transfers an external consumer's teardown capabilities to this owner.
    // Activation may fail after creating its table record; keep those capabilities until
    // disposal even when the caller observes a rejected admission promise.
    await this.ready();
    if (this.suspended) throw new Error("Process broker is disposed");
    return pid;
  }
  async adoptRuntimeRoot(transport: WorkerProcessTransport, options: RuntimeRootOptions = {}): Promise<void> {
    if (this.suspended) throw new Error("Process broker is disposed");
    if (transport.identity !== this.options.identities.buffer) throw new TypeError("root must borrow the runtime identity allocator");
    this.filesystem(transport);
    const state = workerProcessState(transport);
    this.transport.adoptRoot(transport);
    this.roots.set(state.pid, transport);
    this.outputs.set(state.pid, options.output);
    const data = transport.data as { filesystem: FilesystemIdentity; pipeRegistry?: import("../proc/pipes").PipePublicationRegistryHandle };
    const registry = data.pipeRegistry ? attachPipePublicationRegistry(data.pipeRegistry) : new PipePublicationRegistry({ wake: state.wake });
    this.registries.set(state.pid, registry);
    transport.data = { ...data, pipeRegistry: registry.handle() };
    this.reserveRoot({ pid: state.pid, job: state.job, ...state.signals }, options);
    if (this.activation) {
      const supervisor = await this.activation;
      if (this.suspended) throw new Error("Process broker is disposed");
      this.activateRuntimeRoot(supervisor, transport);
    }
  }
  private activateRuntimeRoot(supervisor: ProcessSupervisor, transport: WorkerProcessTransport): void {
    const state = workerProcessState(transport);
    if (!supervisor.get(state.pid)) supervisor.createRoot({ pid: state.pid, job: state.job, ...state.signals });
    supervisor.registerRevocation(state.pid, () => this.revokeRuntimeProcess(state.pid));
    installWorkerBindings(transport, supervisor.get(state.pid)!.descriptors, this.descriptorCodec(transport));
    const result = readOutcome(state.signals.outcome);
    if (result?.kind === "signaled") supervisor.defaultSignal(state.pid, result.code);
    else if (result) supervisor.exit(state.pid, result.code);
  }
  private filesystem(transport: WorkerProcessTransport): FilesystemIdentity {
    const identity = (transport.data as { filesystem?: FilesystemIdentity } | undefined)?.filesystem;
    if (!identity) throw new TypeError("runtime process has no filesystem identity");
    return identity;
  }
  private descriptorCodec(transport: WorkerProcessTransport) {
    return this.pipes.codec(createRuntimeTerminalCodec({
      fallback: createFilesystemDescriptorCodec(this.filesystem(transport), undefined, () => this.options.filesystem.sweep?.()),
      output: (fd, bytes) => this.outputFor(workerProcessState(transport).pid)?.(fd, bytes),
    }));
  }
  private outputFor(pid: number): RuntimeRootOptions["output"] {
    for (;;) {
      if (this.outputs.has(pid)) return this.outputs.get(pid);
      const parent = this.options.table.parentOf(pid);
      if (!parent) return undefined;
      pid = parent;
    }
  }
  revokeRuntimeProcess(pid: number): void {
    // A root directory owns its publication registry. Revocation must never allocate an
    // unrelated pid in every other directory (whose independent capacities are bounded).
    for (const [rootPid, transport] of this.roots) {
      if (workerProcessSlots(transport).some(slot => workerProcessState(transport, slot).pid === pid)) {
        this.registries.get(rootPid)?.revoke(pid);
        return;
      }
    }
  }
  async runtimeMessage(message: WorkerProcessMessage, senderPid: number): Promise<void> {
    const sender = this.transport.getIdentity(senderPid);
    const result = sender && readOutcome(workerProcessState(sender).signals.outcome);
    if (!sender || this.suspended || (message.operation !== "reap-job" && (result?.kind === "signaled" || (!result && isRevoked(this.filesystem(sender)))))) {
      this.rejectRuntimeMessage(message, senderPid); return;
    }
    await this.transport.handle(message, senderPid);
    this.retireRoots();
    if (message.operation !== "pipe") this.watch();
  }
  rejectRuntimeMessage(message: WorkerProcessMessage, senderPid?: number): void {
    if (message.operation === "reap-job") {
      if (!this.suspended && senderPid !== undefined && this.transport.getIdentity(senderPid)) void this.transport.handle(message, senderPid).catch(error => this.report(error));
      return;
    }
    if (message.operation !== "spawn") return;
    const transport = message.transport, state = workerProcessState(transport);
    const existing = this.transport.getIdentity(state.pid);
    if (existing && workerProcessDirectoryId(existing) === workerProcessDirectoryId(transport)) return;
    requestSignal(state.signals, 9);
    this.revokeRuntimeProcess(state.pid);
    const identity = this.filesystem(transport);
    this.options.filesystem.revoke(identity);
    const codec = this.descriptorCodec(transport);
    let cleaned = true;
    for (const token of transport.resources) try { codec.discard(token); } catch (error) { cleaned = false; this.report(error); }
    wakeWorkerProcess(transport);
    void this.options.filesystem.quiesce(identity).then(() => {
      if (!cleaned) return;
      Atomics.store(state.confirmed, 0, 1); confirmWorkerProcessJob(transport);
    }).catch(error => this.report(error));
  }
  transportFor(pid: number): WorkerProcessTransport | undefined { return this.transport.get(pid); }
  /** Legacy handle ABIs have no job waiter; release their empty, unshared completion metadata. */
  releaseLegacyJob(job: number): void {
    this.retireRoots();
    const record = this.options.table.job(job);
    if (!record || record.members.size || record.pendingMembers || this.states().some(state => state.job === job)) return;
    this.supervisor?.reapJob(record.ownerPid, job);
  }
  launchWorker<T extends RuntimeWorkerRequest>(context: ProcessContext, options: WorkerLaunchOptions<T>): ProcessHandle {
    if (this.suspended) throw new Error("Process broker is disposed");
    const transport = this.transport.get(context.pid);
    if (!transport) throw new Error("process has no admitted worker transport");
    const filesystem = this.filesystem(transport);
    const admission = this.options.sharedMemory?.admit({
      pid: context.pid,
      executable: context.request.executable,
      guest: options.reservation,
      connections: 0,
    });
    let request: RuntimeWorkerRequest;
    let worker: Worker;
    try {
      request = { ...options.request, filesystem: this.options.filesystem.connect(filesystem), runtimeProcess: transport };
      worker = new Worker(options.workerUrl, { type: "module" });
    } catch (error) {
      admission?.abort();
      throw error;
    }
    const child: RuntimeChild = { filesystem, context, worker, acknowledged: false, failed: false, stopped: false, cleanup: options.cleanup, wake: options.wake, admission: admission?.launched() };
    this.children.set(context.pid, child);
    this.watch();
    context.registerRevocation(() => { this.revokeRuntimeProcess(context.pid); this.options.filesystem.revoke(filesystem); });
    worker.onmessage = ({ data }: MessageEvent<any>) => {
      const selected = readOutcome(context.outcome);
      if (data.type === "runtime-proc") {
        if (selected?.kind === "signaled" || (!selected && isRevoked(filesystem))) this.rejectRuntimeMessage(data, context.pid);
        else {
          const message = data.operation === "spawn" && options.executableName
            ? { ...data, request: { ...data.request, executable: options.executableName(data.request.executable) } } : data;
          void this.runtimeMessage(message, context.pid).catch(error => this.report(error));
        }
        return;
      }
      if (data.type === "cleanup-error") {
        child.failed = true;
        this.report(new Error(`${data.message}: ${data.cleanupErrors.join("; ")}`));
        if (data.signal) context.defaultSignal(data.signal);
        else context.exit(data.code);
        this.stopSafely(child);
        return;
      }
      if (selected?.kind === "signaled" && data.type !== "exit" && data.type !== "error") { options.onMessage?.(data, context); return; }
      if (data.type === "stdout" || data.type === "stderr") { if (!this.suspended) this.outputFor(context.pid)?.(data.type === "stderr" ? 2 : 1, data.data); return; }
      if (data.type !== "exit" && data.type !== "error") { options.onMessage?.(data, context); return; }
      child.acknowledged = true;
      this.options.filesystem.reap(filesystem);
      if (data.cleanupErrors?.length) this.report(new Error(`Worker cleanup: ${data.cleanupErrors.join("; ")}`));
      if (data.type === "exit" && data.signal) context.defaultSignal(data.signal);
      else if (data.type === "exit") context.exit(data.code);
      else context.fail(new Error(data.message));
      this.stopSafely(child);
    };
    worker.onerror = event => { event.preventDefault(); child.failed = true; context.fail(new Error(event.message)); this.stopSafely(child); };
    try { worker.postMessage(request, [request.filesystem.port]); }
    catch (error) { child.failed = true; request.filesystem.port.close(); this.stopSafely(child); throw error; }
    return { terminate: () => this.stop(child) };
  }
  private quiesceProcess(pid: number): void | Promise<void> {
    const pending = this.fences.get(pid);
    if (pending) return pending;
    const fence = this.processFence(pid);
    if (fence) this.fences.set(pid, fence);
    return fence;
  }
  private processFence(pid: number): void | Promise<void> {
    const controller = this.controllers.get(pid);
    if (controller?.acknowledged?.()) return;
    if (controller?.quiesce && !this.suspended) return controller.quiesce();
    if (controller?.filesystem) return this.options.filesystem.quiesce(controller.filesystem);
    if (controller?.quiesce) return controller.quiesce();
    const child = this.children.get(pid);
    if (child) return this.quiesceChild(child);
    const transport = this.transport.get(pid);
    if (transport) return this.options.filesystem.quiesce(this.filesystem(transport));
  }
  private quiesceChild(child: RuntimeChild): void | Promise<void> {
    if (child.acknowledged) return;
    return child.quiescence ??= this.options.filesystem.quiesce(child.filesystem);
  }
  private stop(child: RuntimeChild): void | Promise<void> {
    if (child.stopped) return;
    const stop = () => {
      if (child.stopped) return;
      child.stopped = true;
      try {
        child.worker.terminate();
        child.cleanup?.();
        child.admission?.stopped();
      } catch (error) {
        child.admission?.failed(error);
        throw error;
      } finally {
        this.children.delete(child.context.pid);
      }
    };
    if (child.acknowledged) { stop(); return; }
    return child.stopping ??= Promise.resolve(this.quiesceChild(child)).then(stop);
  }
  private stopSafely(child: RuntimeChild): void { try { const pending = this.stop(child); if (pending) void pending.catch(error => this.report(error)); } catch (error) { this.report(error); } }
  private states() { return Array.from(this.roots.values()).flatMap(root => workerProcessSlots(root).map(slot => workerProcessState(root, slot))); }
  async kill(pid: number, signal: number): Promise<void> {
    const sig = checkedSignal(signal), state = this.states().find(state => state.pid === pid);
    const target = state?.signals ?? this.options.table.get(pid) ?? this.reservedRoots.get(pid);
    if (target) {
      requestSignal(target, sig);
      if (readOutcome(target.outcome)?.kind === "signaled") this.revokeRuntimeProcess(pid);
      this.wake();
    }
    const supervisor = await this.ready();
    if (this.suspended) return;
    if (supervisor.get(pid)) supervisor.observeSignal(pid, sig);
    else if (!state && !target) supervisor.kill(pid, sig);
  }
  async killJob(job: number, signal: number, reserved: readonly { pid: number; signals: SignalTransport }[] = []): Promise<void> {
    const sig = checkedSignal(signal), states = this.states().filter(state => state.job === job);
    const seen = new Set(states.map(state => state.pid));
    const records = Array.from(this.options.table.values()).filter(record => record.job === job && !seen.has(record.pid));
    // Generic reservations and admitted legacy processes select all terminal winners before
    // any callback can revoke capabilities. Observation never publishes the signal twice.
    for (const state of states) requestSignal(state.signals, sig);
    for (const record of records) requestSignal(record, sig);
    const published = new Set(states.map(state => state.pid).concat(records.map(record => record.pid)));
    const roots = Array.from(this.reservedRoots.values()).filter(root => root.job === job && !published.has(root.pid));
    const reservations = roots.map<{ pid: number; signals: SignalTransport }>(root => ({ pid: root.pid, signals: root })).concat(reserved);
    for (const target of reservations) if (!published.has(target.pid)) { requestSignal(target.signals, sig); published.add(target.pid); }
    // Directory reservations can own pipe endpoints before a spawn message reaches the
    // supervisor. Freeze those rows too, after every member has selected its outcome.
    for (const state of states) if (readOutcome(state.signals.outcome)?.kind === "signaled") this.revokeRuntimeProcess(state.pid);
    this.wake();
    const supervisor = await this.ready();
    if (this.suspended) return;
    for (const pid of published) if (supervisor.get(pid)) supervisor.observeSignal(pid, sig);
  }
  private wake(): void {
    for (const root of this.roots.values()) wakeWorkerProcess(root);
    for (const controller of this.controllers.values()) controller.wake?.();
    for (const child of this.children.values()) child.wake?.();
  }
  async rootExit(pid: number, code: number): Promise<void> {
    this.revokeRuntimeProcess(pid);
    if (!this.activation) {
      const root = this.reservedRoots.get(pid);
      if (root) claimOutcome(root.outcome, { kind: "exited", code });
      await this.quiesceProcess(pid);
      const transport = this.roots.get(pid);
      if (transport) { Atomics.store(workerProcessState(transport).confirmed, 0, 1); confirmWorkerProcessJob(transport); }
      if (root) this.completedRoots.add(pid);
      this.retireRoots();
      return;
    }
    let supervisor: ProcessSupervisor | undefined;
    try { supervisor = await this.activation; }
    catch (error) { this.report(error); supervisor = this.supervisor; }
    if (supervisor?.get(pid)) { supervisor.exit(pid, code); await supervisor.waitForExit(0, pid); }
    else await this.quiesceProcess(pid);
    const transport = this.roots.get(pid);
    if (transport) { Atomics.store(workerProcessState(transport).confirmed, 0, 1); confirmWorkerProcessJob(transport); }
    if (this.reservedRoots.has(pid)) this.completedRoots.add(pid);
    this.retireRoots();
  }
  private watch(): void {
    if (this.timer !== null || this.suspended) return;
    this.timer = setTimeout(() => { this.timer = null; try { this.transport.pump(); } catch (error) { this.report(error); } if (this.children.size) this.watch(); }, 4);
  }
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    // Publish every outcome before running user revocation callbacks.
    for (const state of this.states()) requestSignal(state.signals, 9);
    for (const root of this.reservedRoots.values()) requestSignal(root, 9);
    for (const record of this.options.table.values()) requestSignal(record, 9);
    for (const state of this.states()) { this.revokeRuntimeProcess(state.pid); const transport = this.transport.get(state.pid); if (transport) this.options.filesystem.revoke(this.filesystem(transport)); }
    for (const controller of this.controllers.values()) {
      if (controller.filesystem) this.options.filesystem.revoke(controller.filesystem);
      try { controller.revoke?.(); } catch (error) { this.report(error); }
    }
    // Retain every fence before transport disposal drops reservations and supervisor disposal
    // removes table records. Neither logical death nor terminate() proves admission quiescence.
    const pids = new Set(Array.from(this.options.table.values(), record => record.pid).concat(Array.from(this.controllers.keys()), this.states().map(state => state.pid)));
    for (const pid of pids) try { const pending = this.quiesceProcess(pid); if (pending) void pending.catch(error => this.report(error)); } catch (error) { this.fences.set(pid, Promise.reject(error)); }
    this.transport.dispose();
    this.supervisor?.dispose();
  }
  async quiesce(): Promise<void> {
    const pids = new Set(Array.from(this.options.table.values(), record => record.pid).concat(Array.from(this.controllers.keys()), Array.from(this.children.keys())));
    for (const pid of pids) this.quiesceProcess(pid);
    await Promise.all(this.fences.values());
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const disposal = this.disposing = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
    // Revocation callbacks may synchronously dispose their owner again.
    try { this.suspend(); } catch (error) { reject(error); return disposal; }
    void (async () => {
      if (this.activation) {
        try { await this.activation; } catch (error) { this.report(error); }
        this.supervisor?.dispose();
      }
      await this.quiesce();
      // Suspension freezes every owned pipe cursor; the filesystem fence above is still
      // mandatory. Attempt and settle every physical stop even if another consumer fails.
      const stops = Array.from(this.children.values(), child => Promise.resolve().then(() => this.stop(child)))
        .concat(Array.from(this.controllers.values(), controller => Promise.resolve().then(() => controller.stop?.())));
      const errors: unknown[] = [];
      for (const result of await Promise.allSettled(stops)) if (result.status === "rejected") errors.push(result.reason);
      try { this.pipes.dispose(); } catch (error) { errors.push(error); }
      for (const pid of this.reservedRoots.keys()) {
        try { this.controllers.get(pid)?.retired?.(); } catch (error) { errors.push(error); }
      }
      this.reservedRoots.clear(); this.completedRoots.clear(); this.rootLeases.clear();
      this.roots.clear(); this.outputs.clear(); this.registries.clear(); this.controllers.clear(); this.fences.clear();
      if (errors.length) throw new AggregateError(errors, "Process broker cleanup failed");
    })().then(resolve, reject);
    return disposal;
  }
  private report(error: unknown): void {
    try { if (this.options.onError) this.options.onError(error); else console.error("runtime: process controller failed", error); }
    catch { /* Diagnostics must not interrupt consumer fencing or cleanup. */ }
  }
}
