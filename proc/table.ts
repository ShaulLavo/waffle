import {
  isInstance,
  sharedArrayBufferByteLength,
  typedArrayBuffer,
  typedArrayByteOffset,
} from "./intrinsics.ts";
import type { ControlCells } from "./control.js";
import { type OutcomeWord, OutcomeCell, outcomeWord, readOutcome } from "./outcome.js";
import { DescriptorTable } from "../core/descriptors.js";
import { ProcessIdentityAllocator } from "./identity.js";

import {
  ProcessErrno,
  ProcessError,
  type ProcessExit,
  type ProcessHandle,
  type SpawnRequest,
  type SharedJobIdentity,
  type JobLifetime,
} from "./types.js";

export interface ProcessRecord {
  readonly pid: number;
  readonly parentPid: number;
  controlParent?: number;
  rootPid?: number;
  readonly job: number;
  readonly descriptors: DescriptorTable;
  readonly interrupt: ControlCells;
  readonly requestedSignal: ControlCells;
  readonly signalState: ControlCells;
  readonly outcome: OutcomeWord;
  readonly request: Readonly<SpawnRequest> | null;
  state: "reserved" | "starting" | "running" | "exited";
  result: ProcessExit | null;
  /** Job completion additionally waits for filesystem admission fences. */
  jobSafe: boolean;
  /** Host-owned signal record; unlike shared words, a dying guest cannot overwrite it. */
  signal: number;
  revoked: boolean;
  handle?: ProcessHandle;
  starting?: Promise<void>;
  acquiring?: Promise<void>;
  stopping?: Promise<void>;
  retirement?: { kind: "complete" } | { kind: "failed"; error: unknown };
  revocations: Set<() => void>;
  waiters: Set<(result: ProcessExit) => void>;
}
export interface ProcessJob {
  readonly id: number;
  readonly ownerPid: number;
  controlParent: number;
  readonly foreground: boolean;
  readonly jobLifetime: JobLifetime;
  lifetimeState: "independent" | "attached" | "disarmed" | "closing";
  readonly shared: boolean;
  /** The first member is the job leader; its outcome remains available after ordinary child reap. */
  readonly leaderPid: number | undefined;
  readonly leaderResult: ProcessExit | null;
  readonly pendingMembers: number;
  /** Descendants inherit a job unless spawn explicitly creates/joins another one. */
  readonly members: ReadonlySet<number>;
}
interface MutableProcessJob extends Omit<
  ProcessJob,
  "members" | "leaderPid" | "leaderResult" | "pendingMembers"
> {
  leaderPid: number | undefined;
  leaderResult: ProcessExit | null;
  pendingMembers: number;
  members: Set<number>;
  leaderOutcome: OutcomeWord | null;
}
function sameOutcomeLocation(left: OutcomeWord, right: OutcomeWord): boolean {
  const leftOffset = isInstance(left, OutcomeCell) ? left.byteOffset : typedArrayByteOffset(left);
  const rightOffset = isInstance(right, OutcomeCell)
    ? right.byteOffset
    : typedArrayByteOffset(right);
  const leftBuffer = isInstance(left, OutcomeCell)
    ? left.buffer
    : (typedArrayBuffer(left) as SharedArrayBuffer);
  const rightBuffer = isInstance(right, OutcomeCell)
    ? right.buffer
    : (typedArrayBuffer(right) as SharedArrayBuffer);
  return (
    leftOffset === rightOffset &&
    sharedArrayBufferByteLength(leftBuffer) === sharedArrayBufferByteLength(rightBuffer)
  );
}
/** Host-owned records. Neither guest workers nor their blocked WASM own this table. */
export class ProcessTable {
  readonly identities: ProcessIdentityAllocator;
  private readonly records = new Map<number, ProcessRecord>();
  private readonly jobs = new Map<number, MutableProcessJob>();
  private readonly removeListeners = new Set<(record: ProcessRecord) => void>();
  onRemove(listener: (record: ProcessRecord) => void): () => void {
    this.removeListeners.add(listener);
    return () => {
      this.removeListeners.delete(listener);
    };
  }
  private highestRetiredPid = 0;
  private highestJob = 0;
  constructor(identities = new ProcessIdentityAllocator()) {
    this.identities = identities;
  }
  get(pid: number): ProcessRecord | undefined {
    return this.records.get(pid);
  }
  parentOf(pid: number): number | undefined {
    return this.records.get(pid)?.controlParent;
  }
  job(id: number): ProcessJob | undefined {
    return this.jobs.get(id);
  }
  /** Job ids are never reused, so callers can distinguish an already-reaped job from an unknown id. */
  wasJob(id: number): boolean {
    return id > 0 && id <= this.highestJob;
  }
  jobClaimed(id: number): boolean {
    const outcome = this.jobs.get(id)?.leaderOutcome;
    return isInstance(outcome, OutcomeCell) && !outcome.valid();
  }
  values(): IterableIterator<ProcessRecord> {
    return this.records.values();
  }
  jobValues(): IterableIterator<ProcessJob> {
    return this.jobs.values();
  }
  require(pid: number): ProcessRecord {
    const record = this.get(pid);
    if (!record) throw new ProcessError(ProcessErrno.SRCH, `unknown process ${pid}`);
    return record;
  }
  createJob(
    ownerPid: number,
    foreground: boolean,
    id = this.identities.job(),
    identity?: SharedJobIdentity,
    jobLifetime: JobLifetime = "independent",
  ): ProcessJob {
    if (isInstance(identity?.outcome, OutcomeCell)) identity.outcome.check();
    const captured = isInstance(identity?.outcome, OutcomeCell);
    if (this.jobs.has(id) || (!captured && id <= this.highestJob))
      throw new ProcessError(ProcessErrno.INVAL, `job ${id} was already reserved`);
    this.identities.observeJob(id);
    const job: MutableProcessJob = {
      id,
      ownerPid,
      controlParent: identity?.controlParent ?? ownerPid,
      foreground,
      jobLifetime: identity?.jobLifetime ?? jobLifetime,
      lifetimeState:
        (identity?.jobLifetime ?? jobLifetime) === "caller-fatal" ? "attached" : "independent",
      shared: identity !== undefined,
      leaderPid: identity?.leaderPid,
      leaderResult: null,
      pendingMembers: 0,
      members: new Set(),
      leaderOutcome: identity ? outcomeWord(identity.outcome) : null,
    };
    this.highestJob = Math.max(this.highestJob, id);
    this.jobs.set(id, job);
    return job;
  }
  /** The directory's first member, not the first delivered spawn message, owns the outcome. */
  adoptJobIdentity(id: number, identity: SharedJobIdentity): void {
    const job = this.jobs.get(id);
    if (!job) throw new ProcessError(ProcessErrno.SRCH, `unknown job ${id}`);
    const outcome = outcomeWord(identity.outcome);
    const previous =
      job.leaderOutcome ??
      (job.leaderPid === undefined ? null : this.records.get(job.leaderPid)?.outcome);
    // A root is created from its process outcome before the broker attaches its independent
    // job header. Bind that one captured source once; subsequent admissions must agree.
    const leader = job.leaderPid === undefined ? undefined : this.records.get(job.leaderPid);
    const rootSource =
      leader?.parentPid === 0 &&
      previous === leader.outcome &&
      isInstance(previous, OutcomeCell) &&
      isInstance(outcome, OutcomeCell) &&
      previous.pid === outcome.pid &&
      previous.valid() &&
      outcome.valid();
    // Structured cloning creates different SAB wrappers; offsets still identify the cell.
    if (
      job.ownerPid !== identity.ownerPid ||
      job.foreground !== identity.foreground ||
      job.jobLifetime !== (identity.jobLifetime ?? "independent") ||
      (job.leaderPid !== undefined && job.leaderPid !== identity.leaderPid) ||
      (previous && !rootSource && !sameOutcomeLocation(previous, outcome))
    ) {
      throw new ProcessError(ProcessErrno.INVAL, `job ${id} identity changed`);
    }
    job.leaderPid = identity.leaderPid;
    if (!job.leaderOutcome || rootSource) job.leaderOutcome = outcome;
  }
  /** Call only after every local member and shared-directory reservation is safely complete. */
  confirmJobOutcome(id: number): ProcessExit | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (!job.leaderResult && job.leaderOutcome) job.leaderResult = readOutcome(job.leaderOutcome);
    return job.leaderResult;
  }
  /** Roll back a reservation without deleting a job that a reentrant hook populated. */
  removeEmptyJob(id: number): void {
    if (this.jobs.get(id)?.members.size === 0) this.jobs.delete(id);
  }
  checkPid(pid: number, authority?: OutcomeWord | SharedArrayBuffer): void {
    if (isInstance(authority, OutcomeCell)) {
      authority.check();
      if (authority.pid !== pid)
        throw new ProcessError(ProcessErrno.INVAL, "process outcome identity differs from pid");
    }
    const captured = isInstance(authority, OutcomeCell);
    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      pid > 0x7fffffff ||
      this.records.has(pid) ||
      (!captured && pid <= this.highestRetiredPid)
    ) {
      throw new ProcessError(ProcessErrno.INVAL, `pid ${pid} is invalid or was already reserved`);
    }
  }
  insert(record: ProcessRecord, admitted = false): void {
    this.checkPid(record.pid, admitted ? record.outcome : undefined);
    const job = this.jobs.get(record.job);
    if (!job) throw new ProcessError(ProcessErrno.SRCH, `unknown job ${record.job}`);
    // Worker transports reserve membership synchronously before posting admission. The host
    // may already have confirmed the previous member while that accepted spawn was queued.
    if (!admitted && job.leaderPid !== undefined && job.pendingMembers === 0) {
      throw new ProcessError(ProcessErrno.CHILD, `completed job ${job.id} cannot be joined`);
    }
    this.identities.observePid(record.pid);
    record.controlParent ??=
      this.records.get(record.parentPid)?.controlParent === 0 &&
      this.records.get(record.parentPid)?.result
        ? 0
        : record.parentPid;
    record.rootPid ??=
      record.parentPid === 0 ? record.pid : this.records.get(record.parentPid)?.rootPid;

    this.records.set(record.pid, record);
    if (job.leaderPid === undefined) job.leaderPid = record.pid;
    job.members.add(record.pid);
    job.pendingMembers++;
  }
  recordOutcome(record: ProcessRecord): void {
    const job = this.jobs.get(record.job);
    if (job?.leaderPid === record.pid) job.leaderResult = record.result;
  }
  markJobSafe(record: ProcessRecord): void {
    if (record.jobSafe) return;
    record.jobSafe = true;
    const job = this.jobs.get(record.job);
    if (job) {
      job.pendingMembers--;
      job.members.delete(record.pid);
    }
  }
  clearJobs(): void {
    this.jobs.clear();
  }
  removeJob(id: number): void {
    this.jobs.delete(id);
  }
  remove(pid: number): void {
    const record = this.records.get(pid);
    if (!record) return;
    this.records.delete(pid);
    this.highestRetiredPid = Math.max(this.highestRetiredPid, pid);
    for (const child of this.records.values())
      if (child.controlParent === pid) child.controlParent = record.controlParent ?? 0;
    for (const group of this.jobs.values())
      if (group.controlParent === pid) group.controlParent = record.controlParent ?? 0;

    const job = this.jobs.get(record.job);
    job?.members.delete(pid);
    for (const listener of this.removeListeners) listener(record);
    // Completion metadata outlives individual child reap until wait_job consumes it.
  }
}
