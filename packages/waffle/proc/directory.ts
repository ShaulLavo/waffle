import {
  TaggedCells,
  packedControl,
  controlCas,
  controlLoad,
  controlStore,
  type CellValidity,
} from "./control.js";
import { OutcomeCell, claimOutcome, readOutcome } from "./outcome.js";
import { ProcessErrno, ProcessError, type ProcessExit, type JobLifetime } from "./types.js";
import { requestSignal, type SignalTransport } from "./signals.js";
import {
  arrayAppend,
  atomicsAdd,
  atomicsCompareExchange,
  atomicsLoad,
  atomicsNotify,
  atomicsStore,
  BigInt64ArrayConstructor,
  Int32ArrayConstructor,
  Uint32ArrayConstructor,
  SharedArrayBufferConstructor,
  cryptoGetRandomValues,
  typedArraySet,
  typedArraySubarray,
  MapConstructor,
  SetConstructor,
  mapGet,
  mapSet,
  mapHas,
  mapForEach,
  setHas,
  setAdd,
  typedArrayBuffer,
  typedArrayByteOffset,
  typedArrayLength,
  sharedArrayBufferByteLength,
} from "./intrinsics.ts";

const HEADER_BYTES = 32;
const PROCESS_WORDS = 76;
const JOB_WORDS = 10;
export interface DirectoryHandle {
  readonly directory: SharedArrayBuffer;
  readonly slot: number;
  readonly pid: number;
}
function directoryCapacity(directory: SharedArrayBuffer): number {
  const capacity =
    (sharedArrayBufferByteLength(directory) - HEADER_BYTES) / ((PROCESS_WORDS + JOB_WORDS) * 8);
  if (!Number.isInteger(capacity) || capacity < 1) throw new TypeError("invalid process directory");
  return capacity;
}
export function createDirectory(capacity: number): SharedArrayBuffer {
  const directory = new SharedArrayBufferConstructor(
    HEADER_BYTES + capacity * (PROCESS_WORDS + JOB_WORDS) * 8,
  );
  typedArraySet(
    new Uint32ArrayConstructor(directory, 8, 2),
    cryptoGetRandomValues(new Uint32ArrayConstructor(2)),
  );
  return directory;
}
function row(directory: SharedArrayBuffer, slot: number, job = false): BigInt64Array {
  const capacity = directoryCapacity(directory);
  if (!Number.isInteger(slot) || slot < 0 || slot >= capacity)
    throw new TypeError("invalid process directory slot");
  return new BigInt64ArrayConstructor(
    directory,
    HEADER_BYTES + (job ? capacity * PROCESS_WORDS + slot * JOB_WORDS : slot * PROCESS_WORDS) * 8,
    job ? JOB_WORDS : PROCESS_WORDS,
  );
}
function validity(raw: BigInt64Array, id: number): CellValidity {
  return {
    buffer: typedArrayBuffer(raw) as SharedArrayBuffer,
    byteOffset: typedArrayByteOffset(raw),
    id,
  };
}
function cells(raw: BigInt64Array, id: number, offset: number, count = 1): TaggedCells {
  return new TaggedCells(typedArraySubarray(raw, offset, offset + count), id);
}
// Escaping views require a live row; private retirement helpers intentionally retain
// their tagged access while forwarding lifecycle-3 ancestry.
function liveCells(raw: BigInt64Array, id: number, offset: number, count = 1): TaggedCells {
  return new TaggedCells(typedArraySubarray(raw, offset, offset + count), id, validity(raw, id));
}
function identity(raw: BigInt64Array): number {
  const value = atomicsLoad(raw, 0);
  return (value & 0xffffffffn) === 1n ? Number(value >> 32n) : 0;
}
function valid(raw: BigInt64Array, id: number): boolean {
  return atomicsLoad(raw, 0) === packedControl(id, 1);
}
function allocate(
  directory: SharedArrayBuffer,
  id: number,
  job = false,
): { slot: number; raw: BigInt64Array } {
  helpDirectoryJobs(directory);
  for (let slot = 0; slot < directoryCapacity(directory); slot++) {
    const raw = row(directory, slot, job);
    if (!job) {
      const current = atomicsLoad(raw, 0);
      if ((current & 0xffffffffn) === 3n) finishCollection(directory, slot, Number(current >> 32n));
    }
    if (atomicsCompareExchange(raw, 0, 0n, packedControl(id, 2)) === 0n) return { slot, raw };
  }
  throw new ProcessError(
    ProcessErrno.AGAIN,
    job ? "job directory is full" : "process directory is full",
  );
}
export function directorySlots(directory: SharedArrayBuffer): number[] {
  const slots: number[] = [];
  for (let slot = 0; slot < directoryCapacity(directory); slot++)
    if (identity(row(directory, slot))) arrayAppend(slots, slot);
  return slots;
}
export function directoryJobs(directory: SharedArrayBuffer): number[] {
  const slots: number[] = [];
  for (let slot = 0; slot < directoryCapacity(directory); slot++)
    if (identity(row(directory, slot, true))) arrayAppend(slots, slot);
  return slots;
}
export function directoryJob(directory: SharedArrayBuffer, slot: number, expected?: number) {
  const raw = row(directory, slot, true),
    id = expected ?? identity(raw);
  if (!id || !valid(raw, id)) throw new ProcessError(ProcessErrno.CHILD, "job has been collected");
  const data = new TaggedCells(raw, id);
  const leaderPid = data.load(2);
  const state = {
    slot,
    id,
    ownerPid: data.load(1),
    leaderPid,
    foreground: data.load(5) !== 0,
    jobLifetime: data.load(8) === 0 ? ("independent" as const) : ("caller-fatal" as const),
    lifetime: liveCells(raw, id, 8),
    retirement: liveCells(raw, id, 9),
    controlParent: liveCells(raw, id, 6),
    rootPid: data.load(7),
    pending: liveCells(raw, id, 4),
    outcome: new OutcomeCell(typedArraySubarray(raw, 3, 4), leaderPid, validity(raw, id)),
  };
  if (!valid(raw, id)) throw new ProcessError(ProcessErrno.CHILD, "job has been collected");
  return state;
}
export function directoryState(handle: DirectoryHandle, slot = handle.slot) {
  const raw = row(handle.directory, slot),
    pid = slot === handle.slot ? handle.pid : identity(raw);
  if (!pid || !valid(raw, pid))
    throw new ProcessError(ProcessErrno.SRCH, "process incarnation was collected");
  const data = new TaggedCells(raw, pid),
    job = data.load(2),
    jobSlot = data.load(75);
  const group = directoryJob(handle.directory, jobSlot, job);
  const state = {
    slot,
    pid,
    parentPid: data.load(1),
    job,
    jobSlot,
    rootPid: data.load(74),
    controlParent: liveCells(raw, pid, 73),
    jobOwner: group.ownerPid,
    jobLeaderPid: group.leaderPid,
    jobForeground: group.foreground,
    jobLifetime: group.jobLifetime,
    jobOutcome: group.outcome,
    jobControlParent: group.controlParent,
    jobPending: group.pending,
    confirmed: liveCells(raw, pid, 71),
    jobConfirmed: liveCells(raw, pid, 72),
    signals: {
      interrupt: liveCells(raw, pid, 3),
      requestedSignal: liveCells(raw, pid, 4),
      outcome: new OutcomeCell(typedArraySubarray(raw, 5, 6), pid, validity(raw, pid)),
      signalState: liveCells(raw, pid, 6, 65),
    } satisfies SignalTransport,
    wake: new Int32ArrayConstructor(handle.directory, 4, 1),
  };
  if (!valid(raw, pid))
    throw new ProcessError(ProcessErrno.SRCH, "process incarnation was collected");
  return state;
}
/** Only generation-captured entries escape enumeration; unrelated collection is harmless. */
export function isCollectedProcess(error: unknown): error is ProcessError {
  return (
    error instanceof ProcessError &&
    (error.errno === ProcessErrno.SRCH || error.errno === ProcessErrno.CHILD)
  );
}
export function* directoryProcesses(
  directory: SharedArrayBuffer,
): Generator<ReturnType<typeof directoryState>> {
  for (let slot = 0; slot < directoryCapacity(directory); slot++) {
    const pid = identity(row(directory, slot));
    if (!pid) continue;
    try {
      yield directoryState({ directory, slot, pid });
    } catch (error) {
      if (!isCollectedProcess(error)) throw error;
    }
  }
}
export function* directoryGroups(
  directory: SharedArrayBuffer,
): Generator<ReturnType<typeof directoryJob>> {
  for (let slot = 0; slot < directoryCapacity(directory); slot++) {
    const raw = row(directory, slot, true),
      token = atomicsLoad(raw, 0),
      id = Number(token >> 32n);
    if (!id) continue;
    try {
      if (
        (token & 0xffffffffn) === 3n ||
        ((token & 0xffffffffn) === 1n && controlLoad(cells(raw, id, 4)) < 0)
      ) {
        finishDirectoryJob(directory, slot, id);
        continue;
      }
      if ((token & 0xffffffffn) === 1n) yield directoryJob(directory, slot, id);
    } catch (error) {
      if (!isCollectedProcess(error)) throw error;
    }
  }
}
export function findDirectoryJob(
  directory: SharedArrayBuffer,
  id: number,
): ReturnType<typeof directoryJob> | undefined {
  for (let slot = 0; slot < directoryCapacity(directory); slot++) {
    const raw = row(directory, slot, true),
      token = atomicsLoad(raw, 0),
      current = Number(token >> 32n);
    if (!current) continue;
    try {
      if (
        (token & 0xffffffffn) === 3n ||
        ((token & 0xffffffffn) === 1n && controlLoad(cells(raw, current, 4)) < 0)
      ) {
        finishDirectoryJob(directory, slot, current);
        continue;
      }
      if ((token & 0xffffffffn) === 1n && current === id)
        return directoryJob(directory, slot, current);
    } catch (error) {
      if (!isCollectedProcess(error)) throw error;
    }
  }
  return undefined;
}
/** Retiring ancestors remain traversable until every incoming link has been forwarded. */
function directoryParent(
  directory: SharedArrayBuffer,
  pid: number,
  retiringOnly = false,
): number | undefined {
  for (let slot = 0; slot < directoryCapacity(directory); slot++) {
    const raw = row(directory, slot),
      token = atomicsLoad(raw, 0);
    if (
      Number(token >> 32n) !== pid ||
      ((token & 0xffffffffn) !== 1n && (token & 0xffffffffn) !== 3n)
    )
      continue;
    if (retiringOnly && (token & 0xffffffffn) === 1n) return 0;
    try {
      const edge = controlLoad(cells(raw, pid, 73));
      if (atomicsLoad(raw, 0) !== token) return undefined;
      return edge < 0 ? -edge - 1 : edge;
    } catch (error) {
      if (!isCollectedProcess(error)) throw error;
    }
  }
  return undefined;
}
export function directoryControls(
  directory: SharedArrayBuffer,
  first: () => number,
  caller: number,
  retiringOnly = false,
): boolean {
  // A vanished intermediate row implies forwarding progress. Restart from a live source
  // rather than treating that transient gap as failed authorization.
  for (let attempt = 0; attempt <= directoryCapacity(directory); attempt++) {
    let pid = first();
    const seen = new SetConstructor<number>();
    let missing = false;
    while (pid !== 0 && !setHas(seen, pid)) {
      if (pid === caller) return true;
      setAdd(seen, pid);
      const parent = directoryParent(directory, pid, retiringOnly);
      if (parent === undefined) {
        missing = true;
        break;
      }
      pid = parent;
    }
    if (!missing) return false;
  }
  return false;
}
export function reserveDirectoryProcess(
  handle: DirectoryHandle,
  pid: number,
  parentPid: number,
  job: number,
  ownerPid: number,
  jobSlot?: number,
  foreground = true,
  jobLifetime: JobLifetime = "independent",
): DirectoryHandle {
  let created: ReturnType<typeof allocate> | undefined;
  let reserved: ReturnType<typeof allocate> | undefined;
  let joined: TaggedCells | undefined;
  try {
    let group: { slot: number; rootPid: number };
    if (jobSlot === undefined) {
      const rootPid = parentPid === 0 ? pid : directoryState(handle).rootPid;
      created = allocate(handle.directory, job, true);
      const raw = created.raw;
      for (let i = 1; i < typedArrayLength(raw); i++) atomicsStore(raw, i, packedControl(job, 0));
      atomicsStore(raw, 1, packedControl(job, ownerPid));
      atomicsStore(raw, 2, packedControl(job, pid));
      atomicsStore(raw, 3, BigInt(pid) << 3n);
      atomicsStore(raw, 4, packedControl(job, 1));
      atomicsStore(raw, 5, packedControl(job, Number(foreground)));
      atomicsStore(raw, 6, packedControl(job, ownerPid));
      atomicsStore(raw, 7, packedControl(job, rootPid));
      atomicsStore(raw, 8, packedControl(job, jobLifetime === "caller-fatal" ? 1 : 0));
      group = { slot: created.slot, rootPid };
    } else {
      const existing = directoryJob(handle.directory, jobSlot, job);
      checkDirectoryJobAdmission(handle.directory, existing);
      for (;;) {
        const count = controlLoad(existing.pending);
        if (count <= 0)
          throw new ProcessError(ProcessErrno.CHILD, "job has completed or been collected");
        if (controlCas(existing.pending, 0, count, count + 1) === count) break;
      }
      joined = existing.pending;
      group = existing;
    }
    reserved = allocate(handle.directory, pid);
    const raw = reserved.raw;
    for (let i = 1; i < typedArrayLength(raw); i++) atomicsStore(raw, i, packedControl(pid, 0));
    atomicsStore(raw, 1, packedControl(pid, parentPid));
    atomicsStore(raw, 2, packedControl(pid, job));
    atomicsStore(raw, 73, packedControl(pid, parentPid));
    atomicsStore(raw, 74, packedControl(pid, group.rootPid));
    atomicsStore(raw, 75, packedControl(pid, group.slot));
    atomicsStore(raw, 5, BigInt(pid) << 3n);
    // A new job stays private until its leader owns an initialized process row.
    // No fallible allocation remains once other workers can join the published job.
    if (created) atomicsStore(created.raw, 0, packedControl(job, 1));
    atomicsStore(raw, 0, packedControl(pid, 1));
    return { directory: handle.directory, slot: reserved.slot, pid };
  } catch (error) {
    if (reserved) atomicsCompareExchange(reserved.raw, 0, packedControl(pid, 2), 0n);
    if (created) atomicsCompareExchange(created.raw, 0, packedControl(job, 2), 0n);
    else joined?.add(0, -1);
    throw error;
  }
}
export function wakeDirectory(directory: SharedArrayBuffer): void {
  const wake = new Int32ArrayConstructor(directory, 4, 1);
  atomicsAdd(wake, 0, 1);
  atomicsNotify(wake, 0);
}
export function confirmDirectoryProcess(handle: DirectoryHandle): void {
  const state = directoryState(handle);
  const outcome = readOutcome(state.signals.outcome);
  if (!outcome) throw new Error("cannot confirm a running process");
  // Cache the typed leader outcome before a consuming wait can recycle its process row.
  if (state.pid === state.jobLeaderPid) claimOutcome(state.jobOutcome, outcome);
  controlStore(state.confirmed, 0, 1);
  if (controlCas(state.jobConfirmed, 0, 0, 1) === 0) state.jobPending.add(0, -1);
  retireOrphans(handle);
  wakeDirectory(handle.directory);
}
function find(directory: SharedArrayBuffer, pid: number): DirectoryHandle | undefined {
  for (let slot = 0; slot < directoryCapacity(directory); slot++)
    if (identity(row(directory, slot)) === pid) return { directory, slot, pid };
  return undefined;
}
function settleJobLifetime(directory: SharedArrayBuffer, slot: number): boolean {
  try {
    const group = directoryJob(directory, slot);
    if (controlLoad(group.lifetime) !== 1) return false;
    const owner = find(directory, group.ownerPid);
    if (!owner) throw new Error("owned job lost its owner identity");
    const outcome = readOutcome(directoryState(owner).signals.outcome);
    if (!outcome) return false;
    const next = outcome.kind === "signaled" ? 3 : 2;
    if (controlCas(group.lifetime, 0, 1, next) !== 1) return false;
    if (next === 3) signalDirectoryJob(directory, group.id);
    wakeDirectory(directory);
    return true;
  } catch (error) {
    if (isCollectedProcess(error)) return false;
    throw error;
  }
}
function signalDirectoryJob(directory: SharedArrayBuffer, job: number): void {
  const slots = directorySlots(directory);
  for (let index = 0; index < slots.length; index++)
    signalDirectoryMember(directory, slots[index]!, job);
}
function signalDirectoryMember(directory: SharedArrayBuffer, slot: number, job: number): void {
  try {
    const state = directoryState({ directory, slot, pid: identity(row(directory, slot)) });
    if (state.job === job) requestSignal(state.signals, 9);
  } catch (error) {
    if (!isCollectedProcess(error)) throw error;
  }
}
/** Shared reservations must observe owner death even before their spawn notice is admitted. */
export function settleDirectoryJobLifetimes(directory: SharedArrayBuffer): void {
  let changed: boolean;
  do {
    changed = false;
    const jobs = directoryJobs(directory);
    for (let index = 0; index < jobs.length; index++)
      changed = settleJobLifetime(directory, jobs[index]!) || changed;
  } while (changed);
}
export function checkDirectoryJobAdmission(
  directory: SharedArrayBuffer,
  group: ReturnType<typeof directoryJob>,
): void {
  settleDirectoryJobLifetimes(directory);
  if (controlLoad(group.lifetime) === 3)
    throw new ProcessError(ProcessErrno.CHILD, "owned job is closing");
}
/** A collector freezes its forwarding edge before moving descendants. A frozen edge is
 * a shared, helpable dependency: its parent cannot be freed until that collection finishes.
 * Consequently a suspended helper cannot later reinstall a freed ancestor: all CAS sources
 * naming its collected child have already disappeared before that child's slot is freed. */
function finishCollection(directory: SharedArrayBuffer, slot: number, pid: number): void {
  // Explicit frames keep a full-capacity chain of suspended collectors off the JS stack.
  const pending = [{ slot, pid }];
  while (pending.length) {
    const frame = pending[pending.length - 1]!;
    const dependency = finishCollectionStep(directory, frame.slot, frame.pid);
    if (dependency) arrayAppend(pending, dependency);
    else pending.length--;
  }
}
function finishCollectionStep(
  directory: SharedArrayBuffer,
  slot: number,
  pid: number,
): { slot: number; pid: number } | undefined {
  const raw = row(directory, slot),
    retiring = packedControl(pid, 3);
  if (atomicsLoad(raw, 0) !== retiring) return;
  const forwarding = cells(raw, pid, 73);
  let frozen: number;
  try {
    for (;;) {
      if (atomicsLoad(raw, 0) !== retiring) return;
      const previous = controlLoad(forwarding);
      if (previous < 0) {
        frozen = previous;
        break;
      }
      const next = -(previous + 1);
      if (controlCas(forwarding, 0, previous, next) === previous) {
        frozen = next;
        break;
      }
    }
  } catch (error) {
    if (error instanceof ProcessError && error.errno === ProcessErrno.SRCH) return;
    throw error;
  }
  const parent = -frozen - 1;
  for (;;) {
    if (atomicsLoad(raw, 0) !== retiring) return;
    let changed = false;
    for (let childSlot = 0; childSlot < directoryCapacity(directory); childSlot++) {
      const child = row(directory, childSlot),
        token = atomicsLoad(child, 0);
      if (token === 0n || childSlot === slot) continue;
      const childPid = Number(token >> 32n),
        phase = Number(token & 0xffffffffn);
      if (phase !== 1 && phase !== 3) continue;
      const edge = cells(child, childPid, 73);
      try {
        const current = controlLoad(edge);
        if (current === pid) {
          controlCas(edge, 0, pid, parent);
          changed = true;
        } else if (current === -(pid + 1) && phase === 3) {
          // Help the descendant whose frozen forwarding edge pins this process row.
          return { slot: childSlot, pid: childPid };
        }
      } catch (error) {
        if (!(error instanceof ProcessError) || error.errno !== ProcessErrno.SRCH) throw error;
      }
    }
    for (let jobSlot = 0; jobSlot < directoryCapacity(directory); jobSlot++) {
      const jobRaw = row(directory, jobSlot, true),
        id = identity(jobRaw);
      if (!id) continue;
      try {
        controlCas(cells(jobRaw, id, 6), 0, pid, parent);
      } catch (error) {
        if (!(error instanceof ProcessError) || error.errno !== ProcessErrno.SRCH) throw error;
      }
    }
    if (changed) continue;
    // No positive link or frozen forwarding dependency can now introduce a new link to pid.
    atomicsCompareExchange(raw, 0, retiring, 0n);
    wakeDirectory(directory);
    return;
  }
}

export function collectDirectoryProcess(handle: DirectoryHandle): ProcessExit {
  settleDirectoryJobLifetimes(handle.directory);
  // Individual collection can race an already-sealed job. Only this process's
  // captured identity and safety fences are needed; the job header may be retiring.
  const raw = row(handle.directory, handle.slot);
  if (!valid(raw, handle.pid))
    throw new ProcessError(ProcessErrno.CHILD, "child was already collected");
  if (!controlLoad(cells(raw, handle.pid, 71)) || !controlLoad(cells(raw, handle.pid, 72)))
    throw new ProcessError(ProcessErrno.AGAIN, "child has not exited safely");
  const result = readOutcome(
    new OutcomeCell(typedArraySubarray(raw, 5, 6), handle.pid, validity(raw, handle.pid)),
  )!;
  if (
    atomicsCompareExchange(raw, 0, packedControl(handle.pid, 1), packedControl(handle.pid, 3)) !==
    packedControl(handle.pid, 1)
  )
    throw new ProcessError(ProcessErrno.CHILD, "child was already collected");
  finishCollection(handle.directory, handle.slot, handle.pid);
  return result;
}
/** Recover any sealed job, including a claimant suspended before publishing lifecycle 3. */
export function helpDirectoryJobs(directory: SharedArrayBuffer): void {
  for (let slot = 0; slot < directoryCapacity(directory); slot++) {
    const raw = row(directory, slot, true),
      token = atomicsLoad(raw, 0),
      phase = token & 0xffffffffn;
    if (!token || (phase !== 1n && phase !== 3n)) continue;
    const id = Number(token >> 32n);
    try {
      if (phase === 3n || controlLoad(cells(raw, id, 4)) < 0)
        finishDirectoryJob(directory, slot, id);
    } catch (error) {
      if (!isCollectedProcess(error)) throw error;
    }
  }
}
/** The negative pending count is the durable consuming claim. Every subsequent step is
 * helpable without the original worker or its final notification to the host. */
function finishDirectoryJob(directory: SharedArrayBuffer, slot: number, job: number): void {
  const group = row(directory, slot, true),
    ready = packedControl(job, 1),
    retiring = packedControl(job, 3);
  let token = atomicsLoad(group, 0);
  if (token === ready) {
    // A helper may have retired and reused the header after our lifecycle read.
    if (atomicsLoad(group, 4) !== packedControl(job, -1)) return;
    atomicsCompareExchange(group, 0, ready, retiring);
    token = atomicsLoad(group, 0);
  }
  if (token !== retiring) return;
  const members = new MapConstructor<number, { slot: number; parent: number }>();
  for (let processSlot = 0; processSlot < directoryCapacity(directory); processSlot++) {
    const raw = row(directory, processSlot),
      identity = atomicsLoad(raw, 0),
      pid = Number(identity >> 32n),
      phase = identity & 0xffffffffn;
    if (!pid || (phase !== 1n && phase !== 3n)) continue;
    try {
      if (controlLoad(cells(raw, pid, 2)) !== job) continue;
      if (
        phase === 1n &&
        atomicsCompareExchange(raw, 0, identity, packedControl(pid, 3)) !== identity
      )
        continue;
      const forwarding = cells(raw, pid, 73);
      for (;;) {
        if (atomicsLoad(raw, 0) !== packedControl(pid, 3)) break;
        const parent = controlLoad(forwarding);
        if (parent < 0 || controlCas(forwarding, 0, parent, -(parent + 1)) === parent) {
          mapSet(members, pid, { slot: processSlot, parent: parent < 0 ? -parent - 1 : parent });
          break;
        }
      }
    } catch (error) {
      if (!isCollectedProcess(error)) throw error;
    }
  }
  const forwarded = new MapConstructor<number, number>();
  function destination(pid: number): number {
    const trail: number[] = [];
    while (mapHas(members, pid) && !mapHas(forwarded, pid)) {
      arrayAppend(trail, pid);
      pid = mapGet(members, pid)!.parent;
    }
    const parent = mapGet(forwarded, pid) ?? pid;
    for (let index = 0; index < trail.length; index++) mapSet(forwarded, trail[index]!, parent);
    return parent;
  }
  // One pass forwards a whole retired job, rather than one full-directory scan per member.
  // Outside collectors whose frozen edges pin a member are helped before freeing that row.
  for (;;) {
    if (atomicsLoad(group, 0) !== retiring) return;
    let changed = false;
    for (let processSlot = 0; processSlot < directoryCapacity(directory); processSlot++) {
      const raw = row(directory, processSlot),
        identity = atomicsLoad(raw, 0),
        pid = Number(identity >> 32n),
        phase = identity & 0xffffffffn;
      if (!pid || mapHas(members, pid) || (phase !== 1n && phase !== 3n)) continue;
      try {
        const edge = cells(raw, pid, 73),
          parent = controlLoad(edge);
        if (mapHas(members, parent)) {
          controlCas(edge, 0, parent, destination(parent));
          changed = true;
        } else if (parent < 0 && mapHas(members, -parent - 1) && phase === 3n) {
          finishCollection(directory, processSlot, pid);
          changed = true;
        }
      } catch (error) {
        if (!isCollectedProcess(error)) throw error;
      }
    }
    for (let jobSlot = 0; jobSlot < directoryCapacity(directory); jobSlot++) {
      const raw = row(directory, jobSlot, true),
        token = atomicsLoad(raw, 0),
        id = Number(token >> 32n),
        phase = token & 0xffffffffn;
      if (!id || (phase !== 1n && phase !== 3n)) continue;
      try {
        const edge = cells(raw, id, 6),
          parent = controlLoad(edge);
        if (mapHas(members, parent)) {
          controlCas(edge, 0, parent, destination(parent));
          changed = true;
        }
      } catch (error) {
        if (!isCollectedProcess(error)) throw error;
      }
    }
    if (!changed) break;
  }
  // Once no outside incoming edge can recreate a member link, collapse the frozen
  // internal edges too. A helper resuming after partial freeing can then reconstruct
  // the same outside destination without any history of already-freed members.
  mapForEach(members, (member, pid) => {
    const parent = destination(pid);
    if (parent === member.parent) return;
    try {
      controlCas(
        cells(row(directory, member.slot), pid, 73),
        0,
        -(member.parent + 1),
        -(parent + 1),
      );
    } catch (error) {
      if (!isCollectedProcess(error)) throw error;
    }
  });
  mapForEach(members, (member, pid) => {
    atomicsCompareExchange(row(directory, member.slot), 0, packedControl(pid, 3), 0n);
  });
  atomicsCompareExchange(group, 0, retiring, 0n);
  wakeDirectory(directory);
}
export function collectDirectoryJob(
  directory: SharedArrayBuffer,
  slot: number,
  job: number,
): ProcessExit {
  let result: ProcessExit;
  try {
    const group = directoryJob(directory, slot, job);
    const outcome = readOutcome(group.outcome);
    const pending = controlLoad(group.pending);
    if (pending < 0) throw new ProcessError(ProcessErrno.CHILD, "job was already collected");
    if (!outcome || pending !== 0)
      throw new ProcessError(ProcessErrno.AGAIN, "job has not become empty");
    result = outcome;
  } catch (error) {
    if (isCollectedProcess(error))
      throw new ProcessError(ProcessErrno.CHILD, "job was already collected");
    throw error;
  }
  // This tagged CAS is the consuming linearization point. Once it succeeds, a
  // helper may immediately free/reuse the header, so a post-CAS live-row check
  // would discard our successful claim. The complete expected word rejects a
  // competing collector and every replacement incarnation without touching it.
  const pending = typedArraySubarray(row(directory, slot, true), 4, 5);
  if (
    atomicsCompareExchange(pending, 0, packedControl(job, 0), packedControl(job, -1)) !==
    packedControl(job, 0)
  ) {
    throw new ProcessError(ProcessErrno.CHILD, "job was already collected");
  }
  finishDirectoryJob(directory, slot, job);
  return result;
}

function retireOrphans(handle: DirectoryHandle): void {
  for (let slot = 0; slot < directoryCapacity(handle.directory); slot++) {
    const pid = identity(row(handle.directory, slot));
    if (!pid) continue;
    try {
      const state = directoryState({ directory: handle.directory, slot, pid });
      if (!controlLoad(state.confirmed) || !controlLoad(state.jobConfirmed)) continue;
      const parentHandle = find(handle.directory, state.parentPid);
      let parentLive = false;
      if (parentHandle) {
        try {
          parentLive = !readOutcome(directoryState(parentHandle).signals.outcome);
        } catch (error) {
          if (!isCollectedProcess(error)) throw error;
        }
      }
      if (!parentLive && state.parentPid !== 0)
        collectDirectoryProcess({ directory: handle.directory, slot: state.slot, pid: state.pid });
    } catch (error) {
      if (!isCollectedProcess(error)) throw error;
    }
  }
}
