import {
  descriptor,
  reflectApply as apply,
  objectGetPrototypeOf,
  Int32ArrayConstructor,
  BigInt64ArrayConstructor,
  typedArrayBuffer,
  typedArrayByteOffset,
  typedArrayLength,
} from "./core.ts";
export const atomicsOr = Atomics.or;
export const atomicsWaitAsync = (
  Atomics as unknown as {
    waitAsync(
      array: Int32Array,
      index: number,
      value: number,
    ): { async: boolean; value: string | Promise<string> };
  }
).waitAsync;

export const Uint8ArrayConstructor = Uint8Array;
export const Uint32ArrayConstructor = Uint32Array;
export const objectHasOwn = Object.hasOwn;
export const objectCreate = Object.create;
export const objectEntries = Object.entries;
export const objectValues = Object.values;
export const objectKeys = Object.keys;
export const arrayFrom = Array.from;
export const reflectGet = Reflect.get;
export const ProxyConstructor = Proxy;

const prototype = objectGetPrototypeOf(Int32ArrayConstructor.prototype);
type TypedArray = Parameters<typeof typedArrayBuffer>[0];
const byteLengthGetter = descriptor(prototype, "byteLength")!.get!;
const tagGetter = descriptor(prototype, Symbol.toStringTag)!.get!;
const setMethod = prototype.set;
export function typedArrayByteLength(view: TypedArray): number {
  return apply(byteLengthGetter, view, []);
}
export function typedArraySet(
  view: TypedArray,
  source: ArrayLike<number> | ArrayLike<bigint>,
  offset = 0,
): void {
  apply(setMethod, view, [source, offset]);
}
const trunc = Math.trunc,
  min = Math.min,
  max = Math.max;
/** Native subarray still consults the mutable .constructor/@@species chain.
 * These private views instead use their captured intrinsic constructor directly.
 * All callers supply integer bounds on one of these three internal view types. */
export function typedArraySubarray<T extends Int32Array | Uint8Array | BigInt64Array>(
  view: T,
  begin = 0,
  end = typedArrayLength(view),
): T {
  const length = typedArrayLength(view);
  const clamp = (index: number) =>
    index < 0 ? max(length + trunc(index), 0) : min(trunc(index) || 0, length);
  const start = clamp(begin),
    count = max(clamp(end) - start, 0);
  const buffer = typedArrayBuffer(view),
    offset = typedArrayByteOffset(view);
  switch (apply(tagGetter, view, [])) {
    case "BigInt64Array":
      return new BigInt64ArrayConstructor(buffer, offset + start * 8, count) as T;
    case "Int32Array":
      return new Int32ArrayConstructor(buffer, offset + start * 4, count) as T;
    case "Uint8Array":
      return new Uint8ArrayConstructor(buffer, offset + start, count) as T;
    default:
      throw new TypeError("unsupported internal typed array");
  }
}

const mapClearMethod = Map.prototype.clear;
export function mapClear<K, V>(map: Map<K, V>): void {
  apply(mapClearMethod, map, []);
}
export function isInt32Array(value: unknown): value is Int32Array {
  return apply(tagGetter, value, []) === "Int32Array";
}
export function isBigInt64Array(value: unknown): value is BigInt64Array {
  return apply(tagGetter, value, []) === "BigInt64Array";
}

export const BigIntConstructor = BigInt;
const bigintToStringMethod = BigInt.prototype.toString;
export function bigintToString(value: bigint, radix = 10): string {
  return apply(bigintToStringMethod, value, [radix]);
}

export const DataViewConstructor = DataView;
// Importing the core is supported without cross-origin isolation. The captured
// constructor is unavailable there; only actual shared-state allocation needs it.
export const SharedArrayBufferConstructor = globalThis.SharedArrayBuffer;

const sharedPrototype = SharedArrayBufferConstructor?.prototype;
const sharedLength = sharedPrototype && descriptor(sharedPrototype, "byteLength")!.get!;
const sharedMaxLength = sharedPrototype && descriptor(sharedPrototype, "maxByteLength")?.get;
const sharedGrow =
  sharedPrototype && (sharedPrototype as SharedArrayBuffer & { grow(length: number): void }).grow;
export function sharedArrayBufferByteLength(buffer: SharedArrayBuffer): number {
  return apply(sharedLength!, buffer, []);
}
export function sharedArrayBufferMaxByteLength(buffer: SharedArrayBuffer): number {
  return apply(sharedMaxLength!, buffer, []);
}
export function sharedArrayBufferGrow(buffer: SharedArrayBuffer, length: number): void {
  apply(sharedGrow!, buffer, [length]);
}

const getUint32 = DataView.prototype.getUint32;
const setUint32 = DataView.prototype.setUint32;
const setInt32 = DataView.prototype.setInt32;
const getBigUint64 = DataView.prototype.getBigUint64;
const setBigUint64 = DataView.prototype.setBigUint64;
export function dataViewGetUint32(view: DataView, offset: number, littleEndian = false): number {
  return apply(getUint32, view, [offset, littleEndian]);
}
export function dataViewSetUint32(
  view: DataView,
  offset: number,
  value: number,
  littleEndian = false,
): void {
  apply(setUint32, view, [offset, value, littleEndian]);
}
export function dataViewSetInt32(
  view: DataView,
  offset: number,
  value: number,
  littleEndian = false,
): void {
  apply(setInt32, view, [offset, value, littleEndian]);
}
export function dataViewGetBigUint64(view: DataView, offset: number, littleEndian = false): bigint {
  return apply(getBigUint64, view, [offset, littleEndian]);
}
export function dataViewSetBigUint64(
  view: DataView,
  offset: number,
  value: bigint,
  littleEndian = false,
): void {
  apply(setBigUint64, view, [offset, value, littleEndian]);
}

const nativeCrypto = crypto;
export const cryptoGetRandomValues = nativeCrypto.getRandomValues.bind(nativeCrypto);
// Core imports also work outside secure contexts, where UUID allocation is absent.
// Capture without binding; only identity allocation needs this capability.
const randomUUID = nativeCrypto.randomUUID;
export function cryptoRandomUUID(): string {
  return apply(randomUUID, nativeCrypto, []);
}
// Relay scheduling passes a closure over private pipe state to the native timer.
export const scheduleTimeout = globalThis.setTimeout.bind(globalThis);

export const SetConstructor = Set;
export const WeakMapConstructor = WeakMap;
const setHasMethod = Set.prototype.has,
  setAddMethod = Set.prototype.add;
const setDeleteMethod = Set.prototype.delete,
  setForEachMethod = Set.prototype.forEach;
const weakMapGetMethod = WeakMap.prototype.get,
  weakMapSetMethod = WeakMap.prototype.set,
  weakMapHasMethod = WeakMap.prototype.has;
export function weakMapGet<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return apply(weakMapGetMethod, map, [key]);
}
export function weakMapSet<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
  apply(weakMapSetMethod, map, [key, value]);
}
export function weakMapHas<K extends object, V>(map: WeakMap<K, V>, key: K): boolean {
  return apply(weakMapHasMethod, map, [key]);
}
export function setHas<T>(set: ReadonlySet<T>, value: T): boolean {
  return apply(setHasMethod, set, [value]);
}
export function setAdd<T>(set: Set<T>, value: T): void {
  apply(setAddMethod, set, [value]);
}
export function setDelete<T>(set: Set<T>, value: T): boolean {
  return apply(setDeleteMethod, set, [value]);
}
export function setForEach<T>(set: ReadonlySet<T>, callback: (value: T) => void): void {
  apply(setForEachMethod, set, [callback]);
}

export function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
  if (!sharedLength) return false;
  try {
    apply(sharedLength, value, []);
    return true;
  } catch {
    return false;
  }
}
