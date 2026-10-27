import {
  isInstance,
  isSharedArrayBuffer,
  isInt32Array,
  Int32ArrayConstructor,
  SharedArrayBufferConstructor,
  atomicsAdd,
  atomicsNotify,
  objectFreeze,
  typedArrayBuffer,
  typedArrayLength,
} from "./intrinsics.ts";
import { spawnError, startFailure } from "./start-failure.js";
import { executableAccessResult, MAX_ACCESS_REQUESTS } from "./access.js";
import { TaggedCells, type ControlCells, controlLoad } from "./control.js";
import {
  checkedSignalNumber,
  defaultSignalTerminates,
  createSignalState,
  requestSignal,
} from "./signals.js";
import {
  DescriptorTable,
  MAX_DESCRIPTOR,
  OpenDescription,
  type Descriptor,
} from "../core/descriptors.js";
import { ExecutableRegistry } from "./registry.js";
import { ProcessTable, type ProcessJob, type ProcessRecord } from "./table.js";
import {
  OutcomeCell,
  claimOutcome,
  outcomeWord,
  readOutcome,
  markStarted,
  startStatus,
} from "./outcome.js";
import {
  ProcessErrno,
  ProcessError,
  Signal,
  checkedSignal,
  checkedProcessCwd,
  type ChildExitEvent,
  type ProcessContext,
  type ProcessExit,
  type ProcessHandle,
  type SpawnRequest,
  type SpawnReservation,
  type SharedJobIdentity,
} from "./types.js";

function addWakeListener(
  registry: Map<number, Set<() => void>>,
  id: number,
  wake: Int32Array,
): () => void {
  let listeners = registry.get(id);
  if (!listeners) registry.set(id, (listeners = new Set()));
  const listener = () => {
    atomicsAdd(wake, 0, 1);
    atomicsNotify(wake, 0);
  };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) registry.delete(id);
  };
}

interface AccessRequest {
  result?: number;
  wake?: Int32Array;
}
interface ProcessAccesses {
  next: number;
  requests: Map<number, AccessRequest>;
}

export interface SupervisorOptions {
  registry: ExecutableRegistry;
  launch(context: ProcessContext): ProcessHandle | Promise<ProcessHandle>;
  /** Emit while inherited output is owned; an asynchronous sink must stop when active is false.
   * Disposal cancels this ownership even if a custom sink never settles its promise. */
  startFailed?(pid: number, error: unknown, active: () => boolean): void | Promise<void>;
  table?: ProcessTable;
  /** Message-bearing hosts defer exits and startup failures until ordered output/error messages drain.
   * Signals, host-selected executor failures and explicit disposal never wait for this acknowledgement.
   */
  canConfirmExit?(pid: number): boolean;
  /** Fence admitted filesystem and adapter work after revocation. Every exit confirmation
   * waits for this hook, but never for physical worker termination.
   */
  quiesce?(pid: number): void | Promise<void>;
  /** Cleanup failures are diagnostics, never a reason to leave peers blocked or skip teardown. */
  onError?(error: unknown): void;
}
export interface RootProcessOptions extends SpawnReservation {
  /** Initial root cwd; omitted roots explicitly start at /. */
  cwd?: string;
  descriptors?: DescriptorTable;
  foreground?: boolean;
}
function signalWord(source?: ControlCells | SharedArrayBuffer): ControlCells {
  const word = isInstance(source, TaggedCells)
    ? source
    : isInt32Array(source)
      ? source
      : new Int32ArrayConstructor(source ?? new SharedArrayBufferConstructor(4));
  if (
    !isSharedArrayBuffer(isInstance(word, TaggedCells) ? word.buffer : typedArrayBuffer(word)) ||
    (isInstance(word, TaggedCells) ? word.length : typedArrayLength(word)) !== 1
  )
    throw new TypeError("signal word must be one shared int32");
  return word;
}
function validFd(fd: number): boolean {
  return Number.isInteger(fd) && fd >= 0 && fd <= MAX_DESCRIPTOR;
}
function snapshot(spec: SpawnRequest): Readonly<SpawnRequest> {
  // Own all mutable request data before returning to the guest's synchronous spawn call.
  return {
    executable: spec.executable,
    argv: spec.argv.slice(),
    env: { ...spec.env },
    cwd: spec.cwd,
    job: spec.job,
    fds: spec.fds.map((binding) => ({ ...binding })),
  };
}

/** Responsive control plane. launch must hand execution to a worker, never run a guest inline. */
export class ProcessSupervisor {
  readonly table: ProcessTable;
  private readonly options: SupervisorOptions;
  private readonly listeners = new Set<(event: ChildExitEvent) => void>();
  private readonly jobReadiness = new Set<(job: number) => boolean>();
  private readonly jobReapListeners = new Set<(job: number) => void>();
  private readonly childAccess = new Set<(pid: number, consume: boolean) => boolean>();
  private readonly jobReapClaims = new Set<(job: number) => boolean>();
  private readonly quiescentListeners = new Set<(event: ChildExitEvent) => void>();
  private readonly jobListeners = new Map<number, Set<() => void>>();
  private readonly startListeners = new Map<number, Set<() => void>>();
  private disposed = false;
  private accesses?: Map<number, ProcessAccesses>;
  /** Retain revoked records and late handles if their safety fence rejects, even after disposal. */
  private readonly finishing = new Map<number, ProcessRecord>();
  private readonly startFailures = new WeakSet<ProcessRecord>();
  private readonly startupDrains = new Map<ProcessRecord, () => void>();
  constructor(options: SupervisorOptions) {
    this.options = options;
    this.table = options.table ?? new ProcessTable();
  }
  get(pid: number): ProcessRecord | undefined {
    return this.table.get(pid);
  }
  job(id: number) {
    return this.table.job(id);
  }
  jobOf(pid: number): number {
    return this.table.require(pid).job;
  }
  cwd(pid: number): string {
    return this.accessOwner(pid).cwd;
  }
  private accessOwner(pid: number): ProcessRecord {
    const record = this.table.get(pid);
    if (this.disposed || !record || record.revoked || readOutcome(record.outcome))
      throw new ProcessError(ProcessErrno.SRCH, "querying process has exited");
    return record;
  }
  /** Submission owns only metadata, never descriptors, workers or compiled modules. */
  accessStart(pid: number, path: string, cwd: string, wake?: Int32Array): number {
    this.accessOwner(pid);
    if (!path || path.includes("\0") || !cwd.startsWith("/") || cwd.includes("\0"))
      throw new ProcessError(ProcessErrno.INVAL, "invalid executable query");
    if (wake && (!isSharedArrayBuffer(typedArrayBuffer(wake)) || typedArrayLength(wake) !== 1))
      throw new TypeError("access wake must be one shared int32");
    let owner = this.accesses?.get(pid);
    if (!owner) {
      (this.accesses ??= new Map()).set(pid, (owner = { next: 1, requests: new Map() }));
      this.registerRevocation(pid, () => {
        owner!.requests.clear();
        this.accesses!.delete(pid);
      });
    }
    if (owner.requests.size >= MAX_ACCESS_REQUESTS || owner.next > 0x7fffffff)
      return -ProcessErrno.AGAIN;
    const id = owner.next++,
      request: AccessRequest = { wake };
    owner.requests.set(id, request);
    void this.checkAccess(pid, id, path, cwd, owner, request);
    return id;
  }
  private async checkAccess(
    pid: number,
    id: number,
    path: string,
    cwd: string,
    owner: ProcessAccesses,
    request: AccessRequest,
  ): Promise<void> {
    const active = () => {
      this.accessOwner(pid);
      if (owner.requests.get(id) !== request)
        throw new ProcessError(ProcessErrno.BADF, "executable query was cancelled");
    };
    let result = 0;
    try {
      active();
      await this.options.registry.check(path, cwd, active);
      active();
    } catch (error) {
      result = executableAccessResult(error);
    }
    // Revocation/cancel removes the exact request before a late lookup can publish.
    if (owner.requests.get(id) !== request) return;
    const record = this.table.get(pid);
    if (!record || record.revoked || readOutcome(record.outcome)) {
      owner.requests.clear();
      this.accesses?.delete(pid);
      return;
    }
    request.result = result;
    if (request.wake) {
      atomicsAdd(request.wake, 0, 1);
      atomicsNotify(request.wake, 0);
    }
  }
  private access(pid: number, id: number): { owner: ProcessAccesses; request: AccessRequest } {
    this.accessOwner(pid);
    const owner = this.accesses?.get(pid),
      request = owner?.requests.get(id);
    if (!owner || !request) throw new ProcessError(ProcessErrno.BADF, "unknown executable query");
    return { owner, request };
  }
  accessReady(pid: number, id: number): boolean {
    return this.access(pid, id).request.result !== undefined;
  }
  accessTake(pid: number, id: number): number {
    const { owner, request } = this.access(pid, id);
    if (request.result === undefined) return -ProcessErrno.AGAIN;
    owner.requests.delete(id);
    return request.result;
  }
  accessCancel(pid: number, id: number): number {
    this.access(pid, id).owner.requests.delete(id);
    return 0;
  }
  /** Guest adapters may signal themselves and descendants, never a sibling or ancestor. */
  canSignal(callerPid: number, pid: number): boolean {
    this.table.require(callerPid);
    this.table.require(pid);
    let target: number | undefined = pid;
    while (target !== undefined && target !== 0) {
      if (target === callerPid) return true;
      target = this.table.parentOf(target);
    }
    return false;
  }
  canSignalJob(callerPid: number, jobId: number): boolean {
    this.table.require(callerPid);
    const job = this.table.job(jobId);
    if (!job) throw new ProcessError(ProcessErrno.SRCH, `unknown job ${jobId}`);
    return job.controlParent === callerPid;
  }
  /** A job is controlled by its owner and every live or retained ancestor of that owner. */
  canWaitJob(callerPid: number, jobId: number): boolean {
    // A synchronously accepted worker reap can reach the page after its caller was reaped
    // by an ancestor. Retained identities still authenticate that queued owner-chain action.
    if (this.table.parentOf(callerPid) === undefined)
      throw new ProcessError(ProcessErrno.SRCH, `unknown process ${callerPid}`);
    const job = this.table.job(jobId);
    if (!job)
      throw new ProcessError(
        this.table.wasJob(jobId) ? ProcessErrno.CHILD : ProcessErrno.SRCH,
        `unknown or reaped job ${jobId}`,
      );
    const seen = new Set<number>();
    let owner: number | undefined = job.controlParent;
    while (owner !== undefined && owner !== 0 && !seen.has(owner)) {
      if (owner === callerPid) return true;
      seen.add(owner);
      owner = this.table.parentOf(owner);
    }
    return false;
  }
  private requireWaitJob(callerPid: number, jobId: number) {
    const job = this.table.job(jobId);
    if (!job)
      throw new ProcessError(
        this.table.wasJob(jobId) ? ProcessErrno.CHILD : ProcessErrno.SRCH,
        `unknown or reaped job ${jobId}`,
      );
    if (!this.canWaitJob(callerPid, jobId))
      throw new ProcessError(63, `job ${jobId} is outside the caller's owner chain`);
    return job;
  }
  private jobIsEmpty(job: ProcessJob, internal = false): boolean {
    try {
      if (
        !Array.from(this.jobReadiness).every((check) => check(job.id)) ||
        job.pendingMembers !== 0
      )
        return false;
      return this.table.confirmJobOutcome(job.id) !== null;
    } catch (error) {
      // A blocked worker can claim the shared job immediately after safe publication.
      // Public waiters see CHILD; internal wake/cleanup bookkeeping must not fail for it.
      if (
        internal &&
        error instanceof ProcessError &&
        (error.errno === ProcessErrno.CHILD || error.errno === ProcessErrno.SRCH)
      )
        return false;
      throw error;
    }
  }
  /** Controller adapters include accepted reservations not yet admitted to the local table. */
  registerJobReadiness(check: (job: number) => boolean): () => void {
    this.jobReadiness.add(check);
    return () => {
      this.jobReadiness.delete(check);
    };
  }
  /** A shared controller atomically claims consumption before any local records are removed. */
  registerJobReapClaim(claim: (job: number) => boolean): () => void {
    this.jobReapClaims.add(claim);
    return () => {
      this.jobReapClaims.delete(claim);
    };
  }
  /** Shared adapters observe retained child authority or atomically claim its collection. */
  registerChildAccess(check: (pid: number, consume: boolean) => boolean): () => void {
    this.childAccess.add(check);
    return () => {
      this.childAccess.delete(check);
    };
  }
  onJobReap(listener: (job: number) => void): () => void {
    this.jobReapListeners.add(listener);
    return () => {
      this.jobReapListeners.delete(listener);
    };
  }
  jobEmpty(callerPid: number, jobId: number): boolean {
    const job = this.requireWaitJob(callerPid, jobId);
    return this.jobIsEmpty(job);
  }
  registerJobWake(callerPid: number, jobId: number, wake: Int32Array): () => void {
    if (!isSharedArrayBuffer(typedArrayBuffer(wake)) || typedArrayLength(wake) !== 1)
      throw new TypeError("job wake must be one shared int32");
    this.requireWaitJob(callerPid, jobId);
    return addWakeListener(this.jobListeners, jobId, wake);
  }
  createRoot(options: RootProcessOptions = {}): number {
    if (this.disposed) throw new ProcessError(ProcessErrno.SRCH, "supervisor is disposed");
    const cwd = checkedProcessCwd(options.cwd === undefined ? "/" : options.cwd);
    const pid = options.pid ?? this.table.identities.pid();
    this.table.checkPid(pid, options.outcome);
    const interrupt = signalWord(options.interrupt),
      requestedSignal = signalWord(options.requestedSignal),
      outcome = outcomeWord(options.outcome),
      signalState = createSignalState(options.signalState);
    // Explicit root ids may share an existing job, as with an externally reserved guest root.
    const job =
      options.job !== undefined && this.table.job(options.job)
        ? this.table.job(options.job)!
        : this.table.createJob(
            pid,
            options.foreground ?? true,
            options.job,
            isInstance(options.outcome, OutcomeCell)
              ? {
                  ownerPid: pid,
                  leaderPid: pid,
                  outcome: options.outcome,
                  foreground: options.foreground ?? true,
                }
              : undefined,
          );
    this.table.insert(
      {
        pid,
        parentPid: 0,
        job: job.id,
        cwd,
        descriptors: options.descriptors ?? new DescriptorTable(),
        interrupt,
        requestedSignal,
        signalState,
        outcome,
        request: null,
        state: "running",
        result: null,
        jobSafe: false,
        signal: 0,
        revoked: false,
        revocations: new Set(),
        waiters: new Set(),
      },
      isInstance(options.outcome, OutcomeCell),
    );
    return pid;
  }
  reserveSpawn(parentPid: number, spec: SpawnRequest, reservation: SpawnReservation = {}): number {
    try {
      return this.reserveProcess(parentPid, spec, reservation, false);
    } catch (error) {
      throw spawnError(error);
    }
  }
  /** Controller-only adoption of a spawn accepted before lazy supervisor activation.
   * Admission and descriptor retention must already have happened while the parent was live.
   * Shared state is adopted unchanged; a preclaimed child outcome still prevents launch.
   */
  reserveAdmittedSpawn(
    parentPid: number,
    spec: SpawnRequest,
    reservation: SpawnReservation = {},
    retainedDescriptors?: DescriptorTable,
    jobIdentity?: SharedJobIdentity,
  ): number {
    return this.reserveProcess(
      parentPid,
      spec,
      reservation,
      true,
      retainedDescriptors,
      jobIdentity,
    );
  }
  private reserveProcess(
    parentPid: number,
    spec: SpawnRequest,
    reservation: SpawnReservation,
    admitted: boolean,
    retainedDescriptors?: DescriptorTable,
    jobIdentity?: SharedJobIdentity,
  ): number {
    if (this.disposed) throw new ProcessError(ProcessErrno.SRCH, "supervisor is disposed");
    const cwd = checkedProcessCwd(spec.cwd);
    const parent = this.table.get(parentPid);
    // A separately selected job can be admitted after an ancestor reaped its exited parent.
    // Its worker already retained the capabilities and ancestry before that reap.
    if (!parent && (!admitted || !retainedDescriptors))
      throw new ProcessError(ProcessErrno.SRCH, `unknown process ${parentPid}`);
    if (
      !admitted &&
      (parent!.result || parent!.signal === Signal.SIGKILL || readOutcome(parent!.outcome))
    )
      throw new ProcessError(ProcessErrno.SRCH, "parent process has exited or is being killed");
    const parentDescriptors = retainedDescriptors ?? parent!.descriptors;
    if (!Number.isInteger(spec.job) || spec.job < -1)
      throw new ProcessError(ProcessErrno.INVAL, "invalid job selection");
    const bindings = new Set<number>();
    for (const binding of spec.fds) {
      if (!validFd(binding.child) || !validFd(binding.parent) || bindings.has(binding.child)) {
        throw new ProcessError(ProcessErrno.INVAL, "invalid or duplicate descriptor binding");
      }
      if (!parentDescriptors.get(binding.parent))
        throw new ProcessError(ProcessErrno.BADF, `missing parent descriptor ${binding.parent}`);
      bindings.add(binding.child);
    }
    const interrupt = signalWord(reservation.interrupt),
      requestedSignal = signalWord(reservation.requestedSignal),
      outcome = outcomeWord(reservation.outcome),
      signalState = createSignalState(reservation.signalState);
    const request = snapshot(spec);
    const pid = reservation.pid ?? this.table.identities.pid();
    this.table.checkPid(pid, admitted ? reservation.outcome : undefined);
    let job = reservation.job ?? (spec.job > 0 ? spec.job : undefined);
    let createdJob = false;
    if (job !== undefined && !this.table.job(job)) {
      if (reservation.job === undefined)
        throw new ProcessError(ProcessErrno.SRCH, `unknown job ${job}`);
      this.table.createJob(
        jobIdentity?.ownerPid ?? parentPid,
        jobIdentity?.foreground ?? spec.job === 0,
        job,
        jobIdentity,
      );
      createdJob = true;
    }
    if (job === undefined) {
      job = this.table.createJob(reservation.controlParent ?? parentPid, spec.job === 0).id;
      createdJob = true;
    }
    if (jobIdentity) this.table.adoptJobIdentity(job, jobIdentity);
    const descriptors = new DescriptorTable();
    const inherited = new Map<OpenDescription, Descriptor>();
    const revocations = new Set<() => void>();
    try {
      for (const binding of request.fds) {
        const source = parentDescriptors.get(binding.parent)!;
        let target = inherited.get(source.description);
        if (!target) {
          const resource = source.resource;
          if ((resource.kind === "pipe" || resource.kind === "terminal") && resource.forProcess) {
            const owned = resource.forProcess(pid);
            target =
              owned === resource
                ? source
                : {
                    ...source,
                    resource: owned,
                    description: new OpenDescription(owned, () => owned.close?.()),
                  };
            if (owned.revoke) revocations.add(() => owned.revoke!());
          } else target = source;
          inherited.set(source.description, target);
        }
        descriptors.inherit(binding.child, {
          ...target,
          rightsBase: source.rightsBase,
          rightsInheriting: source.rightsInheriting,
        });
      }
      this.table.insert(
        {
          pid,
          parentPid,
          job,
          cwd,
          descriptors,
          controlParent: reservation.controlParent,
          rootPid: reservation.rootPid,
          interrupt,
          requestedSignal,
          signalState,
          outcome,
          request,
          state: "reserved",
          result: null,
          jobSafe: false,
          signal: 0,
          revoked: false,
          revocations,
          waiters: new Set(),
        },
        admitted,
      );
    } catch (error) {
      this.disposeDescriptors(descriptors);
      if (createdJob) this.table.removeEmptyJob(job);
      throw error;
    }
    return pid;
  }
  spawn(parentPid: number, spec: SpawnRequest, reservation?: SpawnReservation): number {
    const pid = this.reserveSpawn(parentPid, spec, reservation);
    queueMicrotask(() => {
      void this.start(pid);
    });
    return pid;
  }
  /** Idempotent: direct spawn and the asynchronous activation stub may both request start. */
  start(pid: number): Promise<void> {
    const record = this.table.get(pid);
    if (!record || record.request === null) return Promise.resolve();
    if (record.starting) return record.starting;
    if (record.result || record.revoked) return Promise.resolve();
    const settled = readOutcome(record.outcome);
    if (settled) {
      this.finish(pid, settled);
      return Promise.resolve();
    }
    record.state = "starting";
    record.starting = this.launch(record);
    return record.starting;
  }
  private async launch(record: ProcessRecord): Promise<void> {
    try {
      const executable = await this.options.registry.resolve(
        record.request!.executable,
        record.request!.cwd,
        () => {
          if (record.result || record.revoked || readOutcome(record.outcome))
            throw new Error("process exited before executable admission completed");
        },
        record.request!.argv,
      );
      if (record.result || record.revoked) return;
      const settled = readOutcome(record.outcome);
      if (settled) {
        this.finish(record.pid, settled);
        return;
      }
      const context: ProcessContext = {
        pid: record.pid,
        parentPid: record.parentPid,
        job: record.job,
        request:
          executable.argv === undefined
            ? record.request!
            : { ...record.request!, argv: executable.argv.slice() },
        module: executable.module,
        adapter: executable.adapter,
        interruptible: executable.interruptible,
        descriptors: record.descriptors,
        interrupt: record.interrupt,
        requestedSignal: record.requestedSignal,
        signalState: record.signalState,
        outcome: record.outcome,
        started: () => this.started(record.pid),
        exit: (code) => this.exit(record.pid, code),
        fail: () => this.finish(record.pid, { kind: "exited", code: 126 }, undefined, true),
        startFailed: (error) => this.failStart(record.pid, error),
        defaultSignal: (signal) => this.defaultSignal(record.pid, signal),
        registerRevocation: (hook) => this.registerRevocation(record.pid, hook),
      };
      const handle = await this.options.launch(context);
      record.handle = handle;
      // Revocation alone does not prove storage safety. A late handle belongs to
      // the pending fence too; only a confirmed result permits physical stop.
      if (record.result) this.stopHandle(record);
      else if (!record.revoked) record.state = "running";
    } catch (error) {
      this.failStart(record.pid, error);
    }
  }
  /** Launch handles do not prove entry; the executing host calls this at its entry boundary. */
  started(pid: number): boolean {
    const record = this.table.require(pid);
    if (record.revoked || !markStarted(record.outcome)) return false;
    record.state = "running";
    this.notifyStart(pid);
    return true;
  }
  startStatus(parentPid: number, pid: number): number {
    try {
      return startStatus(this.child(parentPid, pid).outcome);
    } catch (error) {
      if (
        error instanceof ProcessError &&
        (error.errno === ProcessErrno.SRCH || error.errno === ProcessErrno.CHILD)
      )
        throw new ProcessError(ProcessErrno.CHILD, "not a retained child process");
      throw error;
    }
  }
  registerChildStartWake(parentPid: number, pid: number, wake: Int32Array): () => void {
    if (!isSharedArrayBuffer(typedArrayBuffer(wake)) || typedArrayLength(wake) !== 1)
      throw new TypeError("startup wake must be one shared int32");
    this.child(parentPid, pid);
    return addWakeListener(this.startListeners, pid, wake);
  }
  private notifyStart(pid: number): void {
    const listeners = this.startListeners.get(pid);
    if (listeners) for (const listener of Array.from(listeners)) this.safely(listener);
  }
  failStart(pid: number, error: unknown): void {
    this.finish(pid, startFailure(error), error);
  }
  exit(pid: number, code: number): void {
    if (!Number.isInteger(code))
      throw new ProcessError(ProcessErrno.INVAL, "exit code must be an integer");
    this.finish(pid, { kind: "exited", code });
  }
  /** Default signals terminate immediately; registered handlers receive shared pending delivery. */
  kill(pid: number, signal: number): void {
    const sig = checkedSignal(signal),
      record = this.table.require(pid);
    if (record.result) return;
    this.recordSignal(record, sig);
    if (record.signal === Signal.SIGKILL || readOutcome(record.outcome))
      this.finish(pid, { kind: "signaled", code: Signal.SIGKILL });
  }
  /** Observe a request already published by a synchronous guest stub. Never redeliver a
   * catchable interrupt the guest may have consumed before this host notification arrived.
   */
  observeSignal(pid: number, signal: number): void {
    checkedSignalNumber(signal);
    const record = this.table.require(pid);
    if (record.result) return;
    const requested = controlLoad(record.requestedSignal, 0);
    if (requested === Signal.SIGKILL) this.recordSignal(record, Signal.SIGKILL);
    else if (record.signal !== Signal.SIGKILL && requested !== 0) record.signal = requested;
    if (record.signal === Signal.SIGKILL || readOutcome(record.outcome))
      this.finish(pid, { kind: "signaled", code: Signal.SIGKILL });
  }
  private recordSignal(record: ProcessRecord, signal: number): void {
    if (record.result) return;
    const delivery = requestSignal(record, signal);
    if (delivery.action !== "ignore" && delivery.action !== "settled") {
      record.signal = controlLoad(record.requestedSignal, 0);
    }
    if (delivery.outcome?.kind === "signaled" && delivery.outcome.code === Signal.SIGKILL)
      record.signal = Signal.SIGKILL;
  }
  private publishKill(record: ProcessRecord): void {
    record.signal = Signal.SIGKILL;
    requestSignal(record, Signal.SIGKILL);
  }
  /** Explicit guest default action. A random trap after a handled signal is not a signal exit. */
  defaultSignal(pid: number, signal?: number): void {
    const record = this.table.get(pid);
    if (!record || record.result) return;
    const settled = readOutcome(record.outcome);
    if (settled) {
      this.finish(pid, settled);
      return;
    }
    const sig = checkedSignalNumber(
      signal ?? (record.signal || controlLoad(record.requestedSignal, 0)),
    );
    const killed = controlLoad(record.requestedSignal, 0) === Signal.SIGKILL;
    if (!killed && !defaultSignalTerminates(sig)) return;
    const winner = claimOutcome(record.outcome, {
      kind: "signaled",
      code: killed ? Signal.SIGKILL : sig,
    });
    this.finish(pid, winner);
  }
  killJob(jobId: number, signal: number): void {
    const sig = checkedSignal(signal);
    const job = this.table.job(jobId);
    if (!job) throw new ProcessError(ProcessErrno.SRCH, `unknown job ${jobId}`);
    // New background jobs are independent, even when their parent belongs to this job.
    const targets = Array.from(job.members, (pid) => this.table.require(pid));
    // Record every target before callbacks: a dying process cannot spawn through an as-yet
    // unmarked sibling, or replace that sibling's SIGKILL with a handled exit.
    for (const record of targets) {
      try {
        this.recordSignal(record, sig);
      } catch (error) {
        if (
          !(error instanceof ProcessError) ||
          (error.errno !== ProcessErrno.SRCH && error.errno !== ProcessErrno.CHILD)
        )
          throw error;
      }
    }
    for (const record of targets) {
      try {
        if (
          this.table.get(record.pid) === record &&
          (record.signal === Signal.SIGKILL || readOutcome(record.outcome))
        ) {
          this.finish(record.pid, { kind: "signaled", code: Signal.SIGKILL });
        }
      } catch (error) {
        if (
          !(error instanceof ProcessError) ||
          (error.errno !== ProcessErrno.SRCH && error.errno !== ProcessErrno.CHILD)
        )
          throw error;
      }
    }
  }
  /** Observation for readiness polling; only wait/reap consumes a child. */
  childExited(parentPid: number, pid: number): boolean {
    return this.child(parentPid, pid).result !== null;
  }
  wait(parentPid: number, pid: number): ProcessExit | null {
    if (!this.child(parentPid, pid).result) return null;
    return this.reap(parentPid, pid);
  }
  /** Returns and reaps a completed job, retaining the leader's typed outcome even if it was reaped separately. */
  waitJob(parentPid: number, jobId: number): ProcessExit | null {
    const job = this.requireWaitJob(parentPid, jobId);
    if (!this.jobIsEmpty(job)) return null;
    return this.reapJob(parentPid, jobId);
  }
  reapJob(parentPid: number, jobId: number): ProcessExit {
    const job = this.requireWaitJob(parentPid, jobId);
    if (!this.jobIsEmpty(job))
      throw new ProcessError(ProcessErrno.AGAIN, "job has not become empty");
    const result = job.leaderResult;
    if (!result) throw new ProcessError(ProcessErrno.CHILD, "job leader has no final outcome");
    for (const claim of this.jobReapClaims) {
      if (!claim(jobId))
        throw new ProcessError(ProcessErrno.CHILD, "job was already reaped by another observer");
    }
    this.retireJobMetadata(jobId);
    return result;
  }
  /** The shared consuming claim is authoritative even when its worker never posts a receipt. */
  reconcileCollectedJob(jobId: number): void {
    const job = this.table.job(jobId);
    if (job && job.pendingMembers === 0 && this.table.jobClaimed(jobId))
      this.retireJobMetadata(jobId);
  }
  private retireJobMetadata(jobId: number): void {
    for (const record of Array.from(this.table.values()))
      if (record.job === jobId) this.table.remove(record.pid);
    this.table.removeJob(jobId);
    for (const listener of Array.from(this.jobReapListeners)) this.safely(() => listener(jobId));
    this.jobListeners.delete(jobId);
  }
  waitForExit(parentPid: number, pid: number): Promise<ProcessExit> {
    const record = this.child(parentPid, pid);
    if (record.result) return Promise.resolve(record.result);
    return new Promise((resolve) => record.waiters.add(resolve));
  }
  reap(parentPid: number, pid: number): ProcessExit {
    const record = this.child(parentPid, pid);
    if (!record.result) throw new ProcessError(ProcessErrno.AGAIN, "child has not exited");
    this.checkChildAccess(pid, true);
    this.table.remove(pid);
    return record.result;
  }
  private child(parentPid: number, pid: number): ProcessRecord {
    const record = this.table.get(pid);
    if (!record || record.parentPid !== parentPid)
      throw new ProcessError(ProcessErrno.CHILD, `process ${pid} is not a child of ${parentPid}`);
    this.checkChildAccess(pid, false);
    return record;
  }
  private checkChildAccess(pid: number, consume: boolean): void {
    for (const check of this.childAccess) {
      if (check(pid, consume)) continue;
      this.table.remove(pid);
      throw new ProcessError(ProcessErrno.CHILD, "child was already collected");
    }
  }
  onChildExit(listener: (event: ChildExitEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onProcessQuiescent(listener: (event: ChildExitEvent) => void): () => void {
    this.quiescentListeners.add(listener);
    return () => {
      this.quiescentListeners.delete(listener);
    };
  }
  registerRevocation(pid: number, hook: () => void): () => void {
    const record = this.table.get(pid);
    if (!record || record.revoked) this.safely(hook);
    else record.revocations.add(hook);
    return () => {
      record?.revocations.delete(hook);
    };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cancel of Array.from(this.startupDrains.values())) cancel();
    const records = Array.from(this.table.values());
    for (const record of records) this.recordSignal(record, Signal.SIGKILL);
    for (const record of records) {
      if (this.table.get(record.pid) === record) {
        this.finish(record.pid, { kind: "signaled", code: Signal.SIGKILL });
        this.table.remove(record.pid);
        this.table.removeJob(record.job);
      }
    }
    this.table.clearJobs();
    this.listeners.clear();
    this.jobReadiness.clear();
    this.jobReapListeners.clear();
    this.jobReapClaims.clear();
    this.childAccess.clear();
    this.quiescentListeners.clear();
    this.jobListeners.clear();
    this.startListeners.clear();
  }
  private finish(
    pid: number,
    result: Omit<ProcessExit, "status">,
    startError?: unknown,
    failedExecutor = false,
  ): void {
    const record = this.table.get(pid);
    if (!record || record.result || this.finishing.has(pid)) return;
    this.finishing.set(pid, record);
    // A synchronous guest-side kill publishes its word before the asynchronous broker message.
    if (controlLoad(record.requestedSignal, 0) === Signal.SIGKILL)
      this.recordSignal(record, Signal.SIGKILL);
    if (record.signal === Signal.SIGKILL) result = { kind: "signaled", code: Signal.SIGKILL };
    // Parent kill, worker completion and page failure all choose the same immutable outcome.
    // A signal published after our last read still competes at this atomic decision, rather
    // than overriding one observer's already-final result after the fact.
    let winner: ProcessExit,
      claimed = false;
    const ownClaim = () => {
      claimed = true;
    };
    try {
      winner = claimOutcome(record.outcome, result, ownClaim);
    } catch (error) {
      // Entry and a host-side setup error can race. Entry's CAS changes this into an
      // execution failure, never START_FAILED after observers saw successful entry.
      if (
        result.kind !== "start-failed" ||
        !(error instanceof ProcessError) ||
        error.errno !== ProcessErrno.INVAL ||
        startStatus(record.outcome) !== 0
      ) {
        this.finishing.delete(pid);
        throw error;
      }
      winner = claimOutcome(record.outcome, { kind: "exited", code: 126 }, ownClaim);
      failedExecutor = claimed;
    }
    this.notifyStart(pid);
    // Only a host-owned terminal claim can abandon an executor that cannot acknowledge.
    // If a worker exit wins instead, its queued output must still drain first.
    if (winner.kind !== "signaled" && !(failedExecutor && claimed) && !this.disposed) {
      let canConfirm: boolean;
      try {
        canConfirm = this.options.canConfirmExit?.(pid) !== false;
      } catch (error) {
        this.finishing.delete(pid);
        throw error;
      }
      if (!canConfirm) {
        this.finishing.delete(pid);
        return;
      }
    }
    if (winner.kind === "start-failed" && !this.startFailures.has(record)) {
      // Any producer can win the terminal CAS. Ordered acknowledgement supplies the error;
      // this supervisor alone owns its diagnostic, before revocation or descriptor release.
      this.startFailures.add(record);
      let active = true;
      const complete = () => {
        if (!active) return;
        active = false;
        this.startupDrains.delete(record);
        this.complete(record, winner);
      };
      const cancel = () => {
        if (!active) return;
        this.report(
          new ProcessError(
            ProcessErrno.CANCELED,
            "startup diagnostic delivery cancelled by supervisor disposal",
          ),
        );
        complete();
      };
      this.startupDrains.set(record, cancel);
      if (this.disposed) {
        cancel();
        return;
      }
      let pending: void | Promise<void> = undefined;
      try {
        pending = this.options.startFailed?.(
          pid,
          startError ?? winner.error,
          () => active && !this.disposed,
        );
      } catch (error) {
        if (active) this.report(error);
      }
      if (pending) {
        void pending.then(complete, (error) => {
          if (!active) return;
          this.report(error);
          complete();
        });
      } else complete();
      return;
    }
    this.complete(record, winner);
  }
  private complete(record: ProcessRecord, winner: ProcessExit): void {
    const pid = record.pid;
    if (winner.kind === "signaled" && winner.code === Signal.SIGKILL) this.publishKill(record);
    record.revoked = true;
    const hooks = Array.from(record.revocations);
    record.revocations.clear();
    for (const hook of hooks) this.safely(hook);
    this.disposeDescriptors(record.descriptors);
    // Invoke the fence while broker child/identity records are still present. Every observer
    // must wait for admitted filesystem and adapter work (for example a terminal section),
    // independently of the physical worker's potentially delayed termination.
    let quiescence: void | Promise<void> = undefined;
    let fenceFailed = false;
    try {
      quiescence = this.options.quiesce?.(pid);
    } catch (error) {
      fenceFailed = true;
      this.report(error);
    }
    const safe = () => {
      const event = objectFreeze({
        pid,
        parentPid: record.parentPid,
        job: record.job,
        result: winner,
      });
      // Publish shared collectibility before host waits or public exit observers can
      // consume the result and synchronously reserve replacement capacity.
      for (const listener of Array.from(this.quiescentListeners))
        this.safely(() => listener(event));
      record.result = winner;
      record.state = "exited";
      this.table.recordOutcome(record);
      this.finishing.delete(pid);
      this.table.markJobSafe(record);
      for (const resolve of record.waiters) resolve(winner);
      record.waiters.clear();
      for (const listener of Array.from(this.listeners)) this.safely(() => listener(event));
      const job = this.table.job(record.job);
      if (job && this.jobIsEmpty(job, true)) {
        const listeners = this.jobListeners.get(record.job);
        if (listeners) for (const listener of Array.from(listeners)) this.safely(listener);
      }
      this.stopHandle(record);
      // A dead parent cannot collect children. Retain only running descendants and compress
      // their control ancestry; late orphan completion collects after its own safety fence.
      for (const child of Array.from(this.table.values())) {
        if (child.parentPid === pid && child.result) this.table.remove(child.pid);
        else if (child.controlParent === pid) child.controlParent = record.controlParent ?? 0;
      }
      for (const group of Array.from(this.table.values(), (member) => this.table.job(member.job))) {
        if (group?.controlParent === pid) group.controlParent = record.controlParent ?? 0;
      }
      if (
        record.parentPid !== 0 &&
        (!this.table.get(record.parentPid) || this.table.get(record.parentPid)?.result)
      )
        this.table.remove(pid);
    };
    if (!fenceFailed) {
      if (quiescence) void quiescence.then(safe, (error) => this.report(error));
      else safe();
    }
  }
  private stopHandle(record: ProcessRecord): void {
    if (!record.handle) return;
    const handle = record.handle;
    record.handle = undefined;
    this.terminate(handle);
  }
  private disposeDescriptors(descriptors: DescriptorTable): void {
    // dispose drains every entry before reporting release errors. These errors are diagnostics,
    // not transient work: report once and continue to the explicit host quiescence fence.
    try {
      descriptors.dispose();
    } catch (error) {
      this.report(error);
    }
  }
  private terminate(handle: ProcessHandle): void {
    try {
      const pending = handle.terminate();
      if (pending) void pending.catch((error) => this.report(error));
    } catch (error) {
      this.report(error);
    }
  }
  private safely(operation: () => void): void {
    try {
      operation();
    } catch (error) {
      this.report(error);
    }
  }
  private report(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      /* diagnostics must not break teardown */
    }
  }
}
