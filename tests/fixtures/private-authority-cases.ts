// Parsed but never executed: deliberately unsafe examples for the static guard.
import type { Descriptor, Stream } from "../../core/descriptors.js";
import { objectDefineProperty, Int32ArrayConstructor, Int32ArrayConstructor as SafeView, atomicsLoad, typedArrayBuffer, typedArraySubarray, mapGet, MapConstructor } from "../../proc/intrinsics.ts";

type PrivateAlias = SharedArrayBuffer;
type NestedAlias = Map<number, Descriptor>;

export function liveAtomics(buffer: PrivateAlias): number {
  const inferred = new Int32ArrayConstructor(buffer);
  return Atomics.load(inferred, 0);
}
export function liveConstructor(buffer: PrivateAlias): Int32Array { return new Int32Array(buffer); }
export function liveGetter(buffer: PrivateAlias): ArrayBufferLike {
  const inferred = new Int32ArrayConstructor(buffer);
  return inferred.buffer;
}
export function liveSubview(view: Int32Array): Int32Array { return view.subarray(1); }
export function privateMap(entries: NestedAlias): Descriptor | undefined { return entries.get(1); }
export function inferredMap(stream: Stream): boolean {
  const entries = new MapConstructor<number, Stream>();
  entries.set(1, stream);
  return entries.has(1);
}
export function liveIteration(entries: Map<number, Descriptor>): void {
  for (const entry of entries) void entry;
}
export function liveSpread(entries: readonly Descriptor[]): Descriptor[] { return [...entries]; }
export function liveArrayMethod(entries: Descriptor[]): Descriptor[] { return entries.filter(() => true); }
export function liveArrayFrom(entries: Descriptor[]): Descriptor[] { return Array.from(entries); }
export function liveReflection(stream: Stream): object { return Object.getPrototypeOf(stream); }
export function liveApply(stream: Stream): unknown { return Reflect.apply(stream.read, stream, [[]]); }
export function liveCall(stream: Stream): number { return stream.read.call(stream, []); }
export function liveBind(stream: Stream): unknown { return stream.read.bind(stream); }
export function liveProxy(stream: Stream): Stream { return new Proxy(stream, {}); }
export function species(view: Int32Array): unknown { return view.constructor; }
export function iterator(entries: Descriptor[]): unknown { return entries[Symbol.iterator]; }
export function captured(buffer: PrivateAlias): ArrayBufferLike {
  const entries = new MapConstructor<number, Stream>();
  void mapGet(entries, 1);
  const view = new Int32ArrayConstructor(buffer);
  atomicsLoad(view, 0);
  return typedArrayBuffer(typedArraySubarray(view, 1));
}
export function indexed(entries: readonly Descriptor[]): void {
  for (let i = 0; i < entries.length; i++) void entries[i];
}
export function ordinaryPayload(values: string[]): string[] { return values.map(value => value.toUpperCase()); }
export function runtimeMethod(stream: Stream): number { return stream.read([]); }
export function plainObjectSpread(stream: Stream): object { return { stream }; }
export function harmlessText(): string { return "Atomics.load(privateState); new Proxy(privateState, {})"; }
export function aliasedBuiltin(stream: Stream): object {
  const inspect = Object.getPrototypeOf;
  return inspect(stream);
}
export function aliasedConstructor(buffer: PrivateAlias): Int32Array {
  const View = Int32Array;
  return new View(buffer);
}
export function privateFunctionReceiver(stream: Stream): unknown { return stream.read.bind(null); }
class RuntimeCaller { call(_stream: Stream): void {} }
export function ordinaryNamedCall(stream: Stream): void { new RuntimeCaller().call(stream); }

export function renamedCaptureGetter(buffer: PrivateAlias): ArrayBufferLike { return new SafeView(buffer).buffer; }
export function renamedCaptured(buffer: PrivateAlias): ArrayBufferLike { return typedArrayBuffer(new SafeView(buffer)); }

export function livePrototypeCall(view: Int32Array): void { Int32Array.prototype.set.call(view, [1]); }

const nativeDefine = Object.defineProperty;
export function inheritedDescriptor(stream: Stream): void { nativeDefine({}, "entry", { value: stream }); }
export function inheritedOptions(): SharedArrayBuffer { return new SharedArrayBuffer(4, { maxByteLength: 8 }); }
export function inheritedPropertyMap(): object { return Object.create(null, { __proto__: null, entry: { value: 1 } }); }
export function inheritedProxyHandler(stream: Stream): Stream { return new Proxy(stream, { get() { return undefined; } }); }
export function liveIdentity(): string { return crypto.randomUUID(); }
export function liveMessage(host: import("../../browser/worker.js").RuntimeWorkerHost, message: import("../../browser/worker.js").RuntimeWorkerMessage): void { host.postMessage(message); }
export function capturedDescriptor(stream: Stream): void {
  const descriptor = { __proto__: null, value: stream, writable: true };
  objectDefineProperty({}, "entry", descriptor);
}
