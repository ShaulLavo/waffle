import { TaggedCells, packedControl, controlCas, controlLoad, controlStore } from "./control";
import { OutcomeCell, claimOutcome, readOutcome } from "./outcome";
import { ProcessErrno, ProcessError, type ProcessExit } from "./types";
import type { SignalTransport } from "./signals";

const HEADER_BYTES = 32;
const PROCESS_WORDS = 76;
const JOB_WORDS = 8;
export interface DirectoryHandle { readonly directory: SharedArrayBuffer; readonly slot: number; readonly pid: number }
export const DirectoryOffset = Object.freeze({ identity: 0, parent: 1, job: 2, interrupt: 3, requested: 4, outcome: 5, signals: 6, confirmed: 71, jobConfirmed: 72, controlParent: 73, root: 74, jobSlot: 75 });
export function directoryCapacity(directory: SharedArrayBuffer): number {
  const capacity = (directory.byteLength - HEADER_BYTES) / ((PROCESS_WORDS + JOB_WORDS) * 8);
  if (!Number.isInteger(capacity) || capacity < 1) throw new TypeError("invalid process directory");
  return capacity;
}
export function createDirectory(capacity: number): SharedArrayBuffer {
  const directory = new SharedArrayBuffer(HEADER_BYTES + capacity * (PROCESS_WORDS + JOB_WORDS) * 8);
  new Uint32Array(directory, 8, 2).set(crypto.getRandomValues(new Uint32Array(2)));
  return directory;
}
function row(directory: SharedArrayBuffer, slot: number, job = false): BigInt64Array {
  const capacity = directoryCapacity(directory);
  if (!Number.isInteger(slot) || slot < 0 || slot >= capacity) throw new TypeError("invalid process directory slot");
  return new BigInt64Array(directory, HEADER_BYTES + (job ? capacity * PROCESS_WORDS + slot * JOB_WORDS : slot * PROCESS_WORDS) * 8, job ? JOB_WORDS : PROCESS_WORDS);
}
function cells(raw: BigInt64Array, id: number, offset: number, count = 1): TaggedCells { return new TaggedCells(raw.subarray(offset, offset + count), id); }
function identity(raw: BigInt64Array): number { const value = Atomics.load(raw, 0); return (value & 0xffffffffn) === 1n ? Number(value >> 32n) : 0; }
function valid(raw: BigInt64Array, id: number): boolean { return Atomics.load(raw, 0) === packedControl(id, 1); }
function allocate(directory: SharedArrayBuffer, id: number, job = false): { slot: number; raw: BigInt64Array } {
  for (let slot = 0; slot < directoryCapacity(directory); slot++) {
    const raw = row(directory, slot, job);
    if (!job) {
      const current = Atomics.load(raw, 0);
      if ((current & 0xffffffffn) === 3n) finishCollection(directory, slot, Number(current >> 32n));
    }
    if (Atomics.compareExchange(raw, 0, 0n, packedControl(id, 2)) === 0n) return { slot, raw };
  }
  throw new ProcessError(ProcessErrno.AGAIN, job ? "job directory is full" : "process directory is full");
}
export function directorySlots(directory: SharedArrayBuffer): number[] {
  return Array.from({ length: directoryCapacity(directory) }, (_, slot) => slot).filter(slot => identity(row(directory, slot)) !== 0);
}
export function directoryJobs(directory: SharedArrayBuffer): number[] {
  return Array.from({ length: directoryCapacity(directory) }, (_, slot) => slot).filter(slot => identity(row(directory, slot, true)) !== 0);
}
export function directoryJob(directory: SharedArrayBuffer, slot: number, expected?: number) {
  const raw = row(directory, slot, true), id = expected ?? identity(raw);
  if (!id || !valid(raw, id)) throw new ProcessError(ProcessErrno.CHILD, "job has been collected");
  const data = new TaggedCells(raw, id);
  const leaderPid = data.load(2);
  const state = {
    slot, id, ownerPid: data.load(1), leaderPid, foreground: data.load(5) !== 0,
    controlParent: cells(raw, id, 6), rootPid: data.load(7), pending: cells(raw, id, 4),
    outcome: new OutcomeCell(raw.subarray(3, 4), leaderPid, () => valid(raw, id)),
  };
  if (!valid(raw, id)) throw new ProcessError(ProcessErrno.CHILD, "job has been collected");
  return state;
}
export function directoryState(handle: DirectoryHandle, slot = handle.slot) {
  const raw = row(handle.directory, slot), pid = slot === handle.slot ? handle.pid : identity(raw);
  if (!pid || !valid(raw, pid)) throw new ProcessError(ProcessErrno.SRCH, "process incarnation was collected");
  const data = new TaggedCells(raw, pid), job = data.load(2), jobSlot = data.load(75);
  const group = directoryJob(handle.directory, jobSlot, job);
  const state = {
    slot, pid, parentPid: data.load(1), job, jobSlot, rootPid: data.load(74), controlParent: cells(raw, pid, 73),
    jobOwner: group.ownerPid, jobLeaderPid: group.leaderPid, jobForeground: group.foreground,
    jobOutcome: group.outcome, jobControlParent: group.controlParent, jobPending: group.pending,
    confirmed: cells(raw, pid, 71), jobConfirmed: cells(raw, pid, 72),
    signals: { interrupt: cells(raw, pid, 3), requestedSignal: cells(raw, pid, 4),
      outcome: new OutcomeCell(raw.subarray(5, 6), pid, () => valid(raw, pid)), signalState: cells(raw, pid, 6, 65) } satisfies SignalTransport,
    wake: new Int32Array(handle.directory, 4, 1),
  };
  if (!valid(raw, pid)) throw new ProcessError(ProcessErrno.SRCH, "process incarnation was collected");
  return state;
}
export function reserveDirectoryProcess(handle: DirectoryHandle, pid: number, parentPid: number, job: number, ownerPid: number, jobSlot?: number, foreground = true): DirectoryHandle {
  let group: ReturnType<typeof directoryJob>;
  let created = false;
  if (jobSlot === undefined) {
    const reserved = allocate(handle.directory, job, true);
    const raw = reserved.raw;
    for (let i = 1; i < raw.length; i++) Atomics.store(raw, i, packedControl(job, 0));
    Atomics.store(raw, 1, packedControl(job, ownerPid));
    Atomics.store(raw, 2, packedControl(job, pid));
    Atomics.store(raw, 3, BigInt(pid) << 2n);
    Atomics.store(raw, 4, packedControl(job, 1));
    Atomics.store(raw, 5, packedControl(job, Number(foreground)));
    Atomics.store(raw, 6, packedControl(job, ownerPid));
    Atomics.store(raw, 7, packedControl(job, parentPid === 0 ? pid : directoryState(handle).rootPid));
    Atomics.store(raw, 0, packedControl(job, 1));
    group = directoryJob(handle.directory, reserved.slot, job);
    created = true;
  } else {
    group = directoryJob(handle.directory, jobSlot, job);
    for (;;) {
      const count = controlLoad(group.pending);
      if (count <= 0) throw new ProcessError(ProcessErrno.CHILD, "job has completed or been collected");
      if (controlCas(group.pending, 0, count, count + 1) === count) break;
    }
  }
  let reserved: ReturnType<typeof allocate>;
  try { reserved = allocate(handle.directory, pid); }
  catch (error) {
    group.pending.add(0, -1);
    if (created) Atomics.compareExchange(row(handle.directory, group.slot, true), 0, packedControl(job, 1), 0n);
    throw error;
  }
  const raw = reserved.raw;
  for (let i = 1; i < raw.length; i++) Atomics.store(raw, i, packedControl(pid, 0));
  for (const [index, value] of [[1, parentPid], [2, job], [73, parentPid], [74, group.rootPid], [75, group.slot]]) Atomics.store(raw, index!, packedControl(pid, value!));
  Atomics.store(raw, 5, BigInt(pid) << 2n);
  Atomics.store(raw, 0, packedControl(pid, 1));
  return { directory: handle.directory, slot: reserved.slot, pid };
}
export function wakeDirectory(directory: SharedArrayBuffer): void { const wake = new Int32Array(directory, 4, 1); Atomics.add(wake, 0, 1); Atomics.notify(wake, 0); }
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
  for (const slot of directorySlots(directory)) if (identity(row(directory, slot)) === pid) return { directory, slot, pid };
  return undefined;
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
    if (dependency) pending.push(dependency);
    else pending.pop();
  }
}
function finishCollectionStep(directory: SharedArrayBuffer, slot: number, pid: number): { slot: number; pid: number } | undefined {
  const raw = row(directory, slot), retiring = packedControl(pid, 3);
  if (Atomics.load(raw, 0) !== retiring) return;
  const forwarding = cells(raw, pid, 73);
  let frozen: number;
  try {
    for (;;) {
      if (Atomics.load(raw, 0) !== retiring) return;
      const previous = controlLoad(forwarding);
      if (previous < 0) { frozen = previous; break; }
      const next = -(previous + 1);
      if (controlCas(forwarding, 0, previous, next) === previous) { frozen = next; break; }
    }
  } catch (error) {
    if (error instanceof ProcessError && error.errno === ProcessErrno.SRCH) return;
    throw error;
  }
  const parent = -frozen - 1;
  for (;;) {
    if (Atomics.load(raw, 0) !== retiring) return;
    let changed = false;
    for (let childSlot = 0; childSlot < directoryCapacity(directory); childSlot++) {
      const child = row(directory, childSlot), token = Atomics.load(child, 0);
      if (token === 0n || childSlot === slot) continue;
      const childPid = Number(token >> 32n), phase = Number(token & 0xffffffffn);
      if (phase !== 1 && phase !== 3) continue;
      const edge = cells(child, childPid, 73);
      try {
        const current = controlLoad(edge);
        if (current === pid) { controlCas(edge, 0, pid, parent); changed = true; }
        else if (current === -(pid + 1) && phase === 3) {
          // Help the descendant whose frozen forwarding edge pins this process row.
          return { slot: childSlot, pid: childPid };
        }
      } catch (error) {
        if (!(error instanceof ProcessError) || error.errno !== ProcessErrno.SRCH) throw error;
      }
    }
    for (const jobSlot of directoryJobs(directory)) {
      const jobRaw = row(directory, jobSlot, true), id = identity(jobRaw);
      if (!id) continue;
      try { controlCas(cells(jobRaw, id, 6), 0, pid, parent); }
      catch (error) { if (!(error instanceof ProcessError) || error.errno !== ProcessErrno.SRCH) throw error; }
    }
    if (changed) continue;
    // No positive link or frozen forwarding dependency can now introduce a new link to pid.
    Atomics.compareExchange(raw, 0, retiring, 0n);
    wakeDirectory(directory);
    return;
  }
}

export function collectDirectoryProcess(handle: DirectoryHandle): ProcessExit {
  const state = directoryState(handle);
  if (!controlLoad(state.confirmed) || !controlLoad(state.jobConfirmed)) throw new ProcessError(ProcessErrno.AGAIN, "child has not exited safely");
  const result = readOutcome(state.signals.outcome)!;
  const raw = row(handle.directory, handle.slot);
  if (Atomics.compareExchange(raw, 0, packedControl(handle.pid, 1), packedControl(handle.pid, 3)) !== packedControl(handle.pid, 1)) throw new ProcessError(ProcessErrno.CHILD, "child was already collected");
  finishCollection(handle.directory, handle.slot, handle.pid);
  return result;
}
export function collectDirectoryJob(directory: SharedArrayBuffer, slot: number, job: number): ProcessExit {
  const group = directoryJob(directory, slot, job);
  const result = readOutcome(group.outcome);
  if (!result || controlLoad(group.pending) !== 0) throw new ProcessError(ProcessErrno.AGAIN, "job has not become empty");
  if (controlCas(group.pending, 0, 0, -1) !== 0) throw new ProcessError(ProcessErrno.CHILD, "job was already collected");
  for (const processSlot of directorySlots(directory)) {
    const pid = identity(row(directory, processSlot));
    if (!pid) continue;
    const handle = { directory, slot: processSlot, pid };
    try {
      const state = directoryState(handle);
      if (state.job === job) collectDirectoryProcess(handle);
    } catch (error) {
      // An individual collector may have won this captured incarnation. Never reinterpret
      // another occupant, and never abandon the winning job claim with pending == -1.
      if (!(error instanceof ProcessError) || (error.errno !== ProcessErrno.SRCH && error.errno !== ProcessErrno.CHILD)) throw error;
    }
  }
  Atomics.compareExchange(row(directory, slot, true), 0, packedControl(job, 1), 0n);
  wakeDirectory(directory);
  return result;
}
function retireOrphans(handle: DirectoryHandle): void {
  for (const slot of directorySlots(handle.directory)) {
    const pid = identity(row(handle.directory, slot)), child = { directory: handle.directory, slot, pid };
    const state = directoryState(child);
    if (!controlLoad(state.confirmed) || !controlLoad(state.jobConfirmed)) continue;
    const parentHandle = find(handle.directory, state.parentPid);
    const parentLive = parentHandle && !readOutcome(directoryState(parentHandle).signals.outcome);
    if (!parentLive && state.parentPid !== 0) collectDirectoryProcess(child);
  }
}
