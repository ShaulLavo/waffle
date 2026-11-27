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

const EAGAIN = 6;
const ECANCELED = 11;
const EDEADLK = 16;
const EINVAL = 28;

type FlockMode = "sh" | "ex";
type RangeType = typeof F_RDLCK | typeof F_WRLCK;

interface FlockEntry {
  mode: FlockMode;
  readonly ofdId: string;
  readonly holders: Map<number, number>;
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
  readonly trackDeadlock: boolean;
  resolved: boolean;
  readonly wake: () => void;
  readonly cancel: (errno: number) => void;
}

interface InodeLocks {
  readonly flocks: Map<string, FlockEntry>;
  ranges: RangeLock[];
  waiters: Waiter[];
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
): { next: RangeLock[]; previousOwner: RangeLock[]; relaxed: boolean } {
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
  return { next: others.concat(coalesceOwned(owned)), previousOwner, relaxed };
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
  private readonly ownerInos = new Map<number, Set<number>>();
  private readonly waitingOn = new Map<string, Set<string>>();
  private readonly waitersBySession = new Map<number, Set<Waiter>>();
  private nextWaiterId = 1;

  flock(
    ino: number,
    ofdId: string,
    sessionOwner: number,
    operation: number,
    allowWait = false,
  ): LockCommit {
    const parsed = normalizeFlockOp(operation);
    if (!parsed) return { errno: EINVAL };
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
    return this.installFlock(ino, ofdId, sessionOwner, mode, existing);
  }

  retainOfd(ino: number, ofdId: string, sessionOwner: number): void {
    const inode = this.byIno.get(ino);
    if (!inode) return;
    let touched = false;
    const flock = inode.flocks.get(ofdId);
    if (flock) {
      flock.holders.set(sessionOwner, (flock.holders.get(sessionOwner) ?? 0) + 1);
      touched = true;
    }
    if (touched) this.indexOwnerIno(sessionOwner, ino);
  }

  releaseOfd(ino: number, ofdId: string, sessionOwner?: number): void {
    const inode = this.byIno.get(ino);
    if (!inode) return;
    let changed = false;
    const flock = inode.flocks.get(ofdId);
    if (flock) {
      if (sessionOwner !== undefined) flock.holders.delete(sessionOwner);
      if (sessionOwner === undefined || flock.holders.size === 0) {
        inode.flocks.delete(ofdId);
        changed = true;
      }
    }
    const key = ofdOwnerKey(ofdId);
    const before = inode.ranges.length;
    inode.ranges = inode.ranges.filter((entry) => entry.owner !== key);
    if (inode.ranges.length !== before) changed = true;
    if (changed) this.wakeInode(ino, inode);
    this.pruneInode(ino, inode);
  }

  setRangeLock(
    ino: number,
    ofdId: string | undefined,
    sessionOwner: number,
    pid: number,
    range: FileLockRange,
    blocking: boolean,
    allowWait = false,
  ): LockCommit {
    if (range.type !== F_RDLCK && range.type !== F_WRLCK && range.type !== F_UNLCK)
      return { errno: EINVAL };
    const end = rangeEndOf(range.start, range.len);
    if (end < 0) return { errno: EINVAL };
    const owner = ofdId === undefined ? posixOwnerKey(sessionOwner) : ofdOwnerKey(ofdId);
    const inode = this.byIno.get(ino);
    if (range.type === F_UNLCK) {
      if (!inode) return { errno: 0 };
      const edited = editOwnerRanges(
        inode.ranges,
        owner,
        sessionOwner,
        ofdId,
        pid,
        F_UNLCK,
        range.start,
        end,
      );
      inode.ranges = edited.next;
      if (edited.relaxed) this.wakeInode(ino, inode);
      this.pruneInode(ino, inode);
      return { errno: 0 };
    }
    const blockers = inode ? this.rangeBlockers(inode, owner, range.type, range.start, end) : [];
    if (blockers.length > 0) {
      if (!blocking || !allowWait) return { errno: EAGAIN };
      const trackDeadlock = ofdId === undefined;
      if (trackDeadlock && this.wouldDeadlock(owner, blockers)) return { errno: EDEADLK };
      throw this.enqueueWaiter(ino, owner, sessionOwner, blockers, trackDeadlock);
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
    if (range.type !== F_RDLCK && range.type !== F_WRLCK && range.type !== F_UNLCK) return EINVAL;
    const end = rangeEndOf(range.start, range.len);
    if (end < 0) return EINVAL;
    const clear: FileLockConflict = { type: F_UNLCK, pid: 0, start: 0, len: 0 };
    if (range.type === F_UNLCK) return clear;
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
    const inode = this.byIno.get(ino);
    if (!inode) return;
    const owner = posixOwnerKey(sessionOwner);
    const before = inode.ranges.length;
    inode.ranges = inode.ranges.filter((entry) => entry.owner !== owner);
    if (inode.ranges.length !== before) this.wakeInode(ino, inode);
    this.pruneInode(ino, inode);
  }

  releaseSession(sessionOwner: number): void {
    const waiters = this.waitersBySession.get(sessionOwner);
    if (waiters) {
      for (const waiter of Array.from(waiters)) waiter.cancel(ECANCELED);
      this.waitersBySession.delete(sessionOwner);
    }
    const inos = this.ownerInos.get(sessionOwner);
    if (!inos) return;
    this.ownerInos.delete(sessionOwner);
    const posixOwner = posixOwnerKey(sessionOwner);
    for (const ino of Array.from(inos)) {
      this.releaseSessionInode(ino, sessionOwner, posixOwner);
    }
  }

  dispose(): void {
    for (const inode of Array.from(this.byIno.values())) {
      for (const waiter of inode.waiters.slice()) waiter.cancel(ECANCELED);
    }
    this.byIno.clear();
    this.ownerInos.clear();
    this.waitingOn.clear();
    this.waitersBySession.clear();
  }

  private releaseSessionInode(ino: number, sessionOwner: number, posixOwner: string): void {
    const inode = this.byIno.get(ino);
    if (!inode) return;
    let changed = false;
    for (const [ofdId, entry] of Array.from(inode.flocks)) {
      if (!entry.holders.delete(sessionOwner)) continue;
      if (entry.holders.size === 0) {
        inode.flocks.delete(ofdId);
        changed = true;
      }
    }
    const before = inode.ranges.length;
    inode.ranges = inode.ranges.filter(
      (entry) => entry.owner !== posixOwner && entry.sessionOwner !== sessionOwner,
    );
    if (inode.ranges.length !== before) changed = true;
    if (changed) this.wakeInode(ino, inode);
    this.pruneInode(ino, inode);
  }

  private ensureInode(ino: number): InodeLocks {
    let inode = this.byIno.get(ino);
    if (!inode) {
      inode = { flocks: new Map(), ranges: [], waiters: [] };
      this.byIno.set(ino, inode);
    }
    return inode;
  }

  private indexOwnerIno(sessionOwner: number, ino: number): void {
    let set = this.ownerInos.get(sessionOwner);
    if (!set) {
      set = new Set();
      this.ownerInos.set(sessionOwner, set);
    }
    set.add(ino);
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
    sessionOwner: number,
    mode: FlockMode,
    existing: FlockEntry | undefined,
  ): LockCommit {
    const inode = this.ensureInode(ino);
    const previousMode = existing?.mode;
    const previousHolderCount = existing?.holders.get(sessionOwner);
    if (existing) {
      existing.mode = mode;
      if (!existing.holders.has(sessionOwner)) existing.holders.set(sessionOwner, 1);
      if (previousMode === "ex" && mode === "sh") this.wakeInode(ino, inode);
    } else {
      const holders = new Map<number, number>([[sessionOwner, 1]]);
      inode.flocks.set(ofdId, { mode, ofdId, holders });
    }
    this.indexOwnerIno(sessionOwner, ino);
    return {
      errno: 0,
      rollback: () =>
        this.rollbackFlock(ino, ofdId, sessionOwner, previousMode, previousHolderCount),
    };
  }

  private rollbackFlock(
    ino: number,
    ofdId: string,
    sessionOwner: number,
    previousMode: FlockMode | undefined,
    previousHolderCount: number | undefined,
  ): void {
    const inode = this.byIno.get(ino);
    const current = inode?.flocks.get(ofdId);
    if (!inode || !current) return;
    if (previousMode === undefined) {
      current.holders.delete(sessionOwner);
      if (current.holders.size === 0) inode.flocks.delete(ofdId);
      this.wakeInode(ino, inode);
      this.pruneInode(ino, inode);
      return;
    }
    current.mode = previousMode;
    if (previousHolderCount === undefined) current.holders.delete(sessionOwner);
    else current.holders.set(sessionOwner, previousHolderCount);
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
    inode.ranges = edited.next;
    this.indexOwnerIno(sessionOwner, ino);
    if (edited.relaxed) this.wakeInode(ino, inode);
    const snapshot = edited.previousOwner;
    return {
      errno: 0,
      rollback: () => this.rollbackRange(ino, owner, snapshot),
    };
  }

  private rollbackRange(ino: number, owner: string, previousOwner: readonly RangeLock[]): void {
    const inode = this.byIno.get(ino);
    if (!inode) return;
    const others = inode.ranges.filter((entry) => entry.owner !== owner);
    inode.ranges = others.concat(previousOwner.map(cloneRange));
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
    const waiter: Waiter = {
      id: this.nextWaiterId++,
      ino,
      owner,
      sessionOwner,
      trackDeadlock,
      resolved: false,
      wake: () => {
        if (waiter.resolved) return;
        waiter.resolved = true;
        this.detachWaiter(waiter);
        deferred.resolve();
      },
      cancel: () => {
        if (waiter.resolved) return;
        waiter.resolved = true;
        this.detachWaiter(waiter);
        deferred.resolve();
      },
    };
    inode.waiters.push(waiter);
    let sessionWaiters = this.waitersBySession.get(sessionOwner);
    if (!sessionWaiters) {
      sessionWaiters = new Set();
      this.waitersBySession.set(sessionOwner, sessionWaiters);
    }
    sessionWaiters.add(waiter);
    if (trackDeadlock) {
      let edges = this.waitingOn.get(owner);
      if (!edges) {
        edges = new Set();
        this.waitingOn.set(owner, edges);
      }
      for (let i = 0; i < blockers.length; i++) edges.add(blockers[i]!);
    }
    return new LockContentionError(deferred.promise, () => waiter.cancel(ECANCELED));
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
    if (waiter.trackDeadlock) this.waitingOn.delete(waiter.owner);
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
