import type { Stream, VirtualFileState } from "./descriptors.js";

const Uint8ArrayConstructor = Uint8Array;
const stringCharCodeAt = String.prototype.charCodeAt;
const copyBytes = Uint8Array.prototype.set;
const sliceBytes = Uint8Array.prototype.subarray;
const apply = Reflect.apply;

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

/** Read-only virtual regular file serving `/etc/machine-id` when no physical file exists. */
export function createMachineIdFile(machineId: string, fdflags = 0, offset = 0): Stream {
  const data = encodeMachineIdBytes(machineId);
  const state: VirtualFileState = {
    ino: MACHINE_ID_INO,
    machineId,
    data,
    offset,
  };
  const read = (chunks: readonly Uint8Array[]): number => {
    const count = readVirtualFileBytes(data, chunks, state.offset);
    state.offset += count;
    return count;
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
      nbytes: Math.max(0, data.length - state.offset),
    }),
    close() {},
  };
}
