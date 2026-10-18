import { TaggedCells, packedControl, controlCas, controlLoad, controlStore, type CellValidity } from "./control.js";
import { OutcomeCell, claimOutcome, readOutcome } from "./outcome.js";
import { ProcessErrno, ProcessError, type ProcessExit } from "./types.js";
import type { SignalTransport } from "./signals.js";

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
function validity(raw: BigInt64Array, id: number): CellValidity { return { buffer: raw.buffer as SharedArrayBuffer, byteOffset: raw.byteOffset, id }; }
function cells(raw: BigInt64Array, id: number, offset: number, count = 1): TaggedCells { return new TaggedCells(raw.subarray(offset, offset + count), id); }
// Escaping views require a live row; private retirement helpers intentionally retain
// their tagged access while forwarding lifecycle-3 ancestry.
function liveCells(raw: BigInt64Array, id: number, offset: number, count = 1): TaggedCells {
  return new TaggedCells(raw.subarray(offset, offset + count), id, validity(raw, id));
}
function identity(raw: BigInt64Array): number { const value = Atomics.load(raw, 0); return (value & 0xffffffffn) === 1n ? Number(value >> 32n) : 0; }
function valid(raw: BigInt64Array, id: number): boolean { return Atomics.load(raw, 0) === packedControl(id, 1); }
function allocate(directory: SharedArrayBuffer, id: number, job = false): { slot: number; raw: BigInt64Array } {
  helpDirectoryJobs(directory);
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
    controlParent: liveCells(raw, id, 6), rootPid: data.load(7), pending: liveCells(raw, id, 4),
    outcome: new OutcomeCell(raw.subarray(3, 4), leaderPid, validity(raw, id)),
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
    slot, pid, parentPid: data.load(1), job, jobSlot, rootPid: data.load(74), controlParent: liveCells(raw, pid, 73),
    jobOwner: group.ownerPid, jobLeaderPid: group.leaderPid, jobForeground: group.foreground,
    jobOutcome: group.outcome, jobControlParent: group.controlParent, jobPending: group.pending,
    confirmed: liveCells(raw, pid, 71), jobConfirmed: liveCells(raw, pid, 72),
    signals: { interrupt: liveCells(raw, pid, 3), requestedSignal: liveCells(raw, pid, 4),
      outcome: new OutcomeCell(raw.subarray(5, 6), pid, validity(raw, pid)), signalState: liveCells(raw, pid, 6, 65) } satisfies SignalTransport,
    wake: new Int32Array(handle.directory, 4, 1),
  };
  if (!valid(raw, pid)) throw new ProcessError(ProcessErrno.SRCH, "process incarnation was collected");
  return state;
}
/** Only generation-captured entries escape enumeration; unrelated collection is harmless. */
export function isCollectedProcess(error: unknown): error is ProcessError {
  return error instanceof ProcessError && (error.errno === ProcessErrno.SRCH || error.errno === ProcessErrno.CHILD);
}
export function* directoryProcesses(directory: SharedArrayBuffer): Generator<ReturnType<typeof directoryState>> {
  for (let slot = 0; slot < directoryCapacity(directory); slot++) {
    const pid = identity(row(directory, slot));
    if (!pid) continue;
    try { yield directoryState({ directory, slot, pid }); }
    catch (error) { if (!isCollectedProcess(error)) throw error; }
  }
}
export function* directoryGroups(directory: SharedArrayBuffer): Generator<ReturnType<typeof directoryJob>> {
  for (let slot = 0; slot < directoryCapacity(directory); slot++) {
    const raw = row(directory, slot, true), token = Atomics.load(raw, 0), id = Number(token >> 32n);
    if (!id) continue;
    try {
      if ((token & 0xffffffffn) === 3n || (token & 0xffffffffn) === 1n && controlLoad(cells(raw, id, 4)) < 0) {
        finishDirectoryJob(directory, slot, id);
        continue;
      }
      if ((token & 0xffffffffn) === 1n) yield directoryJob(directory, slot, id);
    } catch (error) { if (!isCollectedProcess(error)) throw error; }
  }
}
export function findDirectoryJob(directory: SharedArrayBuffer, id: number): ReturnType<typeof directoryJob> | undefined {
  for (const group of directoryGroups(directory)) if (group.id === id) return group;
  return undefined;
}
/** Retiring ancestors remain traversable until every incoming link has been forwarded. */
export function directoryParent(directory: SharedArrayBuffer, pid: number, retiringOnly = false): number | undefined {
  for (let slot = 0; slot < directoryCapacity(directory); slot++) {
    const raw = row(directory, slot), token = Atomics.load(raw, 0);
    if (Number(token >> 32n) !== pid || (token & 0xffffffffn) !== 1n && (token & 0xffffffffn) !== 3n) continue;
    if (retiringOnly && (token & 0xffffffffn) === 1n) return 0;
    try {
      const edge = controlLoad(cells(raw, pid, 73));
      if (Atomics.load(raw, 0) !== token) return undefined;
      return edge < 0 ? -edge - 1 : edge;
    } catch (error) { if (!isCollectedProcess(error)) throw error; }
  }
  return undefined;
}
export function directoryControls(directory: SharedArrayBuffer, first: () => number, caller: number, retiringOnly = false): boolean {
  // A vanished intermediate row implies forwarding progress. Restart from a live source
  // rather than treating that transient gap as failed authorization.
  for (let attempt = 0; attempt <= directoryCapacity(directory); attempt++) {
    let pid = first();
    const seen = new Set<number>();
    let missing = false;
    while (pid !== 0 && !seen.has(pid)) {
      if (pid === caller) return true;
      seen.add(pid);
      const parent = directoryParent(directory, pid, retiringOnly);
      if (parent === undefined) { missing = true; break; }
      pid = parent;
    }
    if (!missing) return false;
  }
  return false;
}
export function reserveDirectoryProcess(handle: DirectoryHandle, pid: number, parentPid: number, job: number, ownerPid: number, jobSlot?: number, foreground = true): DirectoryHandle {
  let created: ReturnType<typeof allocate> | undefined;
  let reserved: ReturnType<typeof allocate> | undefined;
  let joined: TaggedCells | undefined;
  try {
    let group: { slot: number; rootPid: number };
    if (jobSlot === undefined) {
      const rootPid = parentPid === 0 ? pid : directoryState(handle).rootPid;
      created = allocate(handle.directory, job, true);
      const raw = created.raw;
      for (let i = 1; i < raw.length; i++) Atomics.store(raw, i, packedControl(job, 0));
      Atomics.store(raw, 1, packedControl(job, ownerPid));
      Atomics.store(raw, 2, packedControl(job, pid));
      Atomics.store(raw, 3, BigInt(pid) << 2n);
      Atomics.store(raw, 4, packedControl(job, 1));
      Atomics.store(raw, 5, packedControl(job, Number(foreground)));
      Atomics.store(raw, 6, packedControl(job, ownerPid));
      Atomics.store(raw, 7, packedControl(job, rootPid));
      group = { slot: created.slot, rootPid };
    } else {
      const existing = directoryJob(handle.directory, jobSlot, job);
      for (;;) {
        const count = controlLoad(existing.pending);
        if (count <= 0) throw new ProcessError(ProcessErrno.CHILD, "job has completed or been collected");
        if (controlCas(existing.pending, 0, count, count + 1) === count) break;
      }
      joined = existing.pending;
      group = existing;
    }
    reserved = allocate(handle.directory, pid);
    const raw = reserved.raw;
    for (let i = 1; i < raw.length; i++) Atomics.store(raw, i, packedControl(pid, 0));
    for (const [index, value] of [[1, parentPid], [2, job], [73, parentPid], [74, group.rootPid], [75, group.slot]]) Atomics.store(raw, index!, packedControl(pid, value!));
    Atomics.store(raw, 5, BigInt(pid) << 2n);
    // A new job stays private until its leader owns an initialized process row.
    // No fallible allocation remains once other workers can join the published job.
    if (created) Atomics.store(created.raw, 0, packedControl(job, 1));
    Atomics.store(raw, 0, packedControl(pid, 1));
    return { directory: handle.directory, slot: reserved.slot, pid };
  } catch (error) {
    if (reserved) Atomics.compareExchange(reserved.raw, 0, packedControl(pid, 2), 0n);
    if (created) Atomics.compareExchange(created.raw, 0, packedControl(job, 2), 0n);
    else joined?.add(0, -1);
    throw error;
  }
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
  // Individual collection can race an already-sealed job. Only this process's
  // captured identity and safety fences are needed; the job header may be retiring.
  const raw = row(handle.directory, handle.slot);
  if (!valid(raw, handle.pid)) throw new ProcessError(ProcessErrno.CHILD, "child was already collected");
  if (!controlLoad(cells(raw, handle.pid, 71)) || !controlLoad(cells(raw, handle.pid, 72))) throw new ProcessError(ProcessErrno.AGAIN, "child has not exited safely");
  const result = readOutcome(new OutcomeCell(raw.subarray(5, 6), handle.pid, validity(raw, handle.pid)))!;
  if (Atomics.compareExchange(raw, 0, packedControl(handle.pid, 1), packedControl(handle.pid, 3)) !== packedControl(handle.pid, 1)) throw new ProcessError(ProcessErrno.CHILD, "child was already collected");
  finishCollection(handle.directory, handle.slot, handle.pid);
  return result;
}
/** Recover any sealed job, including a claimant suspended before publishing lifecycle 3. */
export function helpDirectoryJobs(directory: SharedArrayBuffer): void {
  for (let slot = 0; slot < directoryCapacity(directory); slot++) {
    const raw = row(directory, slot, true), token = Atomics.load(raw, 0), phase = token & 0xffffffffn;
    if (!token || phase !== 1n && phase !== 3n) continue;
    const id = Number(token >> 32n);
    try { if (phase === 3n || controlLoad(cells(raw, id, 4)) < 0) finishDirectoryJob(directory, slot, id); }
    catch (error) { if (!isCollectedProcess(error)) throw error; }
  }
}
/** The negative pending count is the durable consuming claim. Every subsequent step is
 * helpable without the original worker or its final notification to the host. */
function finishDirectoryJob(directory: SharedArrayBuffer, slot: number, job: number): void {
  const group = row(directory, slot, true), ready = packedControl(job, 1), retiring = packedControl(job, 3);
  let token = Atomics.load(group, 0);
  if (token === ready) {
    if (controlLoad(cells(group, job, 4)) !== -1) return;
    Atomics.compareExchange(group, 0, ready, retiring);
    token = Atomics.load(group, 0);
  }
  if (token !== retiring) return;
  const members = new Map<number, { slot: number; parent: number }>();
  for (let processSlot = 0; processSlot < directoryCapacity(directory); processSlot++) {
    const raw = row(directory, processSlot), identity = Atomics.load(raw, 0), pid = Number(identity >> 32n), phase = identity & 0xffffffffn;
    if (!pid || phase !== 1n && phase !== 3n) continue;
    try {
      if (controlLoad(cells(raw, pid, 2)) !== job) continue;
      if (phase === 1n && Atomics.compareExchange(raw, 0, identity, packedControl(pid, 3)) !== identity) continue;
      const forwarding = cells(raw, pid, 73);
      for (;;) {
        if (Atomics.load(raw, 0) !== packedControl(pid, 3)) break;
        const parent = controlLoad(forwarding);
        if (parent < 0 || controlCas(forwarding, 0, parent, -(parent + 1)) === parent) {
          members.set(pid, { slot: processSlot, parent: parent < 0 ? -parent - 1 : parent });
          break;
        }
      }
    } catch (error) { if (!isCollectedProcess(error)) throw error; }
  }
  const forwarded = new Map<number, number>();
  function destination(pid: number): number {
    const trail: number[] = [];
    while (members.has(pid) && !forwarded.has(pid)) {
      trail.push(pid);
      pid = members.get(pid)!.parent;
    }
    const parent = forwarded.get(pid) ?? pid;
    for (const member of trail) forwarded.set(member, parent);
    return parent;
  }
  // One pass forwards a whole retired job, rather than one full-directory scan per member.
  // Outside collectors whose frozen edges pin a member are helped before freeing that row.
  for (;;) {
    if (Atomics.load(group, 0) !== retiring) return;
    let changed = false;
    for (let processSlot = 0; processSlot < directoryCapacity(directory); processSlot++) {
      const raw = row(directory, processSlot), identity = Atomics.load(raw, 0), pid = Number(identity >> 32n), phase = identity & 0xffffffffn;
      if (!pid || members.has(pid) || phase !== 1n && phase !== 3n) continue;
      try {
        const edge = cells(raw, pid, 73), parent = controlLoad(edge);
        if (members.has(parent)) { controlCas(edge, 0, parent, destination(parent)); changed = true; }
        else if (parent < 0 && members.has(-parent - 1) && phase === 3n) {
          finishCollection(directory, processSlot, pid); changed = true;
        }
      } catch (error) { if (!isCollectedProcess(error)) throw error; }
    }
    for (let jobSlot = 0; jobSlot < directoryCapacity(directory); jobSlot++) {
      const raw = row(directory, jobSlot, true), token = Atomics.load(raw, 0), id = Number(token >> 32n), phase = token & 0xffffffffn;
      if (!id || phase !== 1n && phase !== 3n) continue;
      try {
        const edge = cells(raw, id, 6), parent = controlLoad(edge);
        if (members.has(parent)) { controlCas(edge, 0, parent, destination(parent)); changed = true; }
      } catch (error) { if (!isCollectedProcess(error)) throw error; }
    }
    if (!changed) break;
  }
  // Once no outside incoming edge can recreate a member link, collapse the frozen
  // internal edges too. A helper resuming after partial freeing can then reconstruct
  // the same outside destination without any history of already-freed members.
  for (const [pid, member] of members) {
    const parent = destination(pid);
    if (parent === member.parent) continue;
    try { controlCas(cells(row(directory, member.slot), pid, 73), 0, -(member.parent + 1), -(parent + 1)); }
    catch (error) { if (!isCollectedProcess(error)) throw error; }
  }
  for (const [pid, member] of members) Atomics.compareExchange(row(directory, member.slot), 0, packedControl(pid, 3), 0n);
  Atomics.compareExchange(group, 0, retiring, 0n);
  wakeDirectory(directory);
}
export function collectDirectoryJob(directory: SharedArrayBuffer, slot: number, job: number): ProcessExit {
  const group = directoryJob(directory, slot, job);
  const result = readOutcome(group.outcome);
  if (!result || controlLoad(group.pending) !== 0) throw new ProcessError(ProcessErrno.AGAIN, "job has not become empty");
  if (controlCas(group.pending, 0, 0, -1) !== 0) throw new ProcessError(ProcessErrno.CHILD, "job was already collected");
  finishDirectoryJob(directory, slot, job);
  return result;
}

function retireOrphans(handle: DirectoryHandle): void {
  for (const state of directoryProcesses(handle.directory)) {
    try {
      if (!controlLoad(state.confirmed) || !controlLoad(state.jobConfirmed)) continue;
      const parentHandle = find(handle.directory, state.parentPid);
      let parentLive = false;
      if (parentHandle) {
        try { parentLive = !readOutcome(directoryState(parentHandle).signals.outcome); }
        catch (error) { if (!isCollectedProcess(error)) throw error; }
      }
      if (!parentLive && state.parentPid !== 0) collectDirectoryProcess({ directory: handle.directory, slot: state.slot, pid: state.pid });
    } catch (error) { if (!isCollectedProcess(error)) throw error; }
  }
}
