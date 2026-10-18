import {
  Int32ArrayConstructor,
  SharedArrayBufferConstructor,
  atomicsAdd,
  atomicsLoad,
  atomicsNotify,
  atomicsWaitAsync,
} from "./intrinsics.ts";
import { WorkerExecutableAccess, rejectWorkerAccess } from "./worker-access.js";
import { startFailure } from "./start-failure.js";
import {
  collectDirectoryProcess,
  collectDirectoryJob,
  directoryProcesses,
  directoryGroups,
  findDirectoryJob,
  helpDirectoryJobs,
  isCollectedProcess,
} from "./directory.js";
import { controlLoad, controlStore } from "./control.js";
import { DescriptorTable, type Resource } from "../core/descriptors.js";
import { claimOutcome, readOutcome } from "./outcome.js";
import {
  reportProcessAdmission,
  type ProcessAdmissionEvent,
  type ProcessAdmissionObserver,
} from "./admission.js";
import { requestSignal } from "./signals.js";
import type { ProcessSupervisor } from "./supervisor.js";
import { ProcessErrno, ProcessError } from "./types.js";
import {
  confirmWorkerProcessJob,
  installWorkerBindings,
  wakeWorkerProcess,
  workerProcessDirectoryId,
  workerProcessState,
  type WorkerDescriptorCodec,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "./worker-client.js";

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
  private readonly rejectedCleanup = new Map<
    number,
    { resourcesReleased: boolean; fenced: boolean }
  >();
  private acknowledgingJob?: number;
  private supervisor?: ProcessSupervisor;
  private activation?: Promise<ProcessSupervisor>;
  private stopListening?: () => void;
  private disposed = false;
  // Preserve admission ordering while the optional supervisor chunk is still loading.
  private admission: Promise<void> = Promise.resolve();
  private readonly accesses = new WorkerExecutableAccess({
    active: (sender) => !this.disposed && this.get(sender.pid) !== undefined,
    check: async (sender, path, cwd, active, onCancel) => {
      const supervisor = await this.ready();
      active();
      const wake = new Int32ArrayConstructor(new SharedArrayBufferConstructor(4));
      const id = supervisor.accessStart(sender.pid, path, cwd, wake);
      if (id < 0) return id;
      let cancelled = false,
        retired = false;
      const stop = supervisor.registerRevocation(sender.pid, () =>
        this.accesses.revoke(sender.pid, workerProcessDirectoryId(sender)),
      );
      const retire = () => {
        if (retired) return;
        retired = true;
        try {
          supervisor.accessCancel(sender.pid, id);
        } catch (error) {
          if (
            !(error instanceof ProcessError) ||
            (error.errno !== ProcessErrno.SRCH && error.errno !== ProcessErrno.BADF)
          )
            throw error;
        } finally {
          atomicsAdd(wake, 0, 1);
          atomicsNotify(wake, 0);
        }
      };
      onCancel(() => {
        cancelled = true;
        retire();
      });
      try {
        for (;;) {
          const expected = atomicsLoad(wake, 0);
          if (cancelled) return -ProcessErrno.BADF;
          active();
          if (supervisor.accessReady(sender.pid, id)) {
            const result = supervisor.accessTake(sender.pid, id);
            retired = true;
            return result;
          }
          // No timeout: completion, cancellation and revocation all notify this word.
          await atomicsWaitAsync(wake, 0, expected).value;
        }
      } finally {
        stop();
        retire();
      }
    },
  });
  constructor(private readonly options: WorkerProcessBrokerOptions) {}
  adoptRoot(transport: WorkerProcessTransport): void {
    const state = workerProcessState(transport);
    if (state.parentPid !== 0) throw new TypeError("root process has a parent");
    const existing = this.get(state.pid);
    if (existing && workerProcessDirectoryId(existing) !== workerProcessDirectoryId(transport))
      throw new TypeError("process identity is already registered");
    this.transports.set(state.pid, transport);
    this.directories.set(workerProcessDirectoryId(transport), transport);
  }
  /** Drop one completed root directory only after all descendant consumers and jobs retire. */
  releaseRoot(pid: number): void {
    const root = this.get(pid);
    if (!root) return;
    const state = workerProcessState(root);
    let outstanding = state.parentPid !== 0 || controlLoad(state.confirmed, 0) === 0;
    for (const group of directoryGroups(root.directory))
      if (group.id !== state.job) outstanding = true;
    for (const child of directoryProcesses(root.directory)) {
      try {
        if (
          child.job !== state.job ||
          (child.pid !== pid &&
            (controlLoad(child.confirmed, 0) === 0 || this.supervisor?.get(child.pid)))
        )
          outstanding = true;
      } catch (error) {
        if (!isCollectedProcess(error)) throw error;
      }
    }
    if (outstanding) throw new Error("Root directory still has unconfirmed or unreaped processes");
    const directory = workerProcessDirectoryId(root);
    const ownJob = this.sharedJob(state.job);
    if (ownJob && controlLoad(ownJob.group.pending) === 0)
      collectDirectoryJob(root.directory, ownJob.group.slot, state.job);
    for (const [member, transport] of this.transports) {
      if (workerProcessDirectoryId(transport) !== directory) continue;
      this.transports.delete(member);
      this.failedCleanup.delete(member);
    }
    this.directories.delete(directory);
  }
  get(pid: number): WorkerProcessTransport | undefined {
    return this.transports.get(pid);
  }
  getIdentity(pid: number): WorkerProcessTransport | undefined {
    return this.get(pid);
  }
  private sharedJob(job: number) {
    for (const root of this.directories.values()) {
      const group = findDirectoryJob(root.directory, job);
      if (group) return { root, group };
    }
    return undefined;
  }
  private reapTransports(job: number): void {
    const shared = this.sharedJob(job);
    if (shared && controlLoad(shared.group.pending) === 0)
      collectDirectoryJob(shared.root.directory, shared.group.slot, job);
    for (const [pid, transport] of this.transports) {
      try {
        if (workerProcessState(transport).job !== job) continue;
      } catch (error) {
        if (!(error instanceof ProcessError)) throw error;
      }
      this.transports.delete(pid);
      this.failedCleanup.delete(pid);
    }
  }
  private codec(transport: WorkerProcessTransport): WorkerDescriptorCodec {
    return typeof this.options.codec === "function"
      ? this.options.codec(transport)
      : this.options.codec;
  }
  private ready(): Promise<ProcessSupervisor> {
    return (this.activation ??= this.options.supervisor().then((supervisor) => {
      this.supervisor = supervisor;
      if (!this.disposed) {
        const stopQuiescent = supervisor.onProcessQuiescent((event) => {
          if (this.disposed) return;
          const transport = this.transports.get(event.pid);
          if (transport && !this.failedCleanup.has(event.pid)) {
            confirmWorkerProcessJob(transport);
            // Disposal may have removed the host process record while its asynchronous
            // fence was pending. Honor that retirement after safe shared confirmation.
            if (!supervisor.get(event.pid)) {
              try {
                collectDirectoryProcess(transport);
              } catch (error) {
                if (
                  !(error instanceof ProcessError) ||
                  (error.errno !== ProcessErrno.SRCH && error.errno !== ProcessErrno.CHILD)
                )
                  throw error;
              }
              this.transports.delete(event.pid);
              this.failedCleanup.delete(event.pid);
            }
          }
        });
        const stopReadiness = supervisor.registerJobReadiness((job) => {
          const shared = this.sharedJob(job);
          if (!shared) {
            if (supervisor.table.jobClaimed(job) && this.acknowledgingJob !== job)
              throw new ProcessError(ProcessErrno.CHILD, "job was already collected");
            return true;
          }
          const pending = controlLoad(shared.group.pending);
          if (pending === -1 && this.acknowledgingJob !== job)
            throw new ProcessError(
              ProcessErrno.CHILD,
              "job was already reaped by another observer",
            );
          return pending === 0 || (pending === -1 && this.acknowledgingJob === job);
        });
        const stopClaim = supervisor.registerJobReapClaim((job) => {
          const shared = this.sharedJob(job);
          if (!shared) return this.acknowledgingJob === job || !supervisor.table.jobClaimed(job);
          if (controlLoad(shared.group.pending) !== 0) return false;
          collectDirectoryJob(shared.root.directory, shared.group.slot, job);
          return true;
        });
        const stopChildAccess = supervisor.registerChildAccess((pid, consume) => {
          const transport = this.transports.get(pid);
          if (!transport) return true;
          try {
            if (consume) collectDirectoryProcess(transport);
            else workerProcessState(transport);
            return true;
          } catch (error) {
            if (!isCollectedProcess(error)) throw error;
            return false;
          }
        });
        const stopRemove = supervisor.table.onRemove((record) => {
          const transport = this.transports.get(record.pid);
          if (!transport || !record.result) return;
          try {
            collectDirectoryProcess(transport);
          } catch (error) {
            if (
              !(error instanceof ProcessError) ||
              (error.errno !== ProcessErrno.SRCH &&
                error.errno !== ProcessErrno.CHILD &&
                error.errno !== ProcessErrno.AGAIN)
            )
              throw error;
            if (error.errno === ProcessErrno.AGAIN) return;
          }
          this.transports.delete(record.pid);
          this.failedCleanup.delete(record.pid);
        });
        const stopReap = supervisor.onJobReap((job) => this.reapTransports(job));
        this.stopListening = () => {
          stopQuiescent();
          stopReadiness();
          stopClaim();
          stopChildAccess();
          stopReap();
          stopRemove();
        };
      }
      return supervisor;
    }));
  }
  handle(message: WorkerProcessMessage, senderPid?: number): Promise<void> {
    if (message.operation === "access" || message.operation === "access-cancel") {
      const sender = this.get(senderPid ?? message.transport.pid);
      let authenticated = false;
      try {
        authenticated =
          !!sender &&
          !this.disposed &&
          sender.pid === message.transport.pid &&
          workerProcessDirectoryId(sender) === workerProcessDirectoryId(message.transport) &&
          !readOutcome(workerProcessState(sender).signals.outcome) &&
          workerProcessState(message.transport).pid === sender.pid;
      } catch (error) {
        if (!isCollectedProcess(error)) throw error;
      }
      if (!authenticated) {
        rejectWorkerAccess(message);
        return Promise.resolve();
      }
      // Query completion must not hold the spawn admission queue, including while its
      // metadata lookup is deferred. Child notices wait only for parent admission.
      if (message.operation === "access-cancel") return this.accesses.handle(message, sender!);
      return this.admission.then(() => this.accesses.handle(message, sender!));
    }
    let state: ReturnType<typeof workerProcessState>;
    try {
      state = workerProcessState(message.transport);
    } catch {
      if (message.operation !== "reap-job" && message.operation !== "reap-process")
        return Promise.resolve();
      if (!this.directories.has(workerProcessDirectoryId(message.transport)))
        return Promise.resolve();
      state = { pid: message.transport.pid } as ReturnType<typeof workerProcessState>;
    }
    if (
      senderPid !== undefined &&
      (message.operation === "spawn" ? state.parentPid : state.pid) !== senderPid
    ) {
      if (message.operation === "spawn") this.trace(message.transport, "rejected", "wrong-sender");
      return Promise.reject(
        new ProcessError(ProcessErrno.SRCH, "process message has the wrong sender"),
      );
    }
    if (message.operation === "spawn") {
      this.trace(message.transport, "queued");
      const pending = this.admission.then(() => this.spawn(message.transport, message.request));
      this.admission = pending.catch((error) => {
        this.report(error);
      });
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
          if (
            !(error instanceof ProcessError) ||
            (error.errno !== ProcessErrno.SRCH && error.errno !== ProcessErrno.CHILD)
          )
            throw error;
        } finally {
          this.acknowledgingJob = previous;
        }
        this.reapTransports(message.job);
      }
    });
  }
  private async spawn(
    transport: WorkerProcessTransport,
    request: import("./types.js").SpawnRequest,
  ): Promise<void> {
    const state = workerProcessState(transport);
    // A repeated message owns no new references. Reject without discarding the retained
    // lifetimes already held by the first accepted process.
    if (this.get(state.pid)) {
      this.trace(transport, "dropped", "duplicate-process");
      throw new ProcessError(ProcessErrno.INVAL, "process identity is already registered");
    }
    let codec: WorkerDescriptorCodec | undefined;
    let admitted = false;
    let reason: ProcessAdmissionEvent["reason"] = "admission-failed";
    try {
      codec = this.codec(transport);
      if (this.disposed) {
        reason = "broker-disposed";
        throw new ProcessError(ProcessErrno.SRCH, "process broker is disposed");
      }
      const parentTransport =
        this.get(state.parentPid) ?? this.directories.get(workerProcessDirectoryId(transport));
      if (
        !parentTransport ||
        workerProcessDirectoryId(parentTransport) !== workerProcessDirectoryId(transport)
      ) {
        reason = parentTransport ? "directory-mismatch" : "unknown-parent";
        throw new ProcessError(ProcessErrno.SRCH, "unknown process parent");
      }
      reason = "activation-failed";
      const supervisor = await this.ready();
      if (this.disposed) {
        reason = "broker-disposed";
        throw new ProcessError(ProcessErrno.SRCH, "process broker is disposed");
      }
      // Reserve the authoritative leader/owner before a codec can fail. Transferred
      // endpoints belong to this child, not the parent's mutable or already-reaped table.
      this.transports.set(state.pid, transport);
      reason = "reservation-failed";
      supervisor.reserveAdmittedSpawn(
        state.parentPid,
        { ...request, fds: [] },
        {
          pid: state.pid,
          job: state.job,
          controlParent: controlLoad(state.controlParent),
          rootPid: state.rootPid,
          ...state.signals,
        },
        new DescriptorTable(),
        {
          ownerPid: state.jobOwner,
          controlParent: controlLoad(state.jobControlParent),
          leaderPid: state.jobLeaderPid,
          outcome: state.jobOutcome,
          foreground: state.jobForeground,
        },
      );
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
        if ((resource.kind === "pipe" || resource.kind === "terminal") && resource.revoke)
          supervisor.registerRevocation(state.pid, () => resource.revoke!());
      }
      // A kill may have won before lazy admission, including after the sender already exited.
      // start() adopts the shared decision and never launches an already-dead worker.
      if (this.options.onAdmission) {
        const selected = readOutcome(state.signals.outcome);
        const selectedReason = !selected
          ? undefined
          : selected.kind === "exited"
            ? "preselected-exit"
            : selected.kind === "signaled"
              ? "preselected-signal"
              : "preselected-start-failed";
        this.trace(transport, selected ? "skipped" : "starting", selectedReason);
      }
      void supervisor.start(state.pid).catch((error) => this.report(error));
      this.pump();
    } catch (error) {
      this.trace(transport, "rejected", reason);
      if (admitted) {
        // Imported descriptions release through the supervisor; discard also releases
        // tokens that failed before import, using the codec's idempotent lifetime.
        for (const token of transport.resources) {
          try {
            if (!codec) throw new Error("descriptor codec unavailable for rejected transfer");
            codec.discard(token);
          } catch (cleanupError) {
            this.failedCleanup.add(state.pid);
            this.report(cleanupError);
          }
        }
        this.supervisor!.failStart(state.pid, error);
      } else {
        // Retain cleanup ownership until every token and the host fence completes.
        this.transports.set(state.pid, transport);
        this.failedCleanup.add(state.pid);
        claimOutcome(state.signals.outcome, startFailure(error));
        const cleanup = { resourcesReleased: true, fenced: false };
        this.rejectedCleanup.set(state.pid, cleanup);
        for (const token of transport.resources) {
          try {
            if (!codec) throw new Error("descriptor codec unavailable for rejected transfer");
            codec.discard(token);
          } catch (cleanupError) {
            cleanup.resourcesReleased = false;
            this.report(cleanupError);
          }
        }
        await this.options.quiesce?.(state.pid, transport);
        cleanup.fenced = true;
        if (cleanup.resourcesReleased) {
          this.transports.delete(state.pid);
          this.failedCleanup.delete(state.pid);
          this.rejectedCleanup.delete(state.pid);
          confirmRejectedProcess(transport, cleanup);
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
    for (const root of this.directories.values()) helpDirectoryJobs(root.directory);
    for (const job of Array.from(supervisor.table.jobValues()))
      supervisor.reconcileCollectedJob(job.id);
    for (const [pid, transport] of this.transports) {
      const record = supervisor.get(pid);
      try {
        const state = workerProcessState(transport);
        if (!record || record.result) continue;
        const outcome = readOutcome(state.signals.outcome);
        if (outcome?.kind === "signaled") supervisor.defaultSignal(pid, outcome.code);
        else if (outcome?.kind === "start-failed")
          supervisor.failStart(pid, { code: outcome.error });
        else if (outcome) supervisor.exit(pid, outcome.code);
        else {
          const signal = controlLoad(state.signals.requestedSignal, 0);
          if (signal) supervisor.observeSignal(pid, signal);
        }
      } catch (error) {
        if (!isCollectedProcess(error)) throw error;
        if (record?.result) supervisor.table.remove(pid);
        if (!record || record.result) {
          this.transports.delete(pid);
          this.failedCleanup.delete(pid);
        }
      }
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.accesses.dispose();
    const cleanup = new Map<number, { complete: boolean }>();
    for (const [pid, transport] of this.transports) {
      const record = this.supervisor?.get(pid);
      if (!record) continue;
      const gate = { complete: !this.failedCleanup.has(pid) };
      cleanup.set(pid, gate);
      // Exit waiters resolve at the host-work fence even if the embedding immediately
      // disposes the supervisor and clears its event listeners. Retain shared identity
      // only, never descriptor tokens, adapter payloads, or the broker itself.
      const identity: WorkerProcessTransport = {
        directory: transport.directory,
        identity: transport.identity,
        slot: transport.slot,
        pid: transport.pid,
        bindings: [],
        resources: [],
      };
      try {
        confirmDisposedProcess(
          this.supervisor!.waitForExit(record.parentPid, pid),
          identity,
          gate,
          this.options.onError,
        );
      } catch (error) {
        if (!isCollectedProcess(error)) throw error;
      }
    }
    for (const transport of this.transports.values()) {
      try {
        requestSignal(workerProcessState(transport).signals, 9);
      } catch (error) {
        if (!(error instanceof ProcessError)) throw error;
      }
    }
    this.pump();
    for (const [pid, transport] of this.transports) {
      if (transport.resources.length === 0) {
        wakeWorkerProcess(transport);
        continue;
      }
      let codec: WorkerDescriptorCodec;
      try {
        codec = this.codec(transport);
      } catch (error) {
        const gate = cleanup.get(pid);
        if (gate) gate.complete = false;
        this.report(error);
        continue;
      }
      let released = true;
      for (const token of transport.resources) {
        try {
          codec.discard(token);
        } catch (error) {
          released = false;
          const gate = cleanup.get(pid);
          if (gate) gate.complete = false;
          this.report(error);
        }
      }
      const rejected = this.rejectedCleanup.get(pid);
      if (rejected) {
        rejected.resourcesReleased = released;
        confirmRejectedProcess(transport, rejected);
      }
      wakeWorkerProcess(transport);
    }
    this.rejectedCleanup.clear();
    this.transports.clear();
    this.directories.clear();
    this.failedCleanup.clear();
    this.stopListening?.();
    this.stopListening = undefined;
  }
  private trace(
    transport: WorkerProcessTransport,
    stage: ProcessAdmissionEvent["stage"],
    reason?: ProcessAdmissionEvent["reason"],
  ): void {
    if (this.options.onAdmission)
      reportProcessAdmission(
        this.options.onAdmission,
        workerProcessState(transport),
        stage,
        reason,
        workerProcessDirectoryId(transport),
      );
  }
  private report(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      /* Diagnostics never own cleanup. */
    }
  }
}

/** No closure here retains the broker, descriptor tokens, or adapter payloads through a fence. */
function confirmDisposedProcess(
  waiting: Promise<unknown>,
  identity: WorkerProcessTransport,
  gate: { complete: boolean },
  onError: WorkerProcessBrokerOptions["onError"],
): void {
  void waiting.then(() => {
    if (!gate.complete) return;
    try {
      confirmWorkerProcessJob(identity);
    } catch (error) {
      if (isCollectedProcess(error)) return;
      try {
        onError?.(error);
      } catch {
        /* Diagnostics do not own the fence. */
      }
    }
  });
}

/** Rejected spawns have no supervisor record; their own cleanup state owns confirmation. */
function confirmRejectedProcess(
  transport: WorkerProcessTransport,
  cleanup: { resourcesReleased: boolean; fenced: boolean },
): void {
  if (!cleanup.resourcesReleased || !cleanup.fenced) return;
  try {
    controlStore(workerProcessState(transport).confirmed, 0, 1);
    confirmWorkerProcessJob(transport);
  } catch (error) {
    if (!isCollectedProcess(error)) throw error;
  }
}
