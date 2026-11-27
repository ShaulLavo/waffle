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
const ENOLCK = 46;
const OFD_FLAG_ORIGIN_CLOSED = 2;

const DEFAULT_MAX_RANGE_LOCKS = 4096;
const DEFAULT_MAX_FLOCKS = 4096;
const DEFAULT_MAX_WAITERS = 512;
const DEFAULT_MAX_PENDING_TRANSACTIONS = 256;

type FlockMode = "sh" | "ex";
type RangeType = typeof F_RDLCK | typeof F_WRLCK;
type PrevRangeType = FileLockRange["type"];

interface FlockEntry {
  mode: FlockMode;
  readonly ofdId: string;
  opId: number;
}

interface RangeLock {
  readonly owner: string;
  readonly posixOwner: number | undefined;
  readonly ofdId: string | undefined;
  readonly pid: number;
  type: RangeType;
  start: number;
  end: number;
  opId: number;
}

interface RangeDeltaSegment {
  readonly start: number;
  readonly end: number;
  readonly prevType: PrevRangeType;
  prevOpId: number;
}

interface FlockOpRecord {
  readonly ino: number;
  readonly ofdId: string;
  prevMode: FlockMode | undefined;
  prevOpId: number;
}

interface RangeOpRecord {
  readonly ino: number;
  readonly owner: string;
  delta: RangeDeltaSegment[];
  reservedSlots: number;
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
  pendingOriginTransfer: boolean;
  cells?: Int32Array;
  readonly reservations: OfdReservation[];
}

/** Authoritative liveness callbacks supplied by FilesystemService when reaping shared OFDs. */
export interface OfdLiveness {
  isSessionLive(sessionOwner: number): boolean;
  hasPendingTransfer(sessionOwner: number, handle: number): boolean;
}

export interface LockTableOptions {
  readonly maxRangeLocks?: number;
  readonly maxFlocks?: number;
  readonly maxWaiters?: number;
  readonly maxPendingTransactions?: number;
  readonly onPosixLockCountChange?: (count: number) => void;
}

export interface LockTableDiagnostics {
  readonly inodes: number;
  readonly flocks: number;
  readonly ranges: number;
  readonly posixRanges: number;
  readonly waiters: number;
  readonly ofdRecords: number;
  readonly pendingTransactions: number;
}

export interface LockCommit {
  readonly errno: number;
  /** Undo this lock acquisition if the service reply is cancelled before the client consumes it. */
  readonly rollback?: () => void;
  /** Finalize this lock acquisition once the client consumes the reply so segments can coalesce. */
  readonly settle?: () => void;
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

function posixOwnerKey(posixOwner: number): string {
  return `p:${posixOwner}`;
}

function ofdOwnerKey(ofdId: string): string {
  return `o:${ofdId}`;
}

function cloneRange(lock: RangeLock): RangeLock {
  return {
    owner: lock.owner,
    posixOwner: lock.posixOwner,
    ofdId: lock.ofdId,
    pid: lock.pid,
    type: lock.type,
    start: lock.start,
    end: lock.end,
    opId: lock.opId,
  };
}

function coalesceOwned(owned: readonly RangeLock[]): RangeLock[] {
  const sorted = owned.toSorted((left, right) => left.start - right.start);
  const merged: RangeLock[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i]!;
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.type === current.type &&
      prev.opId === 0 &&
      current.opId === 0 &&
      prev.end >= current.start
    ) {
      prev.end = Math.max(prev.end, current.end);
      continue;
    }
    merged.push(cloneRange(current));
  }
  return merged;
}

function computeRangeDelta(
  previousOwned: readonly RangeLock[],
  start: number,
  end: number,
): RangeDeltaSegment[] {
  const sorted = previousOwned.toSorted((left, right) => left.start - right.start);
  const delta: RangeDeltaSegment[] = [];
  let cursor = start;
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i]!;
    if (entry.end <= cursor) continue;
    if (entry.start >= end) break;
    const ovStart = Math.max(entry.start, cursor);
    const ovEnd = Math.min(entry.end, end);
    if (ovStart > cursor)
      delta.push({ start: cursor, end: ovStart, prevType: F_UNLCK, prevOpId: 0 });
    delta.push({ start: ovStart, end: ovEnd, prevType: entry.type, prevOpId: entry.opId });
    cursor = ovEnd;
  }
  if (cursor < end) delta.push({ start: cursor, end, prevType: F_UNLCK, prevOpId: 0 });
  return delta;
}

function spliceDeltaSegment(
  seg: RangeDeltaSegment,
  cancelledDelta: readonly RangeDeltaSegment[],
  out: RangeDeltaSegment[],
): void {
  let cursor = seg.start;
  for (let i = 0; i < cancelledDelta.length; i++) {
    const piece = cancelledDelta[i]!;
    if (piece.end <= cursor) continue;
    if (piece.start >= seg.end) break;
    const ovStart = Math.max(cursor, piece.start);
    const ovEnd = Math.min(seg.end, piece.end);
    if (ovStart > cursor) out.push({ start: cursor, end: ovStart, prevType: F_UNLCK, prevOpId: 0 });
    out.push({ start: ovStart, end: ovEnd, prevType: piece.prevType, prevOpId: piece.prevOpId });
    cursor = ovEnd;
  }
  if (cursor < seg.end) out.push({ start: cursor, end: seg.end, prevType: F_UNLCK, prevOpId: 0 });
}

function rollbackReserveForDelta(delta: readonly RangeDeltaSegment[]): number {
  let nonUnlock = 0;
  for (let i = 0; i < delta.length; i++) {
    if (delta[i]!.prevType !== F_UNLCK) nonUnlock += 1;
  }
  return nonUnlock > 1 ? nonUnlock - 1 : 0;
}

function spliceRangeDelta(
  targetDelta: readonly RangeDeltaSegment[],
  cancelledOpId: number,
  cancelledDelta: readonly RangeDeltaSegment[],
): RangeDeltaSegment[] {
  const out: RangeDeltaSegment[] = [];
  for (let i = 0; i < targetDelta.length; i++) {
    const seg = targetDelta[i]!;
    if (seg.prevOpId !== cancelledOpId) {
      out.push(seg);
      continue;
    }
    spliceDeltaSegment(seg, cancelledDelta, out);
  }
  return out;
}

function editOwnerRanges(
  ranges: readonly RangeLock[],
  owner: string,
  posixOwner: number | undefined,
  ofdId: string | undefined,
  pid: number,
  type: FileLockRange["type"],
  start: number,
  end: number,
  opId: number,
): {
  next: RangeLock[];
  delta: RangeDeltaSegment[];
  relaxed: boolean;
  previousCount: number;
  nextCount: number;
} {
  const others: RangeLock[] = [];
  const owned: RangeLock[] = [];
  const previousOwned: RangeLock[] = [];
  let relaxed = false;
  for (let i = 0; i < ranges.length; i++) {
    const entry = ranges[i]!;
    if (entry.owner !== owner) {
      others.push(entry);
      continue;
    }
    previousOwned.push(entry);
    if (!rangesOverlap(entry.start, entry.end, start, end)) {
      owned.push(entry);
      continue;
    }
    if (type === F_UNLCK || (entry.type === F_WRLCK && type === F_RDLCK)) relaxed = true;
    if (entry.start < start) owned.push({ ...entry, end: start });
    if (entry.end > end) owned.push({ ...entry, start: end });
  }
  const delta = type === F_UNLCK ? [] : computeRangeDelta(previousOwned, start, end);
  if (type !== F_UNLCK) owned.push({ owner, posixOwner, ofdId, pid, type, start, end, opId });
  const coalesced = coalesceOwned(owned);
  return {
    next: others.concat(coalesced),
    delta,
    relaxed,
    previousCount: previousOwned.length,
    nextCount: coalesced.length,
  };
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
  private readonly pendingOps = new Set<number>();
  private readonly flockOpPrev = new Map<number, FlockOpRecord>();
  private readonly rangeOpDeltas = new Map<number, RangeOpRecord>();
  private readonly maxRangeLocks: number;
  private readonly maxFlocks: number;
  private readonly maxWaiters: number;
  private readonly maxPendingTransactions: number;
  private readonly onPosixLockCountChange?: (count: number) => void;
  private totalRangeLocks = 0;
  private reservedRangeRollbackSlots = 0;
  private totalPosixRangeLocks = 0;
  private totalFlocks = 0;
  private totalWaiters = 0;
  private nextWaiterId = 1;
  private nextOpId = 1;

  constructor(options: LockTableOptions = {}) {
    this.maxRangeLocks = options.maxRangeLocks ?? DEFAULT_MAX_RANGE_LOCKS;
    this.maxFlocks = options.maxFlocks ?? DEFAULT_MAX_FLOCKS;
    this.maxWaiters = options.maxWaiters ?? DEFAULT_MAX_WAITERS;
    this.maxPendingTransactions =
      options.maxPendingTransactions ?? DEFAULT_MAX_PENDING_TRANSACTIONS;
    this.onPosixLockCountChange = options.onPosixLockCountChange;
  }

  hasActivePosixLocks(): boolean {
    return this.totalPosixRangeLocks > 0;
  }

  diagnostics(): LockTableDiagnostics {
    return {
      inodes: this.byIno.size,
      flocks: this.totalFlocks,
      ranges: this.totalRangeLocks,
      posixRanges: this.totalPosixRangeLocks,
      waiters: this.totalWaiters,
      ofdRecords: this.ofdRecords.size,
      pendingTransactions: this.pendingOps.size,
    };
  }

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
    trackTransaction = allowWait,
  ): LockCommit {
    const parsed = normalizeFlockOp(operation);
    if (!parsed) return { errno: EINVAL };
    if (!this.isAuthorizedOfd(sessionOwner, ofdId, ino)) return { errno: EACCES };
    if (parsed.base === LOCK_UN) {
      this.removeFlock(ino, ofdId);
      return { errno: 0 };
    }
    const mode: FlockMode = parsed.base === LOCK_EX ? "ex" : "sh";
    const prior = this.byIno.get(ino)?.flocks.get(ofdId);
    const previousMode = prior?.mode;
    const previousOpId = prior?.opId ?? 0;
    const converting = prior !== undefined && prior.mode !== mode;
    // Per Linux fs/locks.c (flock_lock_inode), converting between LOCK_SH and LOCK_EX drops the
    // existing lock before checking contention, even when LOCK_NB is set.
    if (converting) this.detachFlockEntry(ino, ofdId);
    const detachedOpId = converting ? previousOpId : 0;
    const inode = this.byIno.get(ino);
    const existing = inode?.flocks.get(ofdId);
    const blockers = inode ? this.flockBlockers(inode, ofdId, mode) : [];
    if (blockers.length > 0) {
      this.discardFlockChain(detachedOpId);
      if (parsed.nonblocking || !allowWait) return { errno: EAGAIN };
      if (this.totalWaiters >= this.maxWaiters) return { errno: ENOLCK };
      throw this.enqueueWaiter(ino, ofdOwnerKey(ofdId), sessionOwner, blockers, false);
    }
    if (
      (!existing && this.totalFlocks >= this.maxFlocks) ||
      (trackTransaction && this.pendingOps.size >= this.maxPendingTransactions)
    ) {
      this.discardFlockChain(detachedOpId);
      return { errno: ENOLCK };
    }
    const originOwner = parseOfdId(ofdId)?.owner ?? sessionOwner;
    this.ensureOfdRecord(ino, handle, ofdId, originOwner);
    this.indexOwnerOfd(sessionOwner, ofdId);
    return this.installFlock(
      ino,
      ofdId,
      mode,
      existing,
      previousMode,
      previousOpId,
      trackTransaction,
    );
  }

  releaseOfd(
    ino: number,
    ofdId: string,
    sessionOwner?: number,
    liveness?: OfdLiveness,
    inFlight = false,
  ): void {
    if (sessionOwner !== undefined && !this.isAuthorizedOfd(sessionOwner, ofdId, ino)) return;
    const record = this.ofdRecords.get(ofdId);
    if (!record || !liveness) {
      this.dropOfdLocks(ino, ofdId);
      if (record) this.deleteOfdRecord(record);
      return;
    }
    if (sessionOwner !== undefined && sessionOwner === record.originOwner) {
      record.originClosed = true;
      record.pendingOriginTransfer = inFlight;
    }
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
    posixOwner = sessionOwner,
    trackTransaction = allowWait,
  ): LockCommit {
    if (range.type !== F_RDLCK && range.type !== F_WRLCK && range.type !== F_UNLCK)
      return { errno: EINVAL };
    const end = rangeEndOf(range.start, range.len);
    if (end < 0) return { errno: EINVAL };
    if (ofdId !== undefined && !this.isAuthorizedOfd(sessionOwner, ofdId, ino))
      return { errno: EACCES };
    const effectivePosixOwner = ofdId === undefined ? posixOwner : undefined;
    const owner = ofdId === undefined ? posixOwnerKey(posixOwner) : ofdOwnerKey(ofdId);
    const inode = this.byIno.get(ino);
    if (range.type === F_UNLCK)
      return this.unlockRange(ino, inode, owner, effectivePosixOwner, ofdId, pid, range.start, end);
    const blockers = inode ? this.rangeBlockers(inode, owner, range.type, range.start, end) : [];
    if (blockers.length > 0) {
      if (!blocking || !allowWait) return { errno: EAGAIN };
      const trackDeadlock = ofdId === undefined;
      if (trackDeadlock && this.wouldDeadlock(owner, blockers)) return { errno: EDEADLK };
      if (this.totalWaiters >= this.maxWaiters) return { errno: ENOLCK };
      throw this.enqueueWaiter(ino, owner, sessionOwner, blockers, trackDeadlock);
    }
    return this.installRangeLock(
      ino,
      owner,
      sessionOwner,
      effectivePosixOwner,
      ofdId,
      pid,
      range.type,
      range.start,
      end,
      handle,
      trackTransaction,
    );
  }

  getRangeLock(
    ino: number,
    ofdId: string | undefined,
    sessionOwner: number,
    range: FileLockRange,
    posixOwner = sessionOwner,
  ): FileLockConflict | number {
    // Per Linux/FreeBSD/gVisor fcntl(2), F_GETLK/F_OFD_GETLK requires F_RDLCK or F_WRLCK.
    if (range.type !== F_RDLCK && range.type !== F_WRLCK) return EINVAL;
    const end = rangeEndOf(range.start, range.len);
    if (end < 0) return EINVAL;
    if (ofdId !== undefined && !this.isAuthorizedOfd(sessionOwner, ofdId, ino)) return EACCES;
    const clear: FileLockConflict = { type: F_UNLCK, pid: 0, start: 0, len: 0 };
    const inode = this.byIno.get(ino);
    if (!inode) return clear;
    const owner = ofdId === undefined ? posixOwnerKey(posixOwner) : ofdOwnerKey(ofdId);
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

  releasePosix(ino: number, posixOwner: number): void {
    this.unindexPosixIno(posixOwner, ino);
    const owner = posixOwnerKey(posixOwner);
    this.discardOwnerRangeOps(ino, owner);
    const inode = this.byIno.get(ino);
    if (!inode) return;
    const before = inode.ranges.length;
    inode.ranges = inode.ranges.filter((entry) => entry.owner !== owner);
    const removed = before - inode.ranges.length;
    if (removed > 0) {
      this.adjustRangeCounts(-removed, -removed);
      this.wakeInode(ino, inode);
    }
    this.pruneInode(ino, inode);
  }

  /** Release all POSIX byte-range locks owned by a logical process across all inodes. */
  releasePosixOwner(posixOwner: number): void {
    const inos = this.posixInos.get(posixOwner);
    if (!inos) return;
    this.posixInos.delete(posixOwner);
    for (const ino of Array.from(inos)) this.releasePosix(ino, posixOwner);
  }

  releaseSession(
    sessionOwner: number,
    liveness?: OfdLiveness,
    posixOwner = sessionOwner,
    releasePosix = true,
  ): void {
    const waiters = this.waitersBySession.get(sessionOwner);
    if (waiters) {
      for (const waiter of Array.from(waiters)) waiter.cancel();
      this.waitersBySession.delete(sessionOwner);
    }
    if (releasePosix) this.releasePosixOwner(posixOwner);
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
    this.pendingOps.clear();
    this.flockOpPrev.clear();
    this.rangeOpDeltas.clear();
    this.totalRangeLocks = 0;
    this.reservedRangeRollbackSlots = 0;
    this.totalFlocks = 0;
    this.totalWaiters = 0;
    this.setPosixRangeCount(0);
  }

  private setPosixRangeCount(next: number): void {
    if (this.totalPosixRangeLocks === next) return;
    this.totalPosixRangeLocks = next;
    this.onPosixLockCountChange?.(next);
  }

  private adjustRangeCounts(totalDelta: number, posixDelta: number): void {
    this.totalRangeLocks += totalDelta;
    if (posixDelta !== 0) this.setPosixRangeCount(this.totalPosixRangeLocks + posixDelta);
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
    posixOwner: number | undefined,
    ofdId: string | undefined,
    pid: number,
    start: number,
    end: number,
  ): LockCommit {
    if (!inode) return { errno: 0 };
    const edited = editOwnerRanges(
      inode.ranges,
      owner,
      posixOwner,
      ofdId,
      pid,
      F_UNLCK,
      start,
      end,
      0,
    );
    const deltaCount = edited.nextCount - edited.previousCount;
    if (
      deltaCount > 0 &&
      this.totalRangeLocks + this.reservedRangeRollbackSlots + deltaCount > this.maxRangeLocks
    )
      return { errno: ENOLCK };
    inode.ranges = edited.next;
    this.adjustRangeCounts(deltaCount, posixOwner !== undefined ? deltaCount : 0);
    if (posixOwner !== undefined && edited.nextCount === 0) this.unindexPosixIno(posixOwner, ino);
    this.recomputeOwnerRangeReserves(ino, owner, inode);
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
    if (record.originClosed) {
      return (
        record.pendingOriginTransfer &&
        liveness.hasPendingTransfer(record.originOwner, record.handle)
      );
    }
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
    const key = ofdOwnerKey(ofdId);
    this.discardOwnerRangeOps(ino, key);
    const inode = this.byIno.get(ino);
    if (!inode) return;
    let changed = false;
    const flock = inode.flocks.get(ofdId);
    if (flock) {
      inode.flocks.delete(ofdId);
      this.totalFlocks -= 1;
      if (flock.opId !== 0) this.discardFlockChain(flock.opId);
      changed = true;
    }
    const before = inode.ranges.length;
    inode.ranges = inode.ranges.filter((entry) => entry.owner !== key);
    const removed = before - inode.ranges.length;
    if (removed > 0) {
      this.adjustRangeCounts(-removed, 0);
      changed = true;
    }
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
      record = {
        ino,
        handle,
        ofdId,
        originOwner,
        originClosed: false,
        pendingOriginTransfer: false,
        reservations: [],
      };
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
      inode = { flocks: new Map(), ranges: [], waiters: [] };
      this.byIno.set(ino, inode);
    }
    return inode;
  }

  private indexPosixIno(posixOwner: number, ino: number): void {
    let set = this.posixInos.get(posixOwner);
    if (!set) {
      set = new Set();
      this.posixInos.set(posixOwner, set);
    }
    set.add(ino);
  }

  private unindexPosixIno(posixOwner: number, ino: number): void {
    const set = this.posixInos.get(posixOwner);
    if (!set) return;
    set.delete(ino);
    if (set.size === 0) this.posixInos.delete(posixOwner);
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

  private discardFlockChain(opId: number): void {
    let cursor = opId;
    while (cursor !== 0) {
      this.pendingOps.delete(cursor);
      const record = this.flockOpPrev.get(cursor);
      this.flockOpPrev.delete(cursor);
      cursor = record?.prevOpId ?? 0;
    }
  }

  private collectReachableRangeOps(inode: InodeLocks | undefined, owner: string): Set<number> {
    const reachable = new Set<number>();
    const queue: number[] = [];
    if (inode) {
      for (let i = 0; i < inode.ranges.length; i++) {
        const entry = inode.ranges[i]!;
        if (entry.owner === owner && entry.opId !== 0 && !reachable.has(entry.opId)) {
          reachable.add(entry.opId);
          queue.push(entry.opId);
        }
      }
    }
    while (queue.length > 0) {
      const record = this.rangeOpDeltas.get(queue.pop()!);
      if (!record) continue;
      for (let i = 0; i < record.delta.length; i++) {
        const prevOpId = record.delta[i]!.prevOpId;
        if (prevOpId !== 0 && !reachable.has(prevOpId)) {
          reachable.add(prevOpId);
          queue.push(prevOpId);
        }
      }
    }
    return reachable;
  }

  private recomputeOwnerRangeReserves(
    ino: number,
    owner: string,
    inode: InodeLocks | undefined,
  ): void {
    const reachable = this.collectReachableRangeOps(inode, owner);
    for (const [opId, record] of this.rangeOpDeltas) {
      if (record.ino !== ino || record.owner !== owner) continue;
      if (!reachable.has(opId)) {
        this.reservedRangeRollbackSlots -= record.reservedSlots;
        this.rangeOpDeltas.delete(opId);
        this.pendingOps.delete(opId);
        continue;
      }
      const nextReserve = rollbackReserveForDelta(record.delta);
      this.reservedRangeRollbackSlots += nextReserve - record.reservedSlots;
      record.reservedSlots = nextReserve;
    }
  }

  private discardOwnerRangeOps(ino: number, owner: string): void {
    for (const [opId, record] of this.rangeOpDeltas) {
      if (record.ino !== ino || record.owner !== owner) continue;
      this.reservedRangeRollbackSlots -= record.reservedSlots;
      this.rangeOpDeltas.delete(opId);
      this.pendingOps.delete(opId);
    }
  }

  private detachFlockEntry(ino: number, ofdId: string): void {
    const inode = this.byIno.get(ino);
    const existing = inode?.flocks.get(ofdId);
    if (!inode || !existing) return;
    inode.flocks.delete(ofdId);
    this.totalFlocks -= 1;
    this.wakeInode(ino, inode);
    this.pruneInode(ino, inode);
  }

  private installFlock(
    ino: number,
    ofdId: string,
    mode: FlockMode,
    existing: FlockEntry | undefined,
    previousMode: FlockMode | undefined,
    previousOpId: number,
    trackTransaction: boolean,
  ): LockCommit {
    const inode = this.ensureInode(ino);
    const opId = trackTransaction ? this.nextOpId++ : 0;
    if (!trackTransaction && previousOpId !== 0) this.discardFlockChain(previousOpId);
    if (existing) {
      existing.mode = mode;
      existing.opId = opId;
    } else {
      inode.flocks.set(ofdId, { mode, ofdId, opId });
      this.totalFlocks += 1;
    }
    if (!trackTransaction) return { errno: 0 };
    this.pendingOps.add(opId);
    this.flockOpPrev.set(opId, { ino, ofdId, prevMode: previousMode, prevOpId: previousOpId });
    return {
      errno: 0,
      rollback: () => this.rollbackFlock(ino, ofdId, opId),
      settle: () => this.settleFlock(ino, ofdId, opId),
    };
  }

  private settleFlock(ino: number, ofdId: string, opId: number): void {
    if (!this.pendingOps.delete(opId)) return;
    this.flockOpPrev.delete(opId);
    const current = this.byIno.get(ino)?.flocks.get(ofdId);
    if (current && current.opId === opId) current.opId = 0;
    for (const record of this.flockOpPrev.values()) {
      if (record.prevOpId === opId) record.prevOpId = 0;
    }
  }

  private rollbackFlock(ino: number, ofdId: string, opId: number): void {
    if (!this.pendingOps.delete(opId)) return;
    const myPrev = this.flockOpPrev.get(opId);
    this.flockOpPrev.delete(opId);
    if (!myPrev) return;
    for (const record of this.flockOpPrev.values()) {
      if (record.prevOpId !== opId) continue;
      record.prevMode = myPrev.prevMode;
      record.prevOpId = myPrev.prevOpId;
    }
    const inode = this.byIno.get(ino);
    const current = inode?.flocks.get(ofdId);
    if (!inode || !current || current.opId !== opId) return;
    if (myPrev.prevMode === undefined) {
      inode.flocks.delete(ofdId);
      this.totalFlocks -= 1;
      this.wakeInode(ino, inode);
      this.pruneInode(ino, inode);
      return;
    }
    if (this.flockBlockers(inode, ofdId, myPrev.prevMode).length > 0) {
      current.opId = myPrev.prevOpId;
      return;
    }
    current.mode = myPrev.prevMode;
    current.opId = myPrev.prevOpId;
    this.wakeInode(ino, inode);
  }

  private removeFlock(ino: number, ofdId: string): void {
    const inode = this.byIno.get(ino);
    const existing = inode?.flocks.get(ofdId);
    if (!inode || !existing) return;
    inode.flocks.delete(ofdId);
    this.totalFlocks -= 1;
    if (existing.opId !== 0) this.discardFlockChain(existing.opId);
    this.wakeInode(ino, inode);
    this.pruneInode(ino, inode);
  }

  private installRangeLock(
    ino: number,
    owner: string,
    sessionOwner: number,
    posixOwner: number | undefined,
    ofdId: string | undefined,
    pid: number,
    type: RangeType,
    start: number,
    end: number,
    handle: number,
    trackTransaction: boolean,
  ): LockCommit {
    const existingInode = this.byIno.get(ino);
    const opId = trackTransaction ? this.nextOpId++ : 0;
    const edited = editOwnerRanges(
      existingInode?.ranges ?? [],
      owner,
      posixOwner,
      ofdId,
      pid,
      type,
      start,
      end,
      opId,
    );
    const deltaCount = edited.nextCount - edited.previousCount;
    const reservedSlots = trackTransaction ? rollbackReserveForDelta(edited.delta) : 0;
    if (
      this.totalRangeLocks + this.reservedRangeRollbackSlots + deltaCount + reservedSlots >
      this.maxRangeLocks
    )
      return { errno: ENOLCK };
    if (trackTransaction && this.pendingOps.size >= this.maxPendingTransactions)
      return { errno: ENOLCK };
    if (ofdId !== undefined) {
      const originOwner = parseOfdId(ofdId)?.owner ?? sessionOwner;
      this.ensureOfdRecord(ino, handle, ofdId, originOwner);
      this.indexOwnerOfd(sessionOwner, ofdId);
    }
    const inode = existingInode ?? this.ensureInode(ino);
    inode.ranges = edited.next;
    this.adjustRangeCounts(deltaCount, posixOwner !== undefined ? deltaCount : 0);
    if (posixOwner !== undefined) this.indexPosixIno(posixOwner, ino);
    if (edited.relaxed) this.wakeInode(ino, inode);
    if (!trackTransaction) {
      this.recomputeOwnerRangeReserves(ino, owner, inode);
      return { errno: 0 };
    }
    this.pendingOps.add(opId);
    this.reservedRangeRollbackSlots += reservedSlots;
    this.rangeOpDeltas.set(opId, { ino, owner, delta: edited.delta, reservedSlots });
    this.recomputeOwnerRangeReserves(ino, owner, inode);
    return {
      errno: 0,
      rollback: () => this.rollbackRange(ino, owner, posixOwner, ofdId, pid, opId),
      settle: () => this.settleRange(ino, owner, posixOwner, opId),
    };
  }

  private clearSettledRangePrevOp(ino: number, owner: string, opId: number): void {
    for (const record of this.rangeOpDeltas.values()) {
      if (record.ino !== ino || record.owner !== owner) continue;
      for (let i = 0; i < record.delta.length; i++) {
        if (record.delta[i]!.prevOpId === opId) record.delta[i]!.prevOpId = 0;
      }
    }
  }

  private settleRange(
    ino: number,
    owner: string,
    posixOwner: number | undefined,
    opId: number,
  ): void {
    if (!this.pendingOps.delete(opId)) return;
    const record = this.rangeOpDeltas.get(opId);
    if (record) {
      this.reservedRangeRollbackSlots -= record.reservedSlots;
      this.rangeOpDeltas.delete(opId);
    }
    this.clearSettledRangePrevOp(ino, owner, opId);
    const inode = this.byIno.get(ino);
    if (!inode) return;
    const others: RangeLock[] = [];
    const owned: RangeLock[] = [];
    let touched = false;
    for (let i = 0; i < inode.ranges.length; i++) {
      const entry = inode.ranges[i]!;
      if (entry.owner !== owner) {
        others.push(entry);
        continue;
      }
      if (entry.opId === opId) {
        entry.opId = 0;
        touched = true;
      }
      owned.push(entry);
    }
    if (!touched) {
      this.recomputeOwnerRangeReserves(ino, owner, inode);
      return;
    }
    const coalesced = coalesceOwned(owned);
    const deltaCount = coalesced.length - owned.length;
    inode.ranges = others.concat(coalesced);
    if (deltaCount !== 0)
      this.adjustRangeCounts(deltaCount, posixOwner !== undefined ? deltaCount : 0);
    this.recomputeOwnerRangeReserves(ino, owner, inode);
  }

  private rollbackRange(
    ino: number,
    owner: string,
    posixOwner: number | undefined,
    ofdId: string | undefined,
    pid: number,
    opId: number,
  ): void {
    if (!this.pendingOps.delete(opId)) return;
    const myRecord = this.rangeOpDeltas.get(opId);
    this.rangeOpDeltas.delete(opId);
    if (!myRecord) return;
    this.reservedRangeRollbackSlots -= myRecord.reservedSlots;
    for (const record of this.rangeOpDeltas.values()) {
      if (record.ino !== ino || record.owner !== owner) continue;
      record.delta = spliceRangeDelta(record.delta, opId, myRecord.delta);
    }
    const inode = this.byIno.get(ino);
    if (!inode) {
      this.recomputeOwnerRangeReserves(ino, owner, undefined);
      return;
    }
    const others: RangeLock[] = [];
    const keptOwned: RangeLock[] = [];
    const targetSegments: RangeLock[] = [];
    let previousCount = 0;
    for (let i = 0; i < inode.ranges.length; i++) {
      const entry = inode.ranges[i]!;
      if (entry.owner !== owner) {
        others.push(entry);
        continue;
      }
      previousCount += 1;
      if (entry.opId === opId) targetSegments.push(entry);
      else keptOwned.push(entry);
    }
    if (targetSegments.length === 0) {
      this.recomputeOwnerRangeReserves(ino, owner, inode);
      return;
    }
    let woke = false;
    for (let i = 0; i < targetSegments.length; i++) {
      const seg = targetSegments[i]!;
      if (
        this.applyDeltaToSegment(
          inode,
          seg,
          myRecord.delta,
          owner,
          posixOwner,
          ofdId,
          pid,
          keptOwned,
        )
      ) {
        woke = true;
      }
    }
    const coalesced = coalesceOwned(keptOwned);
    const deltaCount = coalesced.length - previousCount;
    inode.ranges = others.concat(coalesced);
    this.adjustRangeCounts(deltaCount, posixOwner !== undefined ? deltaCount : 0);
    if (posixOwner !== undefined && coalesced.length === 0) this.unindexPosixIno(posixOwner, ino);
    this.recomputeOwnerRangeReserves(ino, owner, inode);
    if (woke) this.wakeInode(ino, inode);
    this.pruneInode(ino, inode);
  }

  private applyDeltaToSegment(
    inode: InodeLocks,
    seg: RangeLock,
    delta: readonly RangeDeltaSegment[],
    owner: string,
    posixOwner: number | undefined,
    ofdId: string | undefined,
    pid: number,
    out: RangeLock[],
  ): boolean {
    let woke = false;
    for (let j = 0; j < delta.length; j++) {
      const piece = delta[j]!;
      if (piece.end <= seg.start) continue;
      if (piece.start >= seg.end) break;
      const start = Math.max(seg.start, piece.start);
      const end = Math.min(seg.end, piece.end);
      if (piece.prevType === F_UNLCK) {
        woke = true;
        continue;
      }
      if (piece.prevType === F_RDLCK) {
        if (seg.type === F_WRLCK) woke = true;
        out.push({
          owner,
          posixOwner,
          ofdId,
          pid,
          type: F_RDLCK,
          start,
          end,
          opId: piece.prevOpId,
        });
        continue;
      }
      const canRestoreWrite = this.rangeBlockers(inode, owner, F_WRLCK, start, end).length === 0;
      const restoredType: RangeType = canRestoreWrite ? F_WRLCK : F_RDLCK;
      out.push({
        owner,
        posixOwner,
        ofdId,
        pid,
        type: restoredType,
        start,
        end,
        opId: piece.prevOpId,
      });
    }
    return woke;
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
    this.totalWaiters += 1;
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
      if (index >= 0) {
        inode.waiters.splice(index, 1);
        this.totalWaiters -= 1;
      }
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
    if (inode.flocks.size === 0 && inode.ranges.length === 0 && inode.waiters.length === 0) {
      this.byIno.delete(ino);
    }
  }
}
