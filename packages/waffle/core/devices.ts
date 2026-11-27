import { allocateSharedControl } from "../memory/allocator.ts";
import {
  atomicsCompareExchange,
  atomicsLoad,
  atomicsStore,
  Int32ArrayConstructor,
  reflectApply,
} from "../proc/intrinsics/core.ts";
import type { Stream, VirtualFileState } from "./descriptors.js";

const Uint8ArrayConstructor = Uint8Array;
const WeakMapConstructor = WeakMap;
const weakMapGet = WeakMap.prototype.get;
const weakMapSet = WeakMap.prototype.set;
const stringCharCodeAt = String.prototype.charCodeAt;
const copyBytes = Uint8Array.prototype.set;
const sliceBytes = Uint8Array.prototype.subarray;
const apply = reflectApply;

interface SharedVirtualCursor {
  buffer?: SharedArrayBuffer;
  cell?: Int32Array<SharedArrayBuffer>;
  local: number;
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

function readCursor(cursor: SharedVirtualCursor): number {
  return cursor.cell ? atomicsLoad(cursor.cell, 0) : cursor.local;
}

function writeCursor(cursor: SharedVirtualCursor, next: number): void {
  const clamped = Math.min(0x7fffffff, Math.max(0, next));
  if (cursor.cell) atomicsStore(cursor.cell, 0, clamped);
  else cursor.local = clamped;
}

function claimCursorSpan(
  cursor: SharedVirtualCursor,
  dataLength: number,
  requested: number,
): number {
  if (!cursor.cell) {
    const start = cursor.local;
    const count = Math.min(requested, Math.max(0, dataLength - start));
    cursor.local = start + count;
    return start;
  }
  for (;;) {
    const start = atomicsLoad(cursor.cell, 0);
    const count = Math.min(requested, Math.max(0, dataLength - start));
    if (count === 0) return start;
    if (atomicsCompareExchange(cursor.cell, 0, start, start + count) === start) return start;
  }
}

/** Promote a virtual `/etc/machine-id` file cursor to shared memory for cross-process transfer. */
export function shareMachineIdOffset(state: VirtualFileState): SharedArrayBuffer {
  const cursor = apply(weakMapGet, virtualCursors, [state]) as SharedVirtualCursor | undefined;
  if (!cursor) throw new TypeError("missing virtual file cursor");
  if (cursor.buffer) return cursor.buffer;
  const buffer = allocateSharedControl(4);
  const cell = new Int32ArrayConstructor(buffer);
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
      ? { local: offsetOrBuffer }
      : {
          buffer: offsetOrBuffer,
          cell: new Int32ArrayConstructor(offsetOrBuffer),
          local: 0,
        };
  const state: VirtualFileState = {
    ino: MACHINE_ID_INO,
    machineId,
    data,
    get offset(): number {
      return readCursor(cursor);
    },
    set offset(next: number) {
      writeCursor(cursor, next);
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
    readiness: () => ({
      readable: true,
      writable: false,
      hangup: false,
      nbytes: Math.max(0, data.length - readCursor(cursor)),
    }),
    close() {},
  };
}
