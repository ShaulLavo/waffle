import { allocateSharedControl } from "../memory/allocator.ts";
import type { Resource } from "./descriptors.js";
import { FilesystemError } from "./filesystem.js";
import { FilesystemSection, isRevoked } from "../fs/section.js";
import type { FilesystemIdentity } from "../fs/protocol.js";

const atomicsLoad = Atomics.load;
const atomicsStore = Atomics.store;
const atomicsCompareExchange = Atomics.compareExchange;
const atomicsOr = Atomics.or;
const atomicsAnd = Atomics.and;
const atomicsNotify = Atomics.notify;
const atomicsWait = Atomics.wait;
const Int32ArrayConstructor = Int32Array;
const BigUint64ArrayConstructor = BigUint64Array;
const Float64ArrayConstructor = Float64Array;
const WeakMapConstructor = WeakMap;
const weakMapGet = WeakMap.prototype.get;
const weakMapSet = WeakMap.prototype.set;
const objectDefineProperties = Object.defineProperties;
const reflectApply = Reflect.apply;

type FileResource = Extract<Resource, { kind: "file" }>;
interface SharedOffset {
  buffer: SharedArrayBuffer;
  cells: Int32Array<SharedArrayBuffer>;
  ownerStates: Int32Array<SharedArrayBuffer>;
  identity: FilesystemIdentity;
  section: FilesystemSection;
  readOffset(): number;
  writeOffset(next: number): void;
  readAppend(): boolean;
}
const offsets = new WeakMapConstructor<FileResource, SharedOffset>();

function getSharedOffset(resource: FileResource): SharedOffset | undefined {
  return reflectApply(weakMapGet, offsets, [resource]) as SharedOffset | undefined;
}

/** Promote the existing description in place, so every local dup keeps the same offset. */
export function shareFileResource(
  resource: FileResource,
  identity: FilesystemIdentity,
  buffer?: SharedArrayBuffer,
): SharedArrayBuffer {
  const existing = getSharedOffset(resource);
  if (existing) return existing.buffer;
  const shared = buffer ?? allocateSharedControl(16);
  const cells = new Int32ArrayConstructor(shared);
  const ownerStates = new Int32ArrayConstructor(identity.ownerStates);
  // Atomics has no Float64 operation. Share the number's bits, not a signed integer
  // conversion: existing JS offsets above 2^63 must not wrap into negative positions.
  const offset = new BigUint64ArrayConstructor(shared, 8, 1);
  const value = new Float64ArrayConstructor(1);
  const bits = new BigUint64ArrayConstructor(value.buffer);
  const readOffset = (): number => {
    bits[0] = atomicsLoad(offset, 0);
    return value[0]!;
  };
  const writeOffset = (next: number): void => {
    value[0] = next;
    atomicsStore(offset, 0, bits[0]!);
  };
  const readAppend = (): boolean => (atomicsLoad(cells, 1) & 1) !== 0;
  if (!buffer) {
    atomicsStore(cells, 1, ((resource.fdflags ?? 0) & ~1) | (resource.append ? 1 : 0));
    writeOffset(resource.offset);
  }
  reflectApply(weakMapSet, offsets, [
    resource,
    {
      buffer: shared,
      cells,
      ownerStates,
      identity,
      section: new FilesystemSection(identity),
      readOffset,
      writeOffset,
      readAppend,
    },
  ]);
  objectDefineProperties(resource, {
    offset: {
      enumerable: true,
      configurable: false,
      get: readOffset,
      set: writeOffset,
    },
    append: {
      enumerable: true,
      configurable: false,
      get: readAppend,
      set: (flag: boolean) => (flag ? atomicsOr(cells, 1, 1) : atomicsAnd(cells, 1, ~1)),
    },
    fdflags: {
      enumerable: true,
      configurable: false,
      get: () => atomicsLoad(cells, 1),
      set: (flags: number) => atomicsStore(cells, 1, flags),
    },
  });
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

/** The operation owner must drain leases before filesystem quiescence can reap this identity. */
export function claimFileOffset(resource: FileResource): OffsetClaim {
  const claim = tryClaimFileOffset(resource);
  if (!claim) throw new Error("async file offsets require a shared description");
  return claim;
}

/** Claim a shared file offset when the description is shared; undefined for local descriptions.
 * Keeps the filesystem section entered until the returned lease is released so quiescence and
 * session cleanup wait for the leased operation to settle. */
export function tryClaimFileOffset(resource: FileResource): OffsetClaim | undefined {
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
      const lease = offsetLease(state);
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
    }
  }
}

function offsetLease(state: SharedOffset): AsyncFileOffsetLease {
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
        section.exit();
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
