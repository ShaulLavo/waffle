import { collectDirectoryProcess, collectDirectoryJob, directoryJobs, directoryJob } from "./directory.js";
import { type ControlCells, TaggedCells, controlLoad, controlStore, controlCas } from "./control.js";
import { DescriptorTable, type Resource } from "../core/descriptors.js";
import { claimOutcome, readOutcome } from "./outcome.js";
import { reportProcessAdmission, type ProcessAdmissionEvent, type ProcessAdmissionObserver } from "./admission.js";
import { requestSignal } from "./signals.js";
import type { ProcessSupervisor } from "./supervisor.js";
import { ProcessErrno, ProcessError } from "./types.js";
import { confirmWorkerProcessJob, installWorkerBindings, wakeWorkerProcess, workerProcessDirectoryId, workerProcessSlots, workerProcessState, type WorkerDescriptorCodec, type WorkerProcessMessage, type WorkerProcessTransport } from "./worker-client.js";

export interface WorkerProcessBrokerOptions {
  /** Reuse the host's supervisor and executable registry, including its legacy Bun children. */
  supervisor(): Promise<ProcessSupervisor>;
  codec: WorkerDescriptorCodec | ((transport: WorkerProcessTransport) => WorkerDescriptorCodec);
  /** Optional pipe layer hooks; the ownership transport has no dependency on pipe primitives. */
  onPipe?(handle: unknown, transport: WorkerProcessTransport): void;
  pumpPipes?(): void;
  /** Fence host work for an identity whose spawn failed before supervisor admission. */
  quiesce?(pid: number, transport: WorkerProcessTransport): void | Promise<void>;
  onError?(error: unknown): void;
  /** Transport admission only; the host owns adapter launch and startup-failure diagnostics. */
  onAdmission?: ProcessAdmissionObserver;
}

/** Page-side admission over an existing supervisor. The worker has already retained every
 * transferred resource before its spawn message is queued. No request waits for page reply.
 */
export class WorkerProcessBroker {
  private readonly transports = new Map<number, WorkerProcessTransport>();
  /** One root per active directory, not one tombstone per historical process. */
  private readonly directories = new Map<string, WorkerProcessTransport>();
  private readonly failedCleanup = new Set<number>();
  private acknowledgingJob?: number;
  private supervisor?: ProcessSupervisor;
  private activation?: Promise<ProcessSupervisor>;
  private stopListening?: () => void;
  private disposed = false;
  // Preserve admission ordering while the optional supervisor chunk is still loading.
  private admission: Promise<void> = Promise.resolve();
  constructor(private readonly options: WorkerProcessBrokerOptions) {}
  adoptRoot(transport: WorkerProcessTransport): void {
    const state = workerProcessState(transport);
    if (state.parentPid !== 0) throw new TypeError("root process has a parent");
    const existing = this.getIdentity(state.pid);
    if (existing && workerProcessDirectoryId(existing) !== workerProcessDirectoryId(transport)) throw new TypeError("process identity is already registered");
    this.transports.set(state.pid, transport);
    this.directories.set(workerProcessDirectoryId(transport), transport);
  }
  /** Drop one completed root directory only after all descendant consumers and jobs retire. */
  releaseRoot(pid: number): void {
    const root = this.getIdentity(pid);
    if (!root) return;
    const state = workerProcessState(root);
    if (state.parentPid !== 0 || controlLoad(state.confirmed, 0) === 0 || directoryJobs(root.directory).some(slot => directoryJob(root.directory, slot).id !== state.job) || workerProcessSlots(root).some(slot => {
      const child = workerProcessState(root, slot);
      return child.pid !== pid && (controlLoad(child.confirmed, 0) === 0 || this.supervisor?.get(child.pid) ||
        (child.job !== state.job && controlLoad(child.jobPending, 0) >= 0));
    })) throw new Error("Root directory still has unconfirmed or unreaped processes");
    const directory = workerProcessDirectoryId(root);
    const ownJob = this.sharedJob(state.job);
    if (ownJob && controlLoad(ownJob.group.pending) === 0) collectDirectoryJob(root.directory, ownJob.group.slot, state.job);
    for (const entries of [this.transports]) for (const [member, transport] of entries) {
      if (workerProcessDirectoryId(transport) !== directory) continue;
      entries.delete(member);
      this.failedCleanup.delete(member);
    }
    this.directories.delete(directory);
  }
  get(pid: number): WorkerProcessTransport | undefined { return this.transports.get(pid); }
  getIdentity(pid: number): WorkerProcessTransport | undefined { return this.transports.get(pid); }
  private sharedJob(job: number) {
    for (const root of this.directories.values()) for (const slot of directoryJobs(root.directory)) {
      const group = directoryJob(root.directory, slot);
      if (group.id === job) return { root, group };
    }
    return undefined;
  }
  private reapTransports(job: number): void {
    const shared = this.sharedJob(job);
    if (shared && controlLoad(shared.group.pending) === 0) collectDirectoryJob(shared.root.directory, shared.group.slot, job);
    for (const [pid, transport] of this.transports) {
      try { if (workerProcessState(transport).job !== job) continue; }
      catch (error) { if (!(error instanceof ProcessError)) throw error; }
      this.transports.delete(pid);
      this.failedCleanup.delete(pid);
    }
  }
  private codec(transport: WorkerProcessTransport): WorkerDescriptorCodec {
    return typeof this.options.codec === "function" ? this.options.codec(transport) : this.options.codec;
  }
  private ready(): Promise<ProcessSupervisor> {
    return this.activation ??= this.options.supervisor().then(supervisor => {
      this.supervisor = supervisor;
      if (!this.disposed) {
        const stopExit = supervisor.onChildExit(event => {
          if (this.disposed) return;
          const transport = this.transports.get(event.pid);
          // The supervisor publishes exit only after revocation, descriptor cleanup and
          // its asynchronous host-work fence; process and job waits share that boundary.
          if (transport && !this.failedCleanup.has(event.pid)) { controlStore(workerProcessState(transport).confirmed, 0, 1); wakeWorkerProcess(transport); }
        });
        const stopQuiescent = supervisor.onProcessQuiescent(event => {
          if (this.disposed) return;
          const transport = this.transports.get(event.pid);
          if (transport && !this.failedCleanup.has(event.pid)) {
            confirmWorkerProcessJob(transport);
            // An exit observer may already have consumed the host process record before
            // this final job fence. Honor that collection after safe confirmation.
            if (!supervisor.get(event.pid)) {
              try { collectDirectoryProcess(transport); }
              catch (error) { if (!(error instanceof ProcessError) || error.errno !== ProcessErrno.SRCH && error.errno !== ProcessErrno.CHILD) throw error; }
              this.transports.delete(event.pid);
              this.failedCleanup.delete(event.pid);
            }
          }
        });
        const stopReadiness = supervisor.registerJobReadiness(job => {
          const shared = this.sharedJob(job);
          if (!shared) {
            if (supervisor.table.jobClaimed(job) && this.acknowledgingJob !== job) throw new ProcessError(ProcessErrno.CHILD, "job was already collected");
            return true;
          }
          const pending = controlLoad(shared.group.pending);
          if (pending === -1 && this.acknowledgingJob !== job) throw new ProcessError(ProcessErrno.CHILD, "job was already reaped by another observer");
          return pending === 0 || (pending === -1 && this.acknowledgingJob === job);
        });
        const stopClaim = supervisor.registerJobReapClaim(job => {
          const shared = this.sharedJob(job);
          if (!shared) return this.acknowledgingJob === job || !supervisor.table.jobClaimed(job);
          if (controlLoad(shared.group.pending) !== 0) return false;
          collectDirectoryJob(shared.root.directory, shared.group.slot, job);
          return true;
        });
        const stopRemove = supervisor.table.onRemove(record => {
          const transport = this.transports.get(record.pid);
          if (!transport || !record.result) return;
          try { collectDirectoryProcess(transport); } catch (error) {
            if (!(error instanceof ProcessError) || (error.errno !== ProcessErrno.SRCH && error.errno !== ProcessErrno.CHILD && error.errno !== ProcessErrno.AGAIN)) throw error;
            if (error.errno === ProcessErrno.AGAIN) return;
          }
          this.transports.delete(record.pid);
          this.failedCleanup.delete(record.pid);
        });
        const stopReap = supervisor.onJobReap(job => this.reapTransports(job));
        this.stopListening = () => { stopExit(); stopQuiescent(); stopReadiness(); stopClaim(); stopReap(); stopRemove(); };
      }
      return supervisor;
    });
  }
  handle(message: WorkerProcessMessage, senderPid?: number): Promise<void> {
    let state: ReturnType<typeof workerProcessState>;
    try { state = workerProcessState(message.transport); }
    catch (error) {
      if (message.operation !== "reap-job") return Promise.resolve();
      if (!this.directories.has(workerProcessDirectoryId(message.transport))) return Promise.resolve();
      state = { pid: message.transport.pid } as ReturnType<typeof workerProcessState>;
    }
    if (senderPid !== undefined && (message.operation === "spawn" ? state.parentPid : state.pid) !== senderPid) {
      if (message.operation === "spawn") this.trace(message.transport, "rejected", "wrong-sender");
      return Promise.reject(new ProcessError(ProcessErrno.SRCH, "process message has the wrong sender"));
    }
    if (message.operation === "spawn") {
      this.trace(message.transport, "queued");
      const pending = this.admission.then(() => this.spawn(message.transport, message.request));
      this.admission = pending.catch(error => { this.report(error); });
      return pending;
    }
    if (message.operation === "pipe") {
      if (!this.disposed) this.options.onPipe?.(message.handle, message.transport);
      return Promise.resolve();
    }
    // The signal and immutable outcome were published synchronously in the directory. Never
    // request the signal again: a guest may have already consumed a handled delivery.
    return this.admission.then(async () => {
      if (this.disposed) return;
      const supervisor = await this.ready();
      this.pump();
      if (message.operation === "reap-job") {
        const previous = this.acknowledgingJob;
        this.acknowledgingJob = message.job;
        try {
          const job = supervisor.job(message.job);
          if (!job || this.sharedJob(message.job)) return;
          if (!supervisor.waitJob(job.controlParent, message.job)) return;
        } catch (error) {
          // A wholly rejected transfer has only a shared directory record. A host-side
          // consumer may also have reaped first; neither notice should recreate a job.
          if (!(error instanceof ProcessError) || (error.errno !== ProcessErrno.SRCH && error.errno !== ProcessErrno.CHILD)) throw error;
        } finally { this.acknowledgingJob = previous; }
        this.reapTransports(message.job);
      }
    });
  }
  private async spawn(transport: WorkerProcessTransport, request: import("./types.js").SpawnRequest): Promise<void> {
    const state = workerProcessState(transport);
    // A repeated message owns no new references. Reject without discarding the retained
    // lifetimes already held by the first accepted process.
    if (this.getIdentity(state.pid)) {
      this.trace(transport, "dropped", "duplicate-process");
      throw new ProcessError(ProcessErrno.INVAL, "process identity is already registered");
    }
    let codec: WorkerDescriptorCodec;
    try { codec = this.codec(transport); }
    catch (error) { this.trace(transport, "rejected", "admission-failed"); throw error; }
    let admitted = false;
    let reason: ProcessAdmissionEvent["reason"] = "admission-failed";
    try {
      if (this.disposed) { reason = "broker-disposed"; throw new ProcessError(ProcessErrno.SRCH, "process broker is disposed"); }
      const parentTransport = this.getIdentity(state.parentPid) ?? this.directories.get(workerProcessDirectoryId(transport));
      if (!parentTransport || workerProcessDirectoryId(parentTransport) !== workerProcessDirectoryId(transport)) {
        reason = parentTransport ? "directory-mismatch" : "unknown-parent"; throw new ProcessError(ProcessErrno.SRCH, "unknown process parent");
      }
      reason = "activation-failed";
      const supervisor = await this.ready();
      if (this.disposed) { reason = "broker-disposed"; throw new ProcessError(ProcessErrno.SRCH, "process broker is disposed"); }
      // Reserve the authoritative leader/owner before a codec can fail. Transferred
      // endpoints belong to this child, not the parent's mutable or already-reaped table.
      this.transports.set(state.pid, transport);
      reason = "reservation-failed";
      supervisor.reserveAdmittedSpawn(state.parentPid, { ...request, fds: [] }, {
        pid: state.pid, job: state.job, controlParent: controlLoad(state.controlParent), rootPid: state.rootPid, ...state.signals,
      }, new DescriptorTable(), { ownerPid: state.jobOwner, controlParent: controlLoad(state.jobControlParent), leaderPid: state.jobLeaderPid, outcome: state.jobOutcome, foreground: state.jobForeground });
      admitted = true;
      this.trace(transport, "reserved");
      const descriptors = supervisor.get(state.pid)!.descriptors;
      reason = "binding-failed";
      installWorkerBindings(transport, descriptors, codec);
      this.trace(transport, "bound");
      const resources = new Set<Resource>();
      for (const binding of transport.bindings) {
        const resource = descriptors.get(binding.fd)!.resource;
        if (resources.has(resource)) continue;
        resources.add(resource);
        if ((resource.kind === "pipe" || resource.kind === "terminal") && resource.revoke) supervisor.registerRevocation(state.pid, () => resource.revoke!());
      }
      // A kill may have won before lazy admission, including after the sender already exited.
      // start() adopts the shared decision and never launches an already-dead worker.
      if (this.options.onAdmission) {
        const selected = readOutcome(state.signals.outcome);
        const selectedReason = !selected ? undefined : selected.kind === "exited" ? "preselected-exit"
          : selected.kind === "signaled" ? "preselected-signal" : "preselected-start-failed";
        this.trace(transport, selected ? "skipped" : "starting", selectedReason);
      }
      void supervisor.start(state.pid).catch(error => this.report(error));
      this.pump();
    } catch (error) {
      this.trace(transport, "rejected", reason);
      if (admitted) {
        // Imported descriptions release through the supervisor; discard also releases
        // tokens that failed before import, using the codec's idempotent lifetime.
        for (const token of transport.resources) {
          try { codec.discard(token); } catch (cleanupError) { this.failedCleanup.add(state.pid); this.report(cleanupError); }
        }
        this.supervisor!.failStart(state.pid, error);
      } else {
        this.transports.delete(state.pid);
        claimOutcome(state.signals.outcome, { kind: "start-failed", code: 13 });
        let cleaned = true;
        for (const token of transport.resources) {
          try { codec.discard(token); } catch (cleanupError) { cleaned = false; this.report(cleanupError); }
        }
        await this.options.quiesce?.(state.pid, transport);
        if (cleaned) {
          controlStore(state.confirmed, 0, 1);
          confirmWorkerProcessJob(transport);
        }
      }
      throw error;
    }
  }
  /** Deterministic host pump, also useful when the embedding owns a single relay loop. */
  pump(): void {
    this.options.pumpPipes?.();
    const supervisor = this.supervisor;
    if (!supervisor) return;
    for (const [pid, transport] of this.transports) {
      const record = supervisor.get(pid);
      if (!record || record.result) continue;
      let state: ReturnType<typeof workerProcessState>;
      try { state = workerProcessState(transport); } catch (error) {
        if (!(error instanceof ProcessError)) throw error;
        if (record.result) supervisor.table.remove(pid);
        continue;
      }
      const outcome = readOutcome(state.signals.outcome);
      if (outcome?.kind === "signaled") supervisor.defaultSignal(pid, outcome.code);
      else if (outcome?.kind === "start-failed") supervisor.failStart(pid, { code: outcome.error });
      else if (outcome) supervisor.exit(pid, outcome.code);
      else {
        const signal = controlLoad(state.signals.requestedSignal, 0);
        if (signal) supervisor.observeSignal(pid, signal);
      }
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const cleanup = new Map<number, { complete: boolean }>();
    for (const [pid, transport] of this.transports) {
      const record = this.supervisor?.get(pid);
      if (!record) continue;
      const gate = { complete: !this.failedCleanup.has(pid) };
      cleanup.set(pid, gate);
      // Exit waiters resolve at the host-work fence even if the embedding immediately
      // disposes the supervisor and clears its event listeners. Retain shared identity
      // only, never descriptor tokens, adapter payloads, or the broker itself.
      const identity: WorkerProcessTransport = { directory: transport.directory, identity: transport.identity, slot: transport.slot, pid: transport.pid, bindings: [], resources: [] };
      void this.supervisor!.waitForExit(record.parentPid, pid).then(() => {
        if (!gate.complete) return;
        try { confirmWorkerProcessJob(identity); } catch (error) { if (!(error instanceof ProcessError) || error.errno !== ProcessErrno.SRCH) this.report(error); }
      });
    }
    for (const transport of this.transports.values()) {
      try { requestSignal(workerProcessState(transport).signals, 9); } catch (error) { if (!(error instanceof ProcessError)) throw error; }
    }
    this.pump();
    for (const [pid, transport] of this.transports) {
      if (transport.resources.length === 0) { wakeWorkerProcess(transport); continue; }
      const codec = this.codec(transport);
      for (const token of transport.resources) {
        try { codec.discard(token); } catch (error) {
          const gate = cleanup.get(pid);
          if (gate) gate.complete = false;
          this.report(error);
        }
      }
      wakeWorkerProcess(transport);
    }
    this.transports.clear();
    this.directories.clear();
    this.failedCleanup.clear();
    this.stopListening?.(); this.stopListening = undefined;
  }
  private trace(transport: WorkerProcessTransport, stage: ProcessAdmissionEvent["stage"], reason?: ProcessAdmissionEvent["reason"]): void {
    if (this.options.onAdmission) reportProcessAdmission(this.options.onAdmission, workerProcessState(transport), stage, reason, workerProcessDirectoryId(transport));
  }
  private report(error: unknown): void { try { this.options.onError?.(error); } catch { /* Diagnostics never own cleanup. */ } }
}
