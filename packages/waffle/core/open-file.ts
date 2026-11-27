import { allocateSharedControl } from "../memory/allocator.ts";
import {
  atomicsAdd,
  atomicsCompareExchange,
  atomicsLoad,
  atomicsNotify,
  atomicsStore,
  atomicsWait,
  descriptor,
  Int32ArrayConstructor,
  reflectApply,
  typedArrayBuffer,
} from "../proc/intrinsics/core.ts";
import type { Resource } from "./descriptors.js";
import { FilesystemError, type FileSystem } from "./filesystem.js";
import { FilesystemSection, isRevoked } from "../fs/section.js";
import type { FilesystemIdentity } from "../fs/protocol.js";

const atomicsOr = Atomics.or;
const atomicsAnd = Atomics.and;
const BigUint64ArrayConstructor = BigUint64Array;
const Float64ArrayConstructor = Float64Array;
const WeakMapConstructor = WeakMap;
const weakMapGet = WeakMap.prototype.get;
const weakMapSet = WeakMap.prototype.set;
const objectDefineProperties = Object.defineProperties;
const sabByteLengthGetter = descriptor(SharedArrayBuffer.prototype, "byteLength")!.get!;

type FileResource = Extract<Resource, { kind: "file" }>;
type DirectoryResource = Extract<Resource, { kind: "directory" }>;
type LockableResource = FileResource | DirectoryResource;

interface LocalOfd {
  readonly id: string;
  readonly originOwner: number;
  readonly originSeq: number;
  locked: boolean;
}
interface SharedOfdCells {
  readonly buffer: SharedArrayBuffer;
  readonly cells: Int32Array<SharedArrayBuffer>;
  readonly idPair: BigUint64Array<SharedArrayBuffer>;
  readonly identity: FilesystemIdentity;
}
interface SharedOffset extends SharedOfdCells {
  ownerStates: Int32Array<SharedArrayBuffer>;
  section: FilesystemSection;
  readOffset(): number;
  writeOffset(next: number): void;
  readAppend(): boolean;
}

const OFD_FLAG_LOCKED = 1;
const OFD_FLAG_ORIGIN_CLOSED = 2;

const offsets = new WeakMapConstructor<FileResource, SharedOffset>();
const sharedOfds = new WeakMapConstructor<LockableResource, SharedOfdCells>();
const localOfds = new WeakMapConstructor<LockableResource, LocalOfd>();
let nextLocalOfdSeq = 1;

function getSharedOffset(resource: FileResource): SharedOffset | undefined {
  return reflectApply(weakMapGet, offsets, [resource]) as SharedOffset | undefined;
}

function getSharedOfd(resource: LockableResource): SharedOfdCells | undefined {
  return reflectApply(weakMapGet, sharedOfds, [resource]) as SharedOfdCells | undefined;
}

function getLocalOfd(resource: LockableResource): LocalOfd | undefined {
  return reflectApply(weakMapGet, localOfds, [resource]) as LocalOfd | undefined;
}

function formatOfdId(owner: number, seq: number): string {
  return `${owner}:${seq}`;
}

function packOfdPair(owner: number, seq: number): bigint {
  return (BigInt(seq >>> 0) << 32n) | BigInt(owner >>> 0);
}

function unpackOfdPair(packed: bigint): { readonly owner: number; readonly seq: number } | null {
  const seq = Number((packed >> 32n) & 0xffffffffn);
  if (seq === 0) return null;
  return { owner: Number(packed & 0xffffffffn), seq };
}

function initOfdCells(
  buffer: SharedArrayBuffer,
  resource: LockableResource,
  identity: FilesystemIdentity,
): { cells: Int32Array<SharedArrayBuffer>; idPair: BigUint64Array<SharedArrayBuffer> } {
  const cells = new Int32ArrayConstructor(buffer);
  const idPair = new BigUint64ArrayConstructor(buffer, 16, 1);
  const local = getLocalOfd(resource);
  const originOwner = local ? local.originOwner || identity.owner : identity.owner;
  const originSeq = local ? local.originSeq : nextLocalOfdSeq++;
  atomicsStore(idPair, 0, packOfdPair(originOwner, originSeq));
  atomicsStore(cells, 6, 0);
  if (local?.locked) atomicsStore(cells, 7, OFD_FLAG_LOCKED);
  return { cells, idPair };
}

function sharedOfdId(shared: SharedOfdCells, sessionOwner: number): string {
  const existing = unpackOfdPair(atomicsLoad(shared.idPair, 0));
  if (existing) return formatOfdId(existing.owner, existing.seq);
  const owner = sessionOwner || shared.identity.owner;
  const seq = nextLocalOfdSeq++;
  const packed = packOfdPair(owner, seq);
  const prev = atomicsCompareExchange(shared.idPair, 0, 0n, packed);
  const winner = unpackOfdPair(prev === 0n ? packed : prev)!;
  return formatOfdId(winner.owner, winner.seq);
}

export interface SharedOfdMetadata {
  readonly id: string;
  readonly originOwner: number;
  readonly locked: boolean;
  readonly originClosed: boolean;
  readonly pendingTransfers: number;
}

/** Return (and lazily assign) the open-file-description lock ID for a file or directory resource. */
export function resourceOfdId(resource: LockableResource, sessionOwner = 0): string {
  const shared = getSharedOfd(resource);
  if (shared) return sharedOfdId(shared, sessionOwner);
  let local = getLocalOfd(resource);
  if (!local) {
    const seq = nextLocalOfdSeq++;
    local = {
      id: formatOfdId(sessionOwner, seq),
      originOwner: sessionOwner,
      originSeq: seq,
      locked: false,
    };
    reflectApply(weakMapSet, localOfds, [resource, local]);
  }
  return local.id;
}

export function markResourceOfdLocked(resource: LockableResource, sessionOwner = 0): string {
  const id = resourceOfdId(resource, sessionOwner);
  const shared = getSharedOfd(resource);
  if (shared) {
    atomicsOr(shared.cells, 7, OFD_FLAG_LOCKED);
    return id;
  }
  const local = getLocalOfd(resource);
  if (local) local.locked = true;
  return id;
}

export function markOriginOfdClosed(resource: LockableResource): void {
  const shared = getSharedOfd(resource);
  if (shared) atomicsOr(shared.cells, 7, OFD_FLAG_ORIGIN_CLOSED);
}

export function resourceOfdLockState(
  resource: LockableResource,
): { readonly id: string; readonly shared: boolean } | undefined {
  const shared = getSharedOfd(resource);
  if (shared) {
    if ((atomicsLoad(shared.cells, 7) & OFD_FLAG_LOCKED) === 0) return undefined;
    const pair = unpackOfdPair(atomicsLoad(shared.idPair, 0));
    return pair ? { id: formatOfdId(pair.owner, pair.seq), shared: true } : undefined;
  }
  const local = getLocalOfd(resource);
  if (!local || !local.locked) return undefined;
  return { id: local.id, shared: false };
}

/** Teardown helper shared by Wasi and fd-reopen for originating file/directory descriptions. */
export function releaseOriginOfd(fs: FileSystem, resource: LockableResource): void {
  markOriginOfdClosed(resource);
  const lock = resourceOfdLockState(resource);
  if (lock) {
    try {
      fs.locks?.releaseOfd(resource.handle, lock.id);
    } catch {}
  }
  fs.release(resource.handle);
}

/** Record an in-flight exported reservation referencing this shared OFD buffer. */
export function retainSharedOfdTransfer(buffer: SharedArrayBuffer): void {
  const cells = new Int32ArrayConstructor(buffer);
  atomicsAdd(cells, 6, 1);
}

/** Read shared OFD identity and flags from a promoted open-file control block. */
export function readSharedOfdBuffer(buffer: SharedArrayBuffer): SharedOfdMetadata | undefined {
  if ((reflectApply(sabByteLengthGetter, buffer, []) as number) < 32) return undefined;
  const cells = new Int32ArrayConstructor(buffer);
  const idPair = new BigUint64ArrayConstructor(buffer, 16, 1);
  const pair = unpackOfdPair(atomicsLoad(idPair, 0));
  if (!pair) return undefined;
  const flags = atomicsLoad(cells, 7);
  return {
    id: formatOfdId(pair.owner, pair.seq),
    originOwner: pair.owner,
    locked: (flags & OFD_FLAG_LOCKED) !== 0,
    originClosed: (flags & OFD_FLAG_ORIGIN_CLOSED) !== 0,
    pendingTransfers: atomicsLoad(cells, 6),
  };
}

/** Promote a directory description so inherited copies share one OFD identity and lock lifetime. */
export function shareDirectoryOfd(
  resource: DirectoryResource,
  identity: FilesystemIdentity,
  buffer?: SharedArrayBuffer,
): SharedArrayBuffer {
  const existing = getSharedOfd(resource);
  if (existing) return existing.buffer;
  const shared = buffer ?? allocateSharedControl(32);
  const { cells, idPair } = buffer
    ? {
        cells: new Int32ArrayConstructor(shared),
        idPair: new BigUint64ArrayConstructor(shared, 16, 1),
      }
    : initOfdCells(shared, resource, identity);
  reflectApply(weakMapSet, sharedOfds, [resource, { buffer: shared, cells, idPair, identity }]);
  return shared;
}

/** Promote the existing description in place, so every local dup keeps the same offset. */
export function shareFileResource(
  resource: FileResource,
  identity: FilesystemIdentity,
  buffer?: SharedArrayBuffer,
): SharedArrayBuffer {
  const existing = getSharedOffset(resource);
  if (existing) return existing.buffer;
  const shared = buffer ?? allocateSharedControl(32);
  const ownerStates = new Int32ArrayConstructor(identity.ownerStates);
  // Atomics has no Float64 operation. Share the number's bits, not a signed integer
  // conversion: existing JS offsets above 2^63 must not wrap into negative positions.
  const offset = new BigUint64ArrayConstructor(shared, 8, 1);
  const value = new Float64ArrayConstructor(1);
  const valueBuffer = typedArrayBuffer(value as unknown as Int32Array) as ArrayBuffer;
  const bits = new BigUint64ArrayConstructor(valueBuffer);
  const readOffset = (): number => {
    bits[0] = atomicsLoad(offset, 0);
    return value[0]!;
  };
  const writeOffset = (next: number): void => {
    value[0] = next;
    atomicsStore(offset, 0, bits[0]!);
  };
  let cells: Int32Array<SharedArrayBuffer>;
  let idPair: BigUint64Array<SharedArrayBuffer>;
  if (!buffer) {
    const initialized = initOfdCells(shared, resource, identity);
    cells = initialized.cells;
    idPair = initialized.idPair;
    atomicsStore(cells, 1, ((resource.fdflags ?? 0) & ~1) | (resource.append ? 1 : 0));
    writeOffset(resource.offset);
  } else {
    cells = new Int32ArrayConstructor(shared);
    idPair = new BigUint64ArrayConstructor(shared, 16, 1);
  }
  const readAppend = (): boolean => (atomicsLoad(cells, 1) & 1) !== 0;
  const state: SharedOffset = {
    buffer: shared,
    cells,
    idPair,
    ownerStates,
    identity,
    section: new FilesystemSection(identity),
    readOffset,
    writeOffset,
    readAppend,
  };
  const descriptors = {
    __proto__: null,
    offset: {
      __proto__: null,
      enumerable: true,
      configurable: false,
      get: readOffset,
      set: writeOffset,
    },
    append: {
      __proto__: null,
      enumerable: true,
      configurable: false,
      get: readAppend,
      set: (flag: boolean) => (flag ? atomicsOr(cells, 1, 1) : atomicsAnd(cells, 1, ~1)),
    },
    fdflags: {
      __proto__: null,
      enumerable: true,
      configurable: false,
      get: () => atomicsLoad(cells, 1),
      set: (flags: number) => atomicsStore(cells, 1, flags),
    },
  } as unknown as PropertyDescriptorMap;
  objectDefineProperties(resource, descriptors);
  reflectApply(weakMapSet, offsets, [resource, state]);
  reflectApply(weakMapSet, sharedOfds, [resource, state]);
  return shared;
}

export interface AsyncFileOffsetLease {
  readonly position: number;
  readonly append: boolean;
  commit(nextOffset: number): void;
  release(): void;
}
export type OffsetClaim =
  | { kind: "acquired"; lease: AsyncFileOffsetLease }
  | { kind: "busy"; word: Int32Array; observed: number }
  | { kind: "failed"; errno: number };

/** The operation owner must drain leases before filesystem quiescence can reap this identity.
 * Pass `holdSection = true` only for callers that settle without awaiting transport retirement. */
export function claimFileOffset(resource: FileResource, holdSection = false): OffsetClaim {
  const claim = tryClaimFileOffset(resource, holdSection);
  if (!claim) throw new Error("async file offsets require a shared description");
  return claim;
}

/** Claim a shared file offset when the description is shared; undefined for local descriptions.
 * When `holdSection` is true, keeps the filesystem section entered until `lease.release()` so
 * quiescence waits for the leased operation to settle before reaping the owner. */
export function tryClaimFileOffset(
  resource: FileResource,
  holdSection = false,
): OffsetClaim | undefined {
  const state = getSharedOffset(resource);
  if (!state) return undefined;
  const { cells, ownerStates, identity, section } = state;
  try {
    section.enter();
  } catch (error) {
    if (error instanceof FilesystemError) return { kind: "failed", errno: error.errno };
    throw error;
  }
  let handedToLease = false;
  let acquired = false;
  try {
    const owner = atomicsCompareExchange(cells, 0, 0, identity.owner);
    if (owner === 0) {
      acquired = true;
      const lease = offsetLease(state, holdSection);
      handedToLease = true;
      return { kind: "acquired", lease };
    }
    if (atomicsLoad(ownerStates, owner) === 2) atomicsCompareExchange(cells, 0, owner, 0);
    return { kind: "busy", word: cells, observed: owner };
  } finally {
    if (!handedToLease) {
      if (acquired) {
        atomicsCompareExchange(cells, 0, identity.owner, 0);
        atomicsNotify(cells, 0);
      }
      section.exit();
    } else if (!holdSection) {
      section.exit();
    }
  }
}

function offsetLease(state: SharedOffset, holdSection: boolean): AsyncFileOffsetLease {
  const { cells, identity, section } = state;
  const position = state.readOffset();
  const append = state.readAppend();
  let phase: "held" | "committed" | "released" = "held";
  return {
    position,
    append,
    commit(nextOffset) {
      if (phase !== "held") throw new Error("file offset lease is not uncommitted");
      state.writeOffset(nextOffset);
      phase = "committed";
    },
    release() {
      if (phase === "released") return;
      phase = "released";
      try {
        atomicsCompareExchange(cells, 0, identity.owner, 0);
        atomicsNotify(cells, 0);
      } finally {
        if (holdSection) section.exit();
      }
    },
  };
}

/** Serialize offset selection, I/O and advancement. Positioned I/O need not enter this lock.
 * The section admits before checking revocation, so kill waits for release. A crashed owner's
 * lock is recoverable only after its controller has published the proven-reaped state. */
export function withFileOffset(
  resource: FileResource,
  operation: () => number,
  nonblocking = false,
): number {
  const state = getSharedOffset(resource);
  if (!state) return operation();
  const { cells, identity, section } = state;
  let admitted = false;
  let acquired = false;
  try {
    section.enter();
    admitted = true;
    const result = acquireFileOffset(state, nonblocking);
    if (result < 0) return result;
    acquired = true;
    if (isRevoked(identity)) return -11;
    return operation();
  } catch (error) {
    if (error instanceof FilesystemError) return -error.errno;
    throw error;
  } finally {
    if (acquired) {
      atomicsCompareExchange(cells, 0, identity.owner, 0);
      atomicsNotify(cells, 0);
    }
    if (admitted) section.exit();
  }
}

function acquireFileOffset(
  { cells, ownerStates, identity }: SharedOffset,
  nonblocking: boolean,
): number {
  for (;;) {
    if (isRevoked(identity)) return -11;
    const owner = atomicsCompareExchange(cells, 0, 0, identity.owner);
    if (owner === 0) return 0;
    if (atomicsLoad(ownerStates, owner) === 2) {
      atomicsCompareExchange(cells, 0, owner, 0);
      continue;
    }
    if (nonblocking) return -6;
    // Revocation and reaping notify the identity signal, not this lock word.
    // Recheck both after a bounded park, even if the owner never unlocks.
    atomicsWait(cells, 0, owner, 10);
  }
}
