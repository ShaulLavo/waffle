/* Process host intrinsics must be captured before an executor can run guest
 * JavaScript in the same worker realm. Never pass private shared views through
 * a later global/prototype lookup, even when that lookup normally names a native. */

export const atomicsLoad = Atomics.load;
export const atomicsStore = Atomics.store;
export const atomicsCompareExchange = Atomics.compareExchange;
export const atomicsAdd = Atomics.add;
export const atomicsExchange = Atomics.exchange;
export const atomicsNotify = Atomics.notify;
export const atomicsWait = Atomics.wait;
export const BigInt64ArrayConstructor = BigInt64Array;
export const Int32ArrayConstructor = Int32Array;
export const objectFreeze = Object.freeze;
export const objectGetPrototypeOf = Object.getPrototypeOf;
export const reflectApply = Reflect.apply;
const apply = reflectApply;
export const descriptor = Object.getOwnPropertyDescriptor;
const prototype = objectGetPrototypeOf(Int32Array.prototype);
const bufferGetter = descriptor(prototype, "buffer")!.get!;
const offsetGetter = descriptor(prototype, "byteOffset")!.get!;
const lengthGetter = descriptor(prototype, "length")!.get!;

type TypedArray = Int32Array | Uint8Array | Uint32Array | BigInt64Array;
export function typedArrayBuffer(view: TypedArray): ArrayBufferLike {
  return apply(bufferGetter, view, []);
}
export function typedArrayByteOffset(view: TypedArray): number {
  return apply(offsetGetter, view, []);
}
export function typedArrayLength(view: TypedArray): number {
  return apply(lengthGetter, view, []);
}
// Private collections must not pass their receiver or entries through guest methods.
export const MapConstructor = Map;
const mapGetMethod = Map.prototype.get,
  mapSetMethod = Map.prototype.set;
const mapHasMethod = Map.prototype.has,
  mapDeleteMethod = Map.prototype.delete;
const mapForEachMethod = Map.prototype.forEach;
const mapSizeGetter = descriptor(Map.prototype, "size")!.get!;
export function mapGet<K, V>(map: ReadonlyMap<K, V>, key: K): V | undefined {
  return apply(mapGetMethod, map, [key]);
}
export function mapSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  apply(mapSetMethod, map, [key, value]);
}
export function mapHas<K, V>(map: ReadonlyMap<K, V>, key: K): boolean {
  return apply(mapHasMethod, map, [key]);
}
export function mapDelete<K, V>(map: Map<K, V>, key: K): boolean {
  return apply(mapDeleteMethod, map, [key]);
}
export function mapSize(map: ReadonlyMap<unknown, unknown>): number {
  return apply(mapSizeGetter, map, []);
}
export function mapForEach<K, V>(
  map: ReadonlyMap<K, V>,
  callback: (value: V, key: K) => void,
): void {
  apply(mapForEachMethod, map, [callback]);
}
export const objectDefineProperty = Object.defineProperty;
const functionHasInstance = Function.prototype[Symbol.hasInstance];
export function isInstance<T>(
  value: unknown,
  constructor: abstract new (...args: any[]) => T,
): value is T {
  return reflectApply(functionHasInstance, constructor, [value]);
}
/** Define an own array entry without dispatching an inherited indexed setter. */
export function arrayAppend<T>(array: T[], value: T): void {
  const descriptor = {
    __proto__: null,
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  };
  objectDefineProperty(array, array.length, descriptor);
}
