import { ProcessError, ProcessErrno } from "../proc/errors.ts";
import {
  BigInt64ArrayConstructor,
  BigIntConstructor,
  SharedArrayBufferConstructor,
  atomicsLoad,
  atomicsCompareExchange,
  atomicsAdd,
  sharedArrayBufferByteLength,
} from "../proc/intrinsics.ts";

/** Bounded grants count all allocations for an incarnation, not just currently open pipes. */
export type SharedControlGrant =
  | { readonly kind: "unbounded" }
  | { readonly kind: "bounded"; readonly state: SharedArrayBuffer; readonly limit: number };
export const CONTROL_GRANT_BYTES = 64 * 1024 * 1024;
export const CONTROL_GRANT_STATE_BYTES = 8;
const validInteger = Number.isSafeInteger;

function claim(grant: Extract<SharedControlGrant, { kind: "bounded" }>, length: number): void {
  const state = new BigInt64ArrayConstructor(grant.state);
  for (;;) {
    const previous = atomicsLoad(state, 0);
    const next = previous + BigIntConstructor(length);
    if (next > BigIntConstructor(grant.limit))
      throw new ProcessError(ProcessErrno.NOMEM, "Guest shared control byte grant exhausted");
    if (atomicsCompareExchange(state, 0, previous, next) === previous) return;
  }
}
/** Captured natives keep the grant and new buffers out of guest-mutable constructors. */
export function createSharedControlAllocator(
  grant: SharedControlGrant,
  receipt: (buffer: SharedArrayBuffer) => void,
): (length: number) => SharedArrayBuffer {
  if (
    grant.kind === "bounded" &&
    sharedArrayBufferByteLength(grant.state) !== CONTROL_GRANT_STATE_BYTES
  )
    throw new ProcessError(ProcessErrno.INVAL, "Invalid shared control grant");
  return (length) => {
    if (!validInteger(length) || length < 0)
      throw new ProcessError(ProcessErrno.INVAL, "Invalid shared control allocation");
    if (grant.kind === "bounded") claim(grant, length);
    const buffer = construct(grant, length);
    // A failure publishing an already allocated buffer is not a reclamation receipt.
    receipt(buffer);
    return buffer;
  };
}
function construct(grant: SharedControlGrant, length: number): SharedArrayBuffer {
  try {
    return new SharedArrayBufferConstructor(length);
  } catch (error) {
    if (grant.kind === "bounded")
      atomicsAdd(new BigInt64ArrayConstructor(grant.state), 0, -BigIntConstructor(length));
    throw error;
  }
}
/** Host-only observation after a proven physical stop; never a guest request. */
export function consumedControlBytes(grant: SharedControlGrant): number {
  return grant.kind === "bounded"
    ? Number(atomicsLoad(new BigInt64ArrayConstructor(grant.state), 0))
    : 0;
}

export { allocateSharedControl, installSharedControlAllocator } from "./allocator.ts";

const HostMemory = WebAssembly.Memory;
/** The real two-page host-program WASI scratch memory shares the bounded control quota. */
export function allocateHostProgramMemory(grant: SharedControlGrant): WebAssembly.Memory {
  const length = 2 * 65_536;
  if (grant.kind === "bounded") claim(grant, length);
  try {
    return new HostMemory({ initial: 2, maximum: 2 });
  } catch (error) {
    if (grant.kind === "bounded")
      atomicsAdd(new BigInt64ArrayConstructor(grant.state), 0, -BigIntConstructor(length));
    throw error;
  }
}
