import { descriptor, reflectApply as apply } from "./core.ts";

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
