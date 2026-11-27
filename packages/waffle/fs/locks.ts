import {
  F_RDLCK,
  F_UNLCK,
  F_WRLCK,
  LOCK_EX,
  LOCK_NB,
  LOCK_SH,
  LOCK_UN,
  type FileLockConflict,
  type FileLockRange,
} from "../core/filesystem.js";

const EACCES = 2;
const EAGAIN = 6;
const EDEADLK = 16;
const EINVAL = 28;
const OFD_FLAG_ORIGIN_CLOSED = 2;

type FlockMode = "sh" | "ex";
type RangeType = typeof F_RDLCK | typeof F_WRLCK;

interface FlockEntry {
  mode: FlockMode;
  readonly ofdId: string;
  revision: number;
}

interface RangeLock {
  readonly owner: string;
  readonly sessionOwner: number;
  readonly ofdId: string | undefined;
  readonly pid: number;
  type: RangeType;
  start: number;
  end: number;
}

interface Waiter {
  readonly id: number;
  readonly ino: number;
  readonly owner: string;
  readonly sessionOwner: number;
  readonly blockers: readonly string[];
  readonly trackDeadlock: boolean;
  resolved: boolean;
  readonly wake: () => void;
  readonly cancel: () => void;
}

interface InodeLocks {
  readonly flocks: Map<string, FlockEntry>;
  readonly rangeRevisions: Map<string, number>;
  ranges: RangeLock[];
  waiters: Waiter[];
}

interface OfdReservation {
  readonly targetOwner: number;
  readonly state: Int32Array;
}

interface OfdRecord {
  readonly ino: number;
  readonly handle: number;
  readonly ofdId: string;
  readonly originOwner: number;
  originClosed: boolean;
  cells?: Int32Array;
  readonly reservations: OfdReservation[];
}

/** Authoritative liveness callbacks supplied by FilesystemService when reaping shared OFDs. */
export interface OfdLiveness {
  isSessionLive(sessionOwner: number): boolean;
  hasPendingTransfer(sessionOwner: number, handle: number): boolean;
}

export interface LockCommit {
  readonly errno: number;
  /** Undo this lock acquisition if the service reply is cancelled before the client consumes it. */
  readonly rollback?: () => void;
}

export class LockContentionError extends Error {
  constructor(
    readonly wait: Promise<void>,
    readonly cancel: () => void,
  ) {
    super("advisory lock contended");
  }
}

function normalizeFlockOp(operation: number): {
  base: typeof LOCK_SH | typeof LOCK_EX | typeof LOCK_UN;
  nonblocking: boolean;
} | null {
  if (!Number.isInteger(operation) || operation < 0) return null;
  if ((operation & ~(LOCK_SH | LOCK_EX | LOCK_NB | LOCK_UN)) !== 0) return null;
  const nonblocking = (operation & LOCK_NB) !== 0;
  const base = operation & ~LOCK_NB;
  if (base !== LOCK_SH && base !== LOCK_EX && base !== LOCK_UN) return null;
  return { base, nonblocking };
}

function parseOfdId(ofdId: string): { readonly owner: number; readonly seq: number } | null {
  const colon = ofdId.indexOf(":");
  if (colon <= 0 || colon === ofdId.length - 1) return null;
  const ownerStr = ofdId.slice(0, colon);
  const seqStr = ofdId.slice(colon + 1);
  if (!/^(?:0|[1-9][0-9]*)$/.test(ownerStr) || !/^[1-9][0-9]*$/.test(seqStr)) return null;
  const owner = Number(ownerStr);
  const seq = Number(seqStr);
  if (!Number.isSafeInteger(owner) || !Number.isSafeInteger(seq)) return null;
  return { owner, seq };
}

function rangeEndOf(start: number, len: number): number {
  if (!Number.isSafeInteger(start) || start < 0) return -1;
  if (!Number.isSafeInteger(len) || len < 0) return -1;
  if (len === 0) return Infinity;
  const end = start + len;
  return Number.isSafeInteger(end) ? end : -1;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function rangesConflict(aType: RangeType, bType: RangeType): boolean {
  return aType === F_WRLCK || bType === F_WRLCK;
}

function flockConflicts(existing: FlockMode, requested: FlockMode): boolean {
  return existing === "ex" || requested === "ex";
}

function posixOwnerKey(sessionOwner: number): string {
  return `p:${sessionOwner}`;
}

function ofdOwnerKey(ofdId: string): string {
  return `o:${ofdId}`;
}

function cloneRange(lock: RangeLock): RangeLock {
  return {
    owner: lock.owner,
    sessionOwner: lock.sessionOwner,
    ofdId: lock.ofdId,
    pid: lock.pid,
    type: lock.type,
    start: lock.start,
    end: lock.end,
  };
}

function editOwnerRanges(
  ranges: readonly RangeLock[],
  owner: string,
  sessionOwner: number,
  ofdId: string | undefined,
  pid: number,
  type: FileLockRange["type"],
  start: number,
  end: number,
): { next: RangeLock[]; previousOwner: RangeLock[]; relaxed: boolean; remainingOwned: number } {
  const others: RangeLock[] = [];
  const owned: RangeLock[] = [];
  const previousOwner: RangeLock[] = [];
  let relaxed = false;
  for (let i = 0; i < ranges.length; i++) {
    const entry = ranges[i]!;
    if (entry.owner !== owner) {
      others.push(entry);
      continue;
    }
    previousOwner.push(cloneRange(entry));
    if (!rangesOverlap(entry.start, entry.end, start, end)) {
      owned.push(entry);
      continue;
    }
    if (type === F_UNLCK || (entry.type === F_WRLCK && type === F_RDLCK)) relaxed = true;
    if (entry.start < start) owned.push({ ...entry, end: start });
    if (entry.end > end) owned.push({ ...entry, start: end });
  }
  if (type !== F_UNLCK) owned.push({ owner, sessionOwner, ofdId, pid, type, start, end });
  owned.sort((left, right) => left.start - right.start);
  const coalesced = coalesceOwned(owned);
  return {
    next: others.concat(coalesced),
    previousOwner,
    relaxed,
    remainingOwned: coalesced.length,
  };
}

function coalesceOwned(owned: readonly RangeLock[]): RangeLock[] {
  const merged: RangeLock[] = [];
  for (let i = 0; i < owned.length; i++) {
    const current = owned[i]!;
    const prev = merged[merged.length - 1];
    if (prev && prev.type === current.type && prev.end >= current.start) {
      prev.end = Math.max(prev.end, current.end);
      continue;
    }
    merged.push(cloneRange(current));
  }
  return merged;
}

/** Inode-keyed advisory lock table implementing Linux/gVisor flock(2) and POSIX/OFD fcntl(2). */
export class LockTable {
  private readonly byIno = new Map<number, InodeLocks>();
  private readonly posixInos = new Map<number, Set<number>>();
  private readonly ofdRecords = new Map<string, OfdRecord>();
  private readonly ownerOfds = new Map<number, Set<string>>();
  private readonly waitingOn = new Map<string, Set<string>>();
  private readonly deadlockWaiters = new Map<string, Set<Waiter>>();
  private readonly waitersBySession = new Map<number, Set<Waiter>>();
  private nextWaiterId = 1;
  private nextRevision = 1;

  /** Register an adopted inherited file description reservation so OFD lock lifetimes track it. */
  adoptReservation(
    ino: number,
    handle: number,
    ofdId: string,
    originOwner: number,
    ofdBuffer: SharedArrayBuffer,
    targetOwner: number,
    reservationState: SharedArrayBuffer,
  ): void {
    const existing = this.ofdRecords.get(ofdId);
    if (existing && existing.ino !== ino) return;
    const record = this.ensureOfdRecord(ino, handle, ofdId, originOwner);
    record.cells ??= new Int32Array(ofdBuffer);
    this.indexOwnerOfd(originOwner, ofdId);
    const state = new Int32Array(reservationState);
    if (Atomics.load(state, 0) === 0) {
      record.reservations.push({ targetOwner, state });
      this.indexOwnerOfd(targetOwner, ofdId);
    }
  }

  flock(
    ino: number,
    ofdId: string,
    sessionOwner: number,
    operation: number,
    allowWait = false,
    handle = 0,
  ): LockCommit {
    const parsed = normalizeFlockOp(operation);
    if (!parsed) return { errno: EINVAL };
    if (!this.isAuthorizedOfd(sessionOwner, ofdId, ino)) return { errno: EACCES };
    if (parsed.base === LOCK_UN) {
      this.removeFlock(ino, ofdId);
      return { errno: 0 };
    }
    const mode: FlockMode = parsed.base === LOCK_EX ? "ex" : "sh";
    const inode = this.byIno.get(ino);
    const existing = inode?.flocks.get(ofdId);
    const blockers = inode ? this.flockBlockers(inode, ofdId, mode) : [];
    if (blockers.length > 0) {
      if (parsed.nonblocking || !allowWait) return { errno: EAGAIN };
      // Per Linux/gVisor flock_lock_inode: blocking upgrade drops own prior lock before sleeping
      // so two shared holders attempting simultaneous LOCK_EX upgrades do not deadlock.
      if (existing) this.removeFlock(ino, ofdId);
      throw this.enqueueWaiter(ino, ofdOwnerKey(ofdId), sessionOwner, blockers, false);
    }
    const originOwner = parseOfdId(ofdId)?.owner ?? sessionOwner;
    this.ensureOfdRecord(ino, handle, ofdId, originOwner);
    this.indexOwnerOfd(sessionOwner, ofdId);
    return this.installFlock(ino, ofdId, mode, existing);
  }

  releaseOfd(ino: number, ofdId: string, sessionOwner?: number, liveness?: OfdLiveness): void {
    if (sessionOwner !== undefined && !this.isAuthorizedOfd(sessionOwner, ofdId, ino)) return;
    const record = this.ofdRecords.get(ofdId);
    if (!record || !liveness) {
      this.dropOfdLocks(ino, ofdId);
      if (record) this.deleteOfdRecord(record);
      return;
    }
    if (sessionOwner !== undefined && sessionOwner === record.originOwner && !record.cells)
      record.originClosed = true;
    if (!this.isOfdAlive(record, liveness)) {
      this.dropOfdLocks(record.ino, ofdId);
      this.deleteOfdRecord(record);
    }
  }

  /** Reap any tracked OFDs whose origin, adopted reservations, and pending transfers are gone. */
  reapOfds(liveness: OfdLiveness, ofdIds?: Iterable<string>): void {
    const candidates = ofdIds ? Array.from(ofdIds) : Array.from(this.ofdRecords.keys());
    for (let i = 0; i < candidates.length; i++) {
      const ofdId = candidates[i]!;
      const record = this.ofdRecords.get(ofdId);
      if (!record || this.isOfdAlive(record, liveness)) continue;
      this.dropOfdLocks(record.ino, ofdId);
      this.deleteOfdRecord(record);
    }
  }

  setRangeLock(
    ino: number,
    ofdId: string | undefined,
    sessionOwner: number,
    pid: number,
    range: FileLockRange,
    blocking: boolean,
    allowWait = false,
    handle = 0,
  ): LockCommit {
    if (range.type !== F_RDLCK && range.type !== F_WRLCK && range.type !== F_UNLCK)
      return { errno: EINVAL };
    const end = rangeEndOf(range.start, range.len);
    if (end < 0) return { errno: EINVAL };
    if (ofdId !== undefined && !this.isAuthorizedOfd(sessionOwner, ofdId, ino))
      return { errno: EACCES };
    const owner = ofdId === undefined ? posixOwnerKey(sessionOwner) : ofdOwnerKey(ofdId);
    const inode = this.byIno.get(ino);
    if (range.type === F_UNLCK)
      return this.unlockRange(ino, inode, owner, sessionOwner, ofdId, pid, range.start, end);
    const blockers = inode ? this.rangeBlockers(inode, owner, range.type, range.start, end) : [];
    if (blockers.length > 0) {
      if (!blocking || !allowWait) return { errno: EAGAIN };
      const trackDeadlock = ofdId === undefined;
      if (trackDeadlock && this.wouldDeadlock(owner, blockers)) return { errno: EDEADLK };
      throw this.enqueueWaiter(ino, owner, sessionOwner, blockers, trackDeadlock);
    }
    if (ofdId !== undefined) {
      const originOwner = parseOfdId(ofdId)?.owner ?? sessionOwner;
      this.ensureOfdRecord(ino, handle, ofdId, originOwner);
      this.indexOwnerOfd(sessionOwner, ofdId);
    }
    return this.installRangeLock(
      ino,
      owner,
      sessionOwner,
      ofdId,
      pid,
      range.type,
      range.start,
      end,
    );
  }

  getRangeLock(
    ino: number,
    ofdId: string | undefined,
    sessionOwner: number,
    range: FileLockRange,
  ): FileLockConflict | number {
    // Per Linux/FreeBSD/gVisor fcntl(2), F_GETLK/F_OFD_GETLK requires F_RDLCK or F_WRLCK.
    if (range.type !== F_RDLCK && range.type !== F_WRLCK) return EINVAL;
    const end = rangeEndOf(range.start, range.len);
    if (end < 0) return EINVAL;
    if (ofdId !== undefined && !this.isAuthorizedOfd(sessionOwner, ofdId, ino)) return EACCES;
    const clear: FileLockConflict = { type: F_UNLCK, pid: 0, start: 0, len: 0 };
    const inode = this.byIno.get(ino);
    if (!inode) return clear;
    const owner = ofdId === undefined ? posixOwnerKey(sessionOwner) : ofdOwnerKey(ofdId);
    for (let i = 0; i < inode.ranges.length; i++) {
      const entry = inode.ranges[i]!;
      if (entry.owner === owner) continue;
      if (!rangesConflict(entry.type, range.type)) continue;
      if (!rangesOverlap(entry.start, entry.end, range.start, end)) continue;
      return {
        type: entry.type,
        pid: entry.ofdId === undefined ? entry.pid : -1,
        start: entry.start,
        len: entry.end === Infinity ? 0 : entry.end - entry.start,
      };
    }
    return clear;
  }

  releasePosix(ino: number, sessionOwner: number): void {
    this.unindexPosixIno(sessionOwner, ino);
    const inode = this.byIno.get(ino);
    if (!inode) return;
    const owner = posixOwnerKey(sessionOwner);
    const before = inode.ranges.length;
    inode.ranges = inode.ranges.filter((entry) => entry.owner !== owner);
    inode.rangeRevisions.set(owner, this.nextRevision++);
    if (inode.ranges.length !== before) this.wakeInode(ino, inode);
    this.pruneInode(ino, inode);
  }

  releaseSession(sessionOwner: number, liveness?: OfdLiveness): void {
    const waiters = this.waitersBySession.get(sessionOwner);
    if (waiters) {
      for (const waiter of Array.from(waiters)) waiter.cancel();
      this.waitersBySession.delete(sessionOwner);
    }
    const inos = this.posixInos.get(sessionOwner);
    if (inos) {
      this.posixInos.delete(sessionOwner);
      for (const ino of Array.from(inos)) this.releasePosix(ino, sessionOwner);
    }
    const ofds = this.ownerOfds.get(sessionOwner);
    if (!ofds) return;
    const snapshot = Array.from(ofds);
    this.ownerOfds.delete(sessionOwner);
    const effectiveLiveness: OfdLiveness = liveness ?? {
      isSessionLive: (owner) => owner !== sessionOwner,
      hasPendingTransfer: () => false,
    };
    this.reapOfds(effectiveLiveness, snapshot);
  }

  dispose(): void {
    for (const inode of Array.from(this.byIno.values())) {
      for (const waiter of inode.waiters.slice()) waiter.cancel();
    }
    this.byIno.clear();
    this.posixInos.clear();
    this.ofdRecords.clear();
    this.ownerOfds.clear();
    this.waitingOn.clear();
    this.deadlockWaiters.clear();
    this.waitersBySession.clear();
  }

  private isAuthorizedOfd(sessionOwner: number, ofdId: string, ino: number): boolean {
    const existing = this.ofdRecords.get(ofdId);
    if (existing && existing.ino !== ino) return false;
    if (sessionOwner === 0) return ofdId.length > 0;
    const parsed = parseOfdId(ofdId);
    if (!parsed) return false;
    if (parsed.owner === sessionOwner) return true;
    return this.ownerOfds.get(sessionOwner)?.has(ofdId) === true;
  }

  private unlockRange(
    ino: number,
    inode: InodeLocks | undefined,
    owner: string,
    sessionOwner: number,
    ofdId: string | undefined,
    pid: number,
    start: number,
    end: number,
  ): LockCommit {
    if (!inode) return { errno: 0 };
    const edited = editOwnerRanges(
      inode.ranges,
      owner,
      sessionOwner,
      ofdId,
      pid,
      F_UNLCK,
      start,
      end,
    );
    inode.ranges = edited.next;
    inode.rangeRevisions.set(owner, this.nextRevision++);
    if (ofdId === undefined && edited.remainingOwned === 0) this.unindexPosixIno(sessionOwner, ino);
    if (edited.relaxed) this.wakeInode(ino, inode);
    this.pruneInode(ino, inode);
    return { errno: 0 };
  }

  private isOfdAlive(record: OfdRecord, liveness: OfdLiveness): boolean {
    let writeIndex = 0;
    let dropped: number[] | undefined;
    for (let i = 0; i < record.reservations.length; i++) {
      const entry = record.reservations[i]!;
      if (Atomics.load(entry.state, 0) !== 0 || !liveness.isSessionLive(entry.targetOwner)) {
        (dropped ??= []).push(entry.targetOwner);
        continue;
      }
      record.reservations[writeIndex++] = entry;
    }
    record.reservations.length = writeIndex;
    if (dropped) this.pruneDroppedOwners(record, dropped);
    if (writeIndex > 0) return true;
    const originClosed =
      record.originClosed ||
      (record.cells !== undefined &&
        (Atomics.load(record.cells, 7) & OFD_FLAG_ORIGIN_CLOSED) !== 0);
    if (!originClosed && liveness.isSessionLive(record.originOwner)) return true;
    if (record.cells !== undefined) return Atomics.load(record.cells, 6) > 0;
    return liveness.hasPendingTransfer(record.originOwner, record.handle);
  }

  private pruneDroppedOwners(record: OfdRecord, dropped: readonly number[]): void {
    for (let i = 0; i < dropped.length; i++) {
      const owner = dropped[i]!;
      if (owner === record.originOwner) continue;
      if (record.reservations.some((res) => res.targetOwner === owner)) continue;
      this.unindexOwnerOfd(owner, record.ofdId);
    }
  }

  private dropOfdLocks(ino: number, ofdId: string): void {
    const inode = this.byIno.get(ino);
    if (!inode) return;
    let changed = inode.flocks.delete(ofdId);
    const key = ofdOwnerKey(ofdId);
    const before = inode.ranges.length;
    inode.ranges = inode.ranges.filter((entry) => entry.owner !== key);
    inode.rangeRevisions.set(key, this.nextRevision++);
    if (inode.ranges.length !== before) changed = true;
    if (changed) this.wakeInode(ino, inode);
    this.pruneInode(ino, inode);
  }

  private ensureOfdRecord(
    ino: number,
    handle: number,
    ofdId: string,
    originOwner: number,
  ): OfdRecord {
    let record = this.ofdRecords.get(ofdId);
    if (!record) {
      record = { ino, handle, ofdId, originOwner, originClosed: false, reservations: [] };
      this.ofdRecords.set(ofdId, record);
      this.indexOwnerOfd(originOwner, ofdId);
    }
    return record;
  }

  private deleteOfdRecord(record: OfdRecord): void {
    this.ofdRecords.delete(record.ofdId);
    this.unindexOwnerOfd(record.originOwner, record.ofdId);
    for (let i = 0; i < record.reservations.length; i++)
      this.unindexOwnerOfd(record.reservations[i]!.targetOwner, record.ofdId);
  }

  private indexOwnerOfd(sessionOwner: number, ofdId: string): void {
    let set = this.ownerOfds.get(sessionOwner);
    if (!set) {
      set = new Set();
      this.ownerOfds.set(sessionOwner, set);
    }
    set.add(ofdId);
  }

  private unindexOwnerOfd(sessionOwner: number, ofdId: string): void {
    const set = this.ownerOfds.get(sessionOwner);
    if (!set) return;
    set.delete(ofdId);
    if (set.size === 0) this.ownerOfds.delete(sessionOwner);
  }

  private ensureInode(ino: number): InodeLocks {
    let inode = this.byIno.get(ino);
    if (!inode) {
      inode = { flocks: new Map(), rangeRevisions: new Map(), ranges: [], waiters: [] };
      this.byIno.set(ino, inode);
    }
    return inode;
  }

  private indexPosixIno(sessionOwner: number, ino: number): void {
    let set = this.posixInos.get(sessionOwner);
    if (!set) {
      set = new Set();
      this.posixInos.set(sessionOwner, set);
    }
    set.add(ino);
  }

  private unindexPosixIno(sessionOwner: number, ino: number): void {
    const set = this.posixInos.get(sessionOwner);
    if (!set) return;
    set.delete(ino);
    if (set.size === 0) this.posixInos.delete(sessionOwner);
  }

  private flockBlockers(inode: InodeLocks, ofdId: string, mode: FlockMode): string[] {
    const blockers: string[] = [];
    for (const entry of inode.flocks.values()) {
      if (entry.ofdId === ofdId) continue;
      if (flockConflicts(entry.mode, mode)) blockers.push(ofdOwnerKey(entry.ofdId));
    }
    return blockers;
  }

  private rangeBlockers(
    inode: InodeLocks,
    owner: string,
    type: RangeType,
    start: number,
    end: number,
  ): string[] {
    const blockers = new Set<string>();
    for (let i = 0; i < inode.ranges.length; i++) {
      const entry = inode.ranges[i]!;
      if (entry.owner === owner) continue;
      if (!rangesConflict(entry.type, type)) continue;
      if (rangesOverlap(entry.start, entry.end, start, end)) blockers.add(entry.owner);
    }
    return Array.from(blockers);
  }

  private installFlock(
    ino: number,
    ofdId: string,
    mode: FlockMode,
    existing: FlockEntry | undefined,
  ): LockCommit {
    const inode = this.ensureInode(ino);
    const previousMode = existing?.mode;
    const revision = this.nextRevision++;
    const downgraded = previousMode === "ex" && mode === "sh";
    if (existing) {
      existing.mode = mode;
      existing.revision = revision;
      if (downgraded) this.wakeInode(ino, inode);
    } else {
      inode.flocks.set(ofdId, { mode, ofdId, revision });
    }
    if (downgraded) return { errno: 0 };
    return {
      errno: 0,
      rollback: () => this.rollbackFlock(ino, ofdId, previousMode, revision),
    };
  }

  private rollbackFlock(
    ino: number,
    ofdId: string,
    previousMode: FlockMode | undefined,
    expectedRevision: number,
  ): void {
    const inode = this.byIno.get(ino);
    const current = inode?.flocks.get(ofdId);
    if (!inode || !current || current.revision !== expectedRevision) return;
    if (previousMode === undefined) {
      inode.flocks.delete(ofdId);
      this.wakeInode(ino, inode);
      this.pruneInode(ino, inode);
      return;
    }
    if (this.flockBlockers(inode, ofdId, previousMode).length > 0) return;
    current.mode = previousMode;
    current.revision = this.nextRevision++;
    this.wakeInode(ino, inode);
  }

  private removeFlock(ino: number, ofdId: string): void {
    const inode = this.byIno.get(ino);
    if (!inode || !inode.flocks.delete(ofdId)) return;
    this.wakeInode(ino, inode);
    this.pruneInode(ino, inode);
  }

  private installRangeLock(
    ino: number,
    owner: string,
    sessionOwner: number,
    ofdId: string | undefined,
    pid: number,
    type: RangeType,
    start: number,
    end: number,
  ): LockCommit {
    const inode = this.ensureInode(ino);
    const edited = editOwnerRanges(inode.ranges, owner, sessionOwner, ofdId, pid, type, start, end);
    const revision = this.nextRevision++;
    inode.ranges = edited.next;
    inode.rangeRevisions.set(owner, revision);
    if (ofdId === undefined) this.indexPosixIno(sessionOwner, ino);
    if (edited.relaxed) {
      this.wakeInode(ino, inode);
      return { errno: 0 };
    }
    const snapshot = edited.previousOwner;
    return {
      errno: 0,
      rollback: () => this.rollbackRange(ino, owner, sessionOwner, ofdId, snapshot, revision),
    };
  }

  private rollbackRange(
    ino: number,
    owner: string,
    sessionOwner: number,
    ofdId: string | undefined,
    previousOwner: readonly RangeLock[],
    expectedRevision: number,
  ): void {
    const inode = this.byIno.get(ino);
    if (!inode || inode.rangeRevisions.get(owner) !== expectedRevision) return;
    for (let i = 0; i < previousOwner.length; i++) {
      const prev = previousOwner[i]!;
      if (this.rangeBlockers(inode, owner, prev.type, prev.start, prev.end).length > 0) return;
    }
    const others = inode.ranges.filter((entry) => entry.owner !== owner);
    inode.ranges = others.concat(previousOwner.map(cloneRange));
    inode.rangeRevisions.set(owner, this.nextRevision++);
    if (ofdId === undefined && previousOwner.length === 0) this.unindexPosixIno(sessionOwner, ino);
    this.wakeInode(ino, inode);
    this.pruneInode(ino, inode);
  }

  private wouldDeadlock(waiterOwner: string, blockers: readonly string[]): boolean {
    const visited = new Set<string>();
    const stack = blockers.slice();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === waiterOwner) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const next = this.waitingOn.get(current);
      if (!next) continue;
      for (const target of next) stack.push(target);
    }
    return false;
  }

  private enqueueWaiter(
    ino: number,
    owner: string,
    sessionOwner: number,
    blockers: readonly string[],
    trackDeadlock: boolean,
  ): LockContentionError {
    const inode = this.ensureInode(ino);
    const deferred = Promise.withResolvers<void>();
    const settle = () => {
      if (waiter.resolved) return;
      waiter.resolved = true;
      this.detachWaiter(waiter);
      deferred.resolve();
    };
    const waiter: Waiter = {
      id: this.nextWaiterId++,
      ino,
      owner,
      sessionOwner,
      blockers: blockers.slice(),
      trackDeadlock,
      resolved: false,
      wake: settle,
      cancel: settle,
    };
    inode.waiters.push(waiter);
    let sessionWaiters = this.waitersBySession.get(sessionOwner);
    if (!sessionWaiters) {
      sessionWaiters = new Set();
      this.waitersBySession.set(sessionOwner, sessionWaiters);
    }
    sessionWaiters.add(waiter);
    if (trackDeadlock) this.addDeadlockWaiter(waiter);
    return new LockContentionError(deferred.promise, settle);
  }

  private addDeadlockWaiter(waiter: Waiter): void {
    let waiters = this.deadlockWaiters.get(waiter.owner);
    if (!waiters) {
      waiters = new Set();
      this.deadlockWaiters.set(waiter.owner, waiters);
    }
    waiters.add(waiter);
    let edges = this.waitingOn.get(waiter.owner);
    if (!edges) {
      edges = new Set();
      this.waitingOn.set(waiter.owner, edges);
    }
    for (let i = 0; i < waiter.blockers.length; i++) edges.add(waiter.blockers[i]!);
  }

  private removeDeadlockWaiter(waiter: Waiter): void {
    const waiters = this.deadlockWaiters.get(waiter.owner);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.deadlockWaiters.delete(waiter.owner);
      this.waitingOn.delete(waiter.owner);
      return;
    }
    const edges = new Set<string>();
    for (const active of waiters) {
      for (let i = 0; i < active.blockers.length; i++) edges.add(active.blockers[i]!);
    }
    this.waitingOn.set(waiter.owner, edges);
  }

  private detachWaiter(waiter: Waiter): void {
    const inode = this.byIno.get(waiter.ino);
    if (inode) {
      const index = inode.waiters.indexOf(waiter);
      if (index >= 0) inode.waiters.splice(index, 1);
      this.pruneInode(waiter.ino, inode);
    }
    const sessionWaiters = this.waitersBySession.get(waiter.sessionOwner);
    if (sessionWaiters) {
      sessionWaiters.delete(waiter);
      if (sessionWaiters.size === 0) this.waitersBySession.delete(waiter.sessionOwner);
    }
    if (waiter.trackDeadlock) this.removeDeadlockWaiter(waiter);
  }

  private wakeInode(_ino: number, inode: InodeLocks): void {
    if (inode.waiters.length === 0) return;
    const pending = inode.waiters.slice();
    for (let i = 0; i < pending.length; i++) pending[i]!.wake();
  }

  private pruneInode(ino: number, inode: InodeLocks): void {
    if (inode.flocks.size > 0 || inode.ranges.length > 0 || inode.waiters.length > 0) return;
    this.byIno.delete(ino);
  }
}
