import {
  atomicsLoad,
  atomicsStore,
  atomicsWait,
  BigInt64ArrayConstructor,
  Int32ArrayConstructor,
  typedArrayLength,
  typedArrayBuffer,
} from "../proc/intrinsics/core.js";
import {
  isSharedArrayBuffer,
  wasmMemoryBuffer,
  sharedArrayBufferByteLength,
} from "../proc/intrinsics/host.js";

const number = Number;
const TRAP = -1;
export const WAIT_REGISTRATION_WORDS = 3;

export interface WaitRegistration {
  readonly generation: number;
  readonly address: number;
  readonly width: 4 | 8;
}

export interface CapturedWaitRegistration extends WaitRegistration {
  readonly buffer: SharedArrayBuffer;
}
export interface WaitLifecycle {
  registered(registration: CapturedWaitRegistration): void;
  cleared(generation: number): void;
}

/** A single guest writer publishes generation last. The page never waits on a guest lock. */
export function readWaitRegistration(cells: Int32Array): WaitRegistration | null {
  const generation = atomicsLoad(cells, 0);
  if (generation === 0) return null;
  const address = atomicsLoad(cells, 1) >>> 0;
  const width = atomicsLoad(cells, 2);
  if (atomicsLoad(cells, 0) !== generation || (width !== 4 && width !== 8)) return null;
  return { generation, address, width };
}

/** Internal imports. Bind once per guest, before instantiation, including its start section. */
export function createSupervisedWaitImports(
  memory: WebAssembly.Memory,
  cells: Int32Array,
  terminal: () => number,
  lifecycle?: WaitLifecycle,
) {
  if (!isSharedArrayBuffer(wasmMemoryBuffer(memory)))
    throw new TypeError("supervised waits require shared guest memory");
  if (typedArrayLength(cells) !== WAIT_REGISTRATION_WORDS)
    throw new RangeError("invalid wait registration length");
  if (!isSharedArrayBuffer(typedArrayBuffer(cells)))
    throw new TypeError("wait registration requires private shared backing");
  if (typedArrayBuffer(cells) === wasmMemoryBuffer(memory))
    throw new TypeError("wait registration must not be guest-writable");
  let generation = 0;

  function wait(
    address: number,
    expected: number | bigint,
    timeout: bigint,
    offset: number,
  ): number {
    const buffer = wasmMemoryBuffer(memory);
    if (!isSharedArrayBuffer(buffer)) return TRAP;
    const width = typeof expected === "bigint" ? 8 : 4;
    const effective = (address >>> 0) + (offset >>> 0);
    if (effective % width !== 0 || effective + width > sharedArrayBufferByteLength(buffer))
      return TRAP;
    if (generation === 0x7fffffff) return TRAP;
    const current = ++generation;
    atomicsStore(cells, 1, effective);
    atomicsStore(cells, 2, width);
    atomicsStore(cells, 0, current);
    let result: number;
    try {
      lifecycle?.registered({ generation: current, address: effective, width, buffer });
      result = terminal() ? TRAP : nativeWait(buffer, effective, expected, timeout);
    } finally {
      atomicsStore(cells, 0, 0);
      lifecycle?.cleared(current);
    }
    return terminal() ? TRAP : result;
  }

  function nativeWait(
    buffer: SharedArrayBuffer,
    address: number,
    expected: number | bigint,
    timeout: bigint,
  ): number {
    const milliseconds = timeout < 0n ? Infinity : number(timeout) / 1_000_000;
    const result =
      typeof expected === "bigint"
        ? atomicsWait(new BigInt64ArrayConstructor(buffer), address / 8, expected, milliseconds)
        : atomicsWait(new Int32ArrayConstructor(buffer), address / 4, expected, milliseconds);
    return result === "ok" ? 0 : result === "not-equal" ? 1 : 2;
  }

  return {
    __waffle_wait32(address: number, expected: number, timeout: bigint, offset: number): number {
      return wait(address, expected, timeout, offset);
    },
    __waffle_wait64(address: number, expected: bigint, timeout: bigint, offset: number): number {
      return wait(address, expected, timeout, offset);
    },
  };
}
