import { spawnError, startFailure } from "./start-failure.js";
import { MAX_ACCESS_REQUESTS } from "./access.js";
import { controlLoad, controlStore } from "./control.js";
import { createDirectory, directoryState, directorySlots, directoryJob, directoryProcesses, findDirectoryJob, directoryControls, isCollectedProcess, reserveDirectoryProcess, confirmDirectoryProcess, collectDirectoryProcess, collectDirectoryJob, wakeDirectory } from "./directory.js";
import { DescriptorTable, MAX_DESCRIPTOR, OpenDescription, type Descriptor, type Resource, type Stream } from "../core/descriptors.js";
import { ProcessIdentityAllocator } from "./identity.js";
import { claimOutcome, readOutcome, markStarted, startStatus } from "./outcome.js";
import { defaultSignalTerminates, requestSignal, type SignalTransport } from "./signals.js";
import { ProcessErrno, ProcessError, checkedSignal, type ProcessExit, type SpawnRequest } from "./types.js";

export { MAX_ACCESS_REQUESTS } from "./access.js";
// Two words: pending=0, complete=1, retired=2; then the signed WASI result.
// The broker stores the result before publishing complete and the common wake.
export type WorkerAccessRequest = { id: number; completion: SharedArrayBuffer };

export interface WorkerDescriptorBinding {
  fd: number;
  reference: number;
  rightsBase: bigint;
  rightsInheriting: bigint;
}
/** A token owns one retained process endpoint, not a second reference on deserialization.
 * import() may run in both controller and worker; its release must therefore be idempotent.
 * File/terminal adapters supply their own cloneable resource token and shared lifetime.
 */
export interface WorkerDescriptorCodec {
  export(descriptor: Descriptor, pid: number): unknown;
  import(token: unknown, pid: number): OpenDescription;
  discard(token: unknown): void;
}
export interface WorkerProcessTransport {
  directory: SharedArrayBuffer;
  identity: SharedArrayBuffer;
  slot: number;
  pid: number;
  bindings: WorkerDescriptorBinding[];
  resources: unknown[];
  /** Host adapter context, such as an independently reserved filesystem identity. */
  data?: unknown;
}
export type WorkerProcessMessage =
  | { type: "runtime-proc"; operation: "spawn"; transport: WorkerProcessTransport; request: SpawnRequest }
  | { type: "runtime-proc"; operation: "signal" | "exit"; transport: WorkerProcessTransport; targets: number[] }
  | { type: "runtime-proc"; operation: "pipe"; transport: WorkerProcessTransport; handle: unknown }
  | { type: "runtime-proc"; operation: "reap-job"; transport: WorkerProcessTransport; job: number }
  | { type: "runtime-proc"; operation: "reap-process"; transport: WorkerProcessTransport }
  | { type: "runtime-proc"; operation: "access"; transport: WorkerProcessTransport; request: WorkerAccessRequest; path: string; cwd: string }
  | { type: "runtime-proc"; operation: "access-cancel"; transport: WorkerProcessTransport; request: WorkerAccessRequest };

export const workerProcessState = directoryState;
function reserveRecord(transport: WorkerProcessTransport, pid: number, parentPid: number, job: number, jobOwner: number, jobSlot?: number, foreground = true): WorkerProcessTransport {
  return { ...reserveDirectoryProcess(transport, pid, parentPid, job, jobOwner, jobSlot, foreground), identity: transport.identity, bindings: [], resources: [] };
}
export function workerProcessDirectoryId(transport: WorkerProcessTransport): string {
  const header = new Uint32Array(transport.directory, 0, 8);
  return `${header[2]}:${header[3]}`;
}
export function createWorkerProcessTransport(options: { pid?: number; job?: number; identity?: SharedArrayBuffer; capacity?: number; foreground?: boolean } = {}): WorkerProcessTransport {
  const pid = options.pid ?? 1, job = options.job ?? 1, capacity = options.capacity ?? 1024;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 65536) throw new RangeError("invalid process directory capacity");
  const identities = new ProcessIdentityAllocator(options.identity);
  identities.observePid(pid); identities.observeJob(job);
  const transport: WorkerProcessTransport = {
    directory: createDirectory(capacity), identity: identities.buffer,
    slot: 0, pid, bindings: [], resources: [],
  };
  return reserveRecord(transport, pid, 0, job, pid, undefined, options.foreground ?? true);
}
export function wakeWorkerProcess(transport: WorkerProcessTransport, _slot = transport.slot): void { wakeDirectory(transport.directory); }
/** Publish only after resource revocation, descriptor release and the host teardown fence. */
export const confirmWorkerProcessJob = confirmDirectoryProcess;
export function workerProcessSlots(transport: WorkerProcessTransport): number[] { return directorySlots(transport.directory); }

export interface WorkerSpawnTransfer {
  data?: unknown;
  codec?: WorkerDescriptorCodec;
  /** Commit runs after the request is published, while a filesystem admission fence is held. */
  commit?(): void;
  /** Cancel synchronous reservations without releasing the admission fence. */
  cancel?(): void;
  /** Release the fence only after publication or failed-reservation confirmation. */
  release?(): void;
}
export interface WorkerProcessClientOptions {
  transport: WorkerProcessTransport;
  descriptors: DescriptorTable;
  postMessage(message: WorkerProcessMessage): void;
  codec: WorkerDescriptorCodec;
  prepareSpawn?(pid: number): WorkerSpawnTransfer;
  /** Synchronously freeze shared endpoint cursors after default signal death is selected.
   * A shared pipe publication registry supplies this hook without entering the guest worker.
   */
  revokeProcess?(pid: number, transport: WorkerProcessTransport): void;
  createPipe?(): readonly [Stream, Stream];
  onError?(error: unknown): void;
}
/** Synchronous guest-side process service; only notifications cross the message boundary. */
export class WorkerProcessClient {
  readonly pid: number;
  readonly job: number;
  readonly signals: SignalTransport;
  readonly wake: Int32Array;
  private readonly identities: ProcessIdentityAllocator;
  private accesses?: Map<number, Int32Array>;
  private nextAccess = 1;
  constructor(readonly options: WorkerProcessClientOptions) {
    const state = workerProcessState(options.transport);
    this.pid = state.pid; this.job = state.job; this.signals = state.signals; this.wake = state.wake;
    this.identities = new ProcessIdentityAllocator(options.transport.identity);
  }
  installBindings(): void { installWorkerBindings(this.options.transport, this.options.descriptors, this.options.codec); }
  private admit(): void {
    if (readOutcome(this.signals.outcome)) {
      this.retireAccesses();
      throw new ProcessError(ProcessErrno.SRCH, "process has exited");
    }
  }
  accessStart(pid: number, path: string, cwd: string): number {
    this.admit();
    if (pid !== this.pid) throw new ProcessError(ProcessErrno.SRCH, "invalid querying process");
    if (!path || path.includes("\0") || !cwd.startsWith("/") || cwd.includes("\0")) throw new ProcessError(ProcessErrno.INVAL, "invalid executable query");
    if ((this.accesses?.size ?? 0) >= MAX_ACCESS_REQUESTS || this.nextAccess > 0x7fffffff) return -ProcessErrno.AGAIN;
    const id = this.nextAccess++, cells = new Int32Array(new SharedArrayBuffer(8));
    (this.accesses ??= new Map()).set(id, cells);
    try {
      this.options.postMessage({ type: "runtime-proc", operation: "access", transport: this.options.transport,
        request: { id, completion: cells.buffer as SharedArrayBuffer }, path, cwd });
    } catch (error) { Atomics.store(cells, 0, 2); this.accesses.delete(id); throw error; }
    return id;
  }
  private access(pid: number, id: number): Int32Array {
    this.admit();
    if (pid !== this.pid) throw new ProcessError(ProcessErrno.SRCH, "invalid querying process");
    const cells = this.accesses?.get(id);
    if (!cells || Atomics.load(cells, 0) === 2) {
      this.accesses?.delete(id);
      throw new ProcessError(ProcessErrno.BADF, "unknown executable query");
    }
    return cells;
  }
  accessReady(pid: number, id: number): boolean { return Atomics.load(this.access(pid, id), 0) === 1; }
  accessTake(pid: number, id: number): number {
    const cells = this.access(pid, id);
    if (Atomics.load(cells, 0) === 0) return -ProcessErrno.AGAIN;
    Atomics.store(cells, 0, 2);
    this.accesses!.delete(id);
    return Atomics.load(cells, 1);
  }
  accessCancel(pid: number, id: number): number {
    const cells = this.access(pid, id);
    Atomics.store(cells, 0, 2);
    this.accesses!.delete(id);
    this.options.postMessage({ type: "runtime-proc", operation: "access-cancel", transport: this.options.transport,
      request: { id, completion: cells.buffer as SharedArrayBuffer } });
    return 0;
  }
  private retireAccesses(): void {
    if (!this.accesses?.size) return;
    for (const cells of this.accesses.values()) Atomics.store(cells, 0, 2);
    this.accesses.clear();
  }
  spawn(parentPid: number, request: SpawnRequest): number {
    try { return this.reserveSpawn(parentPid, request); }
    catch (error) { throw spawnError(error); }
  }
  private reserveSpawn(parentPid: number, request: SpawnRequest): number {
    this.admit();
    if (parentPid !== this.pid) throw new ProcessError(ProcessErrno.SRCH, "invalid spawning process");
    const fds = new Set<number>();
    const sources = request.fds.map(binding => {
      if (!Number.isInteger(binding.child) || binding.child < 0 || binding.child > MAX_DESCRIPTOR || !Number.isInteger(binding.parent) || binding.parent < 0 || binding.parent > MAX_DESCRIPTOR || fds.has(binding.child)) throw new ProcessError(ProcessErrno.INVAL, "invalid descriptor binding");
      fds.add(binding.child);
      const source = this.options.descriptors.get(binding.parent);
      if (!source) throw new ProcessError(ProcessErrno.BADF, "missing inherited descriptor");
      return source;
    });
    if (!Number.isInteger(request.job) || request.job < -1) throw new ProcessError(ProcessErrno.INVAL, "invalid job selection");
    const job = request.job > 0 ? request.job : this.identities.job();
    const existingJob = findDirectoryJob(this.options.transport.directory, job);
    if (request.job > 0 && !existingJob) throw new ProcessError(this.identities.hasJob(job) ? ProcessErrno.CHILD : ProcessErrno.SRCH, "unknown or collected job");
    const pid = this.identities.pid();
    const references = new Map<OpenDescription, number>();
    let child: WorkerProcessTransport | undefined;
    let transfer: WorkerSpawnTransfer | undefined;
    let codec = this.options.codec;
    try {
      // Acquire the host admission fence before touching shared membership. Fatal
      // teardown must not stop this worker with an anonymous outstanding reservation.
      transfer = this.options.prepareSpawn?.(pid);
      codec = transfer?.codec ?? codec;
      child = reserveRecord(this.options.transport, pid, this.pid, job, existingJob?.ownerPid ?? this.pid, existingJob?.slot, request.job === 0);
      child.data = transfer?.data;
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i]!;
        let reference = references.get(source.description);
        if (reference === undefined) {
          reference = child.resources.length;
          child.resources.push(codec.export(source, pid));
          references.set(source.description, reference);
        }
        child.bindings.push({ fd: request.fds[i]!.child, reference, rightsBase: source.rightsBase, rightsInheriting: source.rightsInheriting });
      }
      // The worker may immediately mutate the original request or close its source fds.
      const snapshot: SpawnRequest = { ...request, argv: request.argv.slice(), env: { ...request.env }, fds: request.fds.map(binding => ({ ...binding })) };
      this.admit();
      this.options.postMessage({ type: "runtime-proc", operation: "spawn", transport: child, request: snapshot });
    } catch (error) {
      let cleaned = true;
      let state: ReturnType<typeof workerProcessState> | undefined;
      try {
        if (child) {
          state = workerProcessState(child);
          claimOutcome(state.signals.outcome, startFailure(error));
        }
        for (const token of child?.resources ?? []) {
          try { codec.discard(token); } catch (cleanupError) { cleaned = false; this.report(cleanupError); }
        }
        try { transfer?.cancel?.(); } catch (cleanupError) { cleaned = false; this.report(cleanupError); }
        if (child && state && cleaned) {
          controlStore(state.confirmed, 0, 1);
          confirmWorkerProcessJob(child);
        }
      } finally { transfer?.release?.(); }
      if (child && state && cleaned) {
        // Confirmation may orphan-collect this child when its parent died during export.
        // Keep its independently captured job authority, not a fresh process-row lookup.
        try { collectDirectoryProcess(child); }
        catch (cleanupError) { if (!isCollectedProcess(cleanupError)) throw cleanupError; }
        // A reentrant exporter may have admitted another member; a release callback may
        // instead have collected/reused the job. Never adopt that replacement's identity.
        try { if (controlLoad(state.jobPending) === 0) collectDirectoryJob(child.directory, state.jobSlot, state.job); }
        catch (cleanupError) { if (!isCollectedProcess(cleanupError)) throw cleanupError; }
      }
      throw error;
    }
    // Publication transferred ownership. Never discard published resources if a host
    // commit fails; release the admission fence after the complete handoff either way.
    try { transfer?.commit?.(); } catch (error) { this.report(error); }
    finally { try { transfer?.release?.(); } catch (error) { this.report(error); } }
    return pid;
  }
  private find(pid: number, retained = false) {
    for (const state of directoryProcesses(this.options.transport.directory)) {
      if (state.pid !== pid) continue;
      try { if (retained || controlLoad(state.jobPending, 0) >= 0) return state; }
      catch (error) { if (!isCollectedProcess(error)) throw error; }
    }
    throw new ProcessError(ProcessErrno.SRCH, `unknown process ${pid}`);
  }
  private child(parentPid: number, pid: number) {
    let target: ReturnType<WorkerProcessClient["find"]>;
    try { target = this.find(pid, true); } catch { throw new ProcessError(ProcessErrno.CHILD, "not a retained child process"); }
    if (parentPid !== this.pid || target.parentPid !== this.pid || controlLoad(target.jobPending, 0) < 0) throw new ProcessError(ProcessErrno.CHILD, "not a child process");
    return target;
  }
  /** Publish entry before guest execution, without a message round trip. */
  started(): boolean {
    const committed = markStarted(this.signals.outcome);
    if (committed) wakeWorkerProcess(this.options.transport);
    return committed;
  }
  startStatus(parentPid: number, pid: number): number {
    try { return startStatus(this.child(parentPid, pid).signals.outcome); }
    catch (error) {
      if (isCollectedProcess(error)) throw new ProcessError(ProcessErrno.CHILD, "not a retained child process");
      throw error;
    }
  }
  /** Readiness never consumes the exit or releases a zombie's storage. */
  childExited(parentPid: number, pid: number): boolean {
    const target = this.child(parentPid, pid);
    return controlLoad(target.confirmed) !== 0 && controlLoad(target.jobConfirmed) !== 0;
  }
  wait(parentPid: number, pid: number): ProcessExit | null {
    const target = this.child(parentPid, pid);
    if (!controlLoad(target.confirmed) || !controlLoad(target.jobConfirmed)) return null;
    const result = collectDirectoryProcess({ directory: this.options.transport.directory, slot: target.slot, pid });
    this.options.postMessage({ type: "runtime-proc", operation: "reap-process", transport: this.options.transport });
    return result;
  }
  private requireJob(callerPid: number, job: number) {
    this.admit();
    const group = findDirectoryJob(this.options.transport.directory, job);
    if (!group) throw new ProcessError(this.identities.hasJob(job) ? ProcessErrno.CHILD : ProcessErrno.SRCH, `unknown or collected job ${job}`);
    try {
      if (callerPid === this.pid && directoryControls(this.options.transport.directory, () => controlLoad(group.controlParent), callerPid)) return group;
    } catch (error) {
      if (isCollectedProcess(error)) throw new ProcessError(ProcessErrno.CHILD, `job ${job} has been collected`);
      throw error;
    }
    throw new ProcessError(63, `job ${job} is outside the caller's owner chain`);
  }
  private jobIsEmpty(group: ReturnType<typeof directoryJob>): boolean {
    try {
      const pending = controlLoad(group.pending);
      if (pending < 0) throw new ProcessError(ProcessErrno.CHILD, `job ${group.id} has been collected`);
      return pending === 0;
    } catch (error) {
      if (isCollectedProcess(error)) throw new ProcessError(ProcessErrno.CHILD, `job ${group.id} has been collected`);
      throw error;
    }
  }
  jobEmpty(callerPid: number, job: number): boolean { return this.jobIsEmpty(this.requireJob(callerPid, job)); }
  waitJob(callerPid: number, job: number): ProcessExit | null {
    const group = this.requireJob(callerPid, job);
    if (!this.jobIsEmpty(group)) return null;
    const result = collectDirectoryJob(this.options.transport.directory, group.slot, job);
    this.options.postMessage({ type: "runtime-proc", operation: "reap-job", transport: this.options.transport, job });
    return result;
  }
  jobOf(pid: number): number { return this.find(pid).job; }
  canSignal(callerPid: number, pid: number): boolean {
    if (callerPid !== this.pid) return false;
    const target = this.find(pid);
    return directoryControls(this.options.transport.directory, () => {
      // Keep the target incarnation captured even if another collector reuses its slot.
      controlLoad(target.controlParent);
      return target.pid;
    }, callerPid);
  }
  canSignalJob(callerPid: number, job: number): boolean {
    if (callerPid !== this.pid) return false;
    try { const group = this.requireJob(callerPid, job); return directoryControls(this.options.transport.directory, () => controlLoad(group.controlParent), this.pid, true); }
    catch (error) { if (error instanceof ProcessError && error.errno === 63) return false; throw error; }
  }
  kill(pid: number, signal: number): void {
    if (!this.canSignal(this.pid, pid)) throw new ProcessError(63, "process is outside the caller's ancestry");
    this.deliver([this.find(pid)], checkedSignal(signal));
  }
  killJob(job: number, signal: number): void {
    if (!this.canSignalJob(this.pid, job)) throw new ProcessError(63, "job is not owned by the caller");
    const targets = Array.from(directoryProcesses(this.options.transport.directory)).filter(state => state.job === job);
    this.deliver(targets, checkedSignal(signal), true);
  }
  private deliver(targets: { slot: number; pid: number; parentPid: number; signals: SignalTransport }[], signal: number, collective = false): void {
    this.admit();
    for (const target of targets) {
      try { requestSignal(target.signals, signal); }
      catch (error) { if (!collective || !isCollectedProcess(error)) throw error; }
    }
    // Select every target before resource callbacks, then freeze all canonical cursors before
    // returning to the guest. A concurrently collected member cannot stop the remaining job.
    for (const target of targets) {
      try {
        if (readOutcome(target.signals.outcome)?.kind === "signaled") this.options.revokeProcess?.(target.pid, this.options.transport);
      } catch (error) { if (!collective || !isCollectedProcess(error)) throw error; }
    }
    // Every member and parent observes this one directory-wide sequence, not slot-local wakes.
    wakeWorkerProcess(this.options.transport);
    this.options.postMessage({ type: "runtime-proc", operation: "signal", transport: this.options.transport, targets: targets.map(target => target.pid) });
  }
  defaultSignal(pid: number, signal: number): void {
    if (pid !== this.pid) throw new ProcessError(ProcessErrno.SRCH, "invalid default signal process");
    checkedSignal(signal);
    const settled = readOutcome(this.signals.outcome);
    const killed = controlLoad(this.signals.requestedSignal, 0) === 9;
    if (!settled && !killed && !defaultSignalTerminates(signal)) return;
    const winner = claimOutcome(this.signals.outcome, { kind: "signaled", code: controlLoad(this.signals.requestedSignal, 0) === 9 ? 9 : signal });
    this.retireAccesses();
    if (winner.kind === "signaled") this.options.revokeProcess?.(pid, this.options.transport);
    wakeWorkerProcess(this.options.transport);
    this.options.postMessage({ type: "runtime-proc", operation: "exit", transport: this.options.transport, targets: [pid] });
  }
  exit(code: number): void {
    claimOutcome(this.signals.outcome, { kind: "exited", code });
    this.retireAccesses();
    wakeWorkerProcess(this.options.transport);
    this.options.postMessage({ type: "runtime-proc", operation: "exit", transport: this.options.transport, targets: [this.pid] });
  }
  createPipe(): readonly [Stream, Stream] {
    if (!this.options.createPipe) throw new ProcessError(58, "worker pipe factory is unavailable");
    return this.options.createPipe();
  }
  private report(error: unknown): void { try { this.options.onError?.(error); } catch { /* Diagnostics never own cleanup. */ } }
}

/** Validate every child binding before importing or replacing a descriptor. */
function validateWorkerBindings(transport: WorkerProcessTransport): void {
  const targets = new Set<number>();
  for (const binding of transport.bindings) {
    if (!Number.isInteger(binding.fd) || binding.fd < 0 || binding.fd > MAX_DESCRIPTOR || targets.has(binding.fd)) {
      throw new ProcessError(ProcessErrno.INVAL, "invalid descriptor binding");
    }
    targets.add(binding.fd);
    if (!Number.isInteger(binding.reference) || binding.reference < 0 || binding.reference >= transport.resources.length) {
      throw new TypeError("invalid transferred descriptor reference");
    }
  }
}

/** Group duplicate bindings by open description, retaining exactly one transferred lifetime. */
export function installWorkerBindings(transport: WorkerProcessTransport, descriptors: DescriptorTable, codec: WorkerDescriptorCodec): void {
  validateWorkerBindings(transport);
  const imported = new Map<number, { description: OpenDescription; resource: Resource }>();
  const staged = new DescriptorTable();
  const previous = new Map<number, Descriptor | undefined>();
  const held: OpenDescription[] = [];
  const installed: number[] = [];
  let failed = false;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  const cleanup = (action: () => void) => { try { action(); } catch (error) { cleanupErrors.push(error); } };

  // Import every token before changing the descriptor table. A malformed later token must not
  // leave an earlier inherited descriptor live while the worker reports its typed startup error.
  try {
    for (const binding of transport.bindings) {
      let source = imported.get(binding.reference);
      if (!source) {
        const description = codec.import(transport.resources[binding.reference], workerProcessState(transport).pid);
        staged.add(description, { rightsBase: binding.rightsBase, rightsInheriting: binding.rightsInheriting });
        source = { description, resource: description.resource };
        imported.set(binding.reference, source);
      }
    }

    // Hold replaced descriptions until the transaction commits. This makes rollback safe even
    // when an inherited fd aliases an existing stdio or preopen descriptor.
    for (const binding of transport.bindings) {
      const entry = descriptors.get(binding.fd);
      previous.set(binding.fd, entry);
      if (entry) { entry.description.retain(); held.push(entry.description); }
    }
    for (const binding of transport.bindings) {
      const source = imported.get(binding.reference)!;
      descriptors.inherit(binding.fd, { ...source, rightsBase: binding.rightsBase, rightsInheriting: binding.rightsInheriting });
      installed.push(binding.fd);
    }
  } catch (error) {
    failed = true;
    failure = error;
    for (const fd of installed.reverse()) {
      const entry = previous.get(fd);
      if (entry) cleanup(() => descriptors.restore(fd, entry));
      else cleanup(() => { descriptors.close(fd); });
    }
  }

  cleanup(() => staged.dispose());
  for (const description of held) cleanup(() => description.drop());
  // Preserve the exact import error for startup classification, including non-Error throws.
  // Teardown must still refuse a safe completion when any abandoned resource failed release.
  for (const error of cleanupErrors) descriptors.recordCleanupFailure(error);
  if (failed) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "inherited descriptor cleanup failed");
}
