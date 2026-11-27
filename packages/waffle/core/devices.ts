import { allocateSharedControl } from "../memory/allocator.ts";
import {
  atomicsCompareExchange,
  atomicsLoad,
  atomicsStore,
  BigInt64ArrayConstructor,
  reflectApply,
} from "../proc/intrinsics/core.ts";
import type { Stream, VirtualFileState } from "./descriptors.js";

const BigIntConstructor = BigInt;
const Uint8ArrayConstructor = Uint8Array;
const WeakMapConstructor = WeakMap;
const weakMapGet = WeakMap.prototype.get;
const weakMapSet = WeakMap.prototype.set;
const stringCharCodeAt = String.prototype.charCodeAt;
const copyBytes = Uint8Array.prototype.set;
const sliceBytes = Uint8Array.prototype.subarray;
const apply = reflectApply;

const MAX_VIRTUAL_OFFSET = 0x7fff_ffff_ffff_ffffn;

interface SharedVirtualCursor {
  buffer?: SharedArrayBuffer;
  cell?: BigInt64Array<SharedArrayBuffer>;
  local: bigint;
}

const virtualCursors = new WeakMapConstructor<VirtualFileState, SharedVirtualCursor>();

/** Synthetic inode for virtual `/etc/machine-id` (distinct from physical VFS inodes). */
export const MACHINE_ID_INO = 0x7fff_fffe;
/** Byte length of `/etc/machine-id` contents: 32 lowercase hex characters plus trailing newline. */
export const MACHINE_ID_FILE_SIZE = 33;

function discard(chunks: readonly Uint8Array[]): number {
  let total = 0;
  for (let i = 0; i < chunks.length; i++) total += chunks[i]!.length;
  return total;
}

/** Validate a systemd machine-id(5) string: exactly 32 lowercase ASCII hex digits. */
export function isValidMachineId(value: string): boolean {
  if (value.length !== 32) return false;
  for (let i = 0; i < 32; i++) {
    const code = apply(stringCharCodeAt, value, [i]);
    const isDigit = code >= 48 && code <= 57;
    const isLowerHex = code >= 97 && code <= 102;
    if (!isDigit && !isLowerHex) return false;
  }
  return true;
}

/** Assert a valid 32-char lowercase hex machine-id(5) string. */
export function validateMachineId(value: unknown): string {
  if (typeof value !== "string" || !isValidMachineId(value))
    throw new TypeError("machineId must be 32 lowercase hexadecimal characters");
  return value;
}

/** Encode a validated 32-char hex machine-id as the 33-byte `/etc/machine-id` payload. */
function encodeMachineIdBytes(machineId: string): Uint8Array {
  const bytes = new Uint8ArrayConstructor(MACHINE_ID_FILE_SIZE);
  for (let i = 0; i < 32; i++) bytes[i] = apply(stringCharCodeAt, machineId, [i]);
  bytes[32] = 10;
  return bytes;
}

/** Copy from a read-only virtual byte buffer starting at `offset` into guest iovecs. */
export function readVirtualFileBytes(
  data: Uint8Array,
  chunks: readonly Uint8Array[],
  offset: number,
): number {
  let pos = offset;
  let total = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (pos >= data.length) break;
    const chunk = chunks[i]!;
    const count = Math.min(chunk.length, data.length - pos);
    if (count > 0) {
      apply(copyBytes, chunk, [apply(sliceBytes, data, [pos, pos + count])]);
      pos += count;
      total += count;
    }
  }
  return total;
}

/** Process-local character devices do not create nodes or retain filesystem payloads. */
export function createNullDevice(fdflags = 0): Stream {
  return {
    kind: "device",
    device: "null",
    fdflags,
    read: () => 0,
    tryRead: () => 0,
    write: discard,
    tryWrite: discard,
    readiness: () => ({ readable: true, writable: true, hangup: false }),
    close() {},
  };
}

function readCursorBigInt(cursor: SharedVirtualCursor): bigint {
  if (!cursor.cell) return cursor.local;
  const raw = atomicsLoad(cursor.cell, 0);
  return raw < 0n ? 0n : raw;
}

function writeCursorBigInt(cursor: SharedVirtualCursor, next: bigint): void {
  let clamped = next;
  if (clamped < 0n) clamped = 0n;
  if (clamped > MAX_VIRTUAL_OFFSET) clamped = MAX_VIRTUAL_OFFSET;
  if (cursor.cell) atomicsStore(cursor.cell, 0, clamped);
  else cursor.local = clamped;
}

function claimCursorSpan(
  cursor: SharedVirtualCursor,
  dataLength: number,
  requested: number,
): number {
  const dataLenBig = BigIntConstructor(dataLength);
  if (!cursor.cell) {
    const start = cursor.local;
    if (start >= dataLenBig) return dataLength;
    const startNum = Number(start);
    const count = Math.min(requested, dataLength - startNum);
    cursor.local = start + BigIntConstructor(count);
    return startNum;
  }
  for (;;) {
    const raw = atomicsLoad(cursor.cell, 0);
    const start = raw < 0n ? 0n : raw;
    if (start >= dataLenBig) return dataLength;
    const startNum = Number(start);
    const count = Math.min(requested, dataLength - startNum);
    if (count === 0) return startNum;
    const next = start + BigIntConstructor(count);
    if (atomicsCompareExchange(cursor.cell, 0, raw, next) === raw) return startNum;
  }
}

function cursorForState(state: VirtualFileState): SharedVirtualCursor {
  const cursor = apply(weakMapGet, virtualCursors, [state]) as SharedVirtualCursor | undefined;
  if (!cursor) throw new TypeError("missing virtual file cursor");
  return cursor;
}

/** Atomically read the current 64-bit byte offset of a virtual regular file. */
export function tellVirtualFile(state: VirtualFileState): bigint {
  return readCursorBigInt(cursorForState(state));
}

/** Atomically seek a virtual regular file; returns the new 64-bit offset or negative WASI errno. */
export function seekVirtualFile(
  state: VirtualFileState,
  delta: bigint,
  whence: number,
): bigint | number {
  const cursor = cursorForState(state);
  if (whence === 0 || whence === 2) {
    const base = whence === 0 ? 0n : BigIntConstructor(state.data.length);
    const next = base + delta;
    if (next < 0n || next > MAX_VIRTUAL_OFFSET) return -28;
    if (cursor.cell) atomicsStore(cursor.cell, 0, next);
    else cursor.local = next;
    return next;
  }
  if (whence !== 1) return -28;
  if (!cursor.cell) {
    const next = cursor.local + delta;
    if (next < 0n || next > MAX_VIRTUAL_OFFSET) return -28;
    cursor.local = next;
    return next;
  }
  for (;;) {
    const raw = atomicsLoad(cursor.cell, 0);
    const current = raw < 0n ? 0n : raw;
    const next = current + delta;
    if (next < 0n || next > MAX_VIRTUAL_OFFSET) return -28;
    if (delta === 0n) return current;
    if (atomicsCompareExchange(cursor.cell, 0, raw, next) === raw) return next;
  }
}

/** Promote a virtual `/etc/machine-id` file cursor to shared memory for cross-process transfer. */
export function shareMachineIdOffset(state: VirtualFileState): SharedArrayBuffer {
  const cursor = cursorForState(state);
  if (cursor.buffer) return cursor.buffer;
  const buffer = allocateSharedControl(8);
  const cell = new BigInt64ArrayConstructor(buffer);
  atomicsStore(cell, 0, cursor.local);
  cursor.buffer = buffer;
  cursor.cell = cell;
  return buffer;
}

/** Read-only virtual regular file serving `/etc/machine-id` when no physical file exists. */
export function createMachineIdFile(
  machineId: string,
  fdflags = 0,
  offsetOrBuffer: number | SharedArrayBuffer = 0,
): Stream {
  const data = encodeMachineIdBytes(machineId);
  const cursor: SharedVirtualCursor =
    typeof offsetOrBuffer === "number"
      ? { local: BigIntConstructor(Math.max(0, Math.trunc(offsetOrBuffer))) }
      : {
          buffer: offsetOrBuffer,
          cell: new BigInt64ArrayConstructor(offsetOrBuffer),
          local: 0n,
        };
  const state: VirtualFileState = {
    ino: MACHINE_ID_INO,
    machineId,
    data,
    get offset(): number {
      return Number(readCursorBigInt(cursor));
    },
    set offset(next: number) {
      if (!Number.isFinite(next)) return;
      writeCursorBigInt(cursor, BigIntConstructor(Math.max(0, Math.trunc(next))));
    },
  };
  apply(weakMapSet, virtualCursors, [state, cursor]);
  const read = (chunks: readonly Uint8Array[]): number => {
    let requested = 0;
    for (let i = 0; i < chunks.length; i++) requested += chunks[i]!.length;
    const start = claimCursorSpan(cursor, data.length, requested);
    return readVirtualFileBytes(data, chunks, start);
  };
  return {
    kind: "device",
    device: "machine-id",
    virtualFile: state,
    fdflags,
    read,
    tryRead: read,
    write: () => -2,
    tryWrite: () => -2,
    readiness: () => {
      const current = readCursorBigInt(cursor);
      const dataLenBig = BigIntConstructor(data.length);
      return {
        readable: true,
        writable: false,
        hangup: false,
        nbytes: current >= dataLenBig ? 0 : data.length - Number(current),
      };
    },
    close() {},
  };
}
