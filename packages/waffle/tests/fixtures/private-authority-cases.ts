// Parsed but never executed: deliberately unsafe examples for the static guard.
import type { Descriptor, Stream } from "../../core/descriptors.js";
import {
  objectDefineProperty,
  objectEntries,
  Int32ArrayConstructor,
  Int32ArrayConstructor as SafeView,
  atomicsLoad,
  typedArrayBuffer,
  typedArraySubarray,
  mapGet,
  MapConstructor,
} from "../../proc/intrinsics.ts";

type PrivateAlias = SharedArrayBuffer;
type NestedAlias = Map<number, Descriptor>;

/** @compileFixture Parsed by the authority guard, never called. */
export function liveAtomics(buffer: PrivateAlias): number {
  const inferred = new Int32ArrayConstructor(buffer);
  return Atomics.load(inferred, 0);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function liveConstructor(buffer: PrivateAlias): Int32Array {
  return new Int32Array(buffer);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function liveGetter(buffer: PrivateAlias): ArrayBufferLike {
  const inferred = new Int32ArrayConstructor(buffer);
  return inferred.buffer;
}
/** @compileFixture Parsed by the authority guard, never called. */
export function liveSubview(view: Int32Array): Int32Array {
  return view.subarray(1);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function privateMap(entries: NestedAlias): Descriptor | undefined {
  return entries.get(1);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function inferredMap(stream: Stream): boolean {
  const entries = new MapConstructor<number, Stream>();
  entries.set(1, stream);
  return entries.has(1);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function liveIteration(entries: Map<number, Descriptor>): void {
  for (const entry of entries) void entry;
}
/** @compileFixture Parsed by the authority guard, never called. */
export function liveSpread(entries: readonly Descriptor[]): Descriptor[] {
  return [...entries];
}
/** @compileFixture Parsed by the authority guard, never called. */
export function liveArrayMethod(entries: Descriptor[]): Descriptor[] {
  return entries.filter(() => true);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function liveArrayFrom(entries: Descriptor[]): Descriptor[] {
  return Array.from(entries);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function liveReflection(stream: Stream): object {
  return Object.getPrototypeOf(stream);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function liveApply(stream: Stream): unknown {
  return Reflect.apply(stream.read, stream, [[]]);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function liveCall(stream: Stream): number {
  return stream.read.call(stream, []);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function liveBind(stream: Stream): unknown {
  return stream.read.bind(stream);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function liveProxy(stream: Stream): Stream {
  return new Proxy(stream, {});
}
/** @compileFixture Parsed by the authority guard, never called. */
export function species(view: Int32Array): unknown {
  return view.constructor;
}
/** @compileFixture Parsed by the authority guard, never called. */
export function iterator(entries: Descriptor[]): unknown {
  return entries[Symbol.iterator];
}
/** @compileFixture Parsed by the authority guard, never called. */
export function captured(buffer: PrivateAlias): ArrayBufferLike {
  const entries = new MapConstructor<number, Stream>();
  void mapGet(entries, 1);
  const view = new Int32ArrayConstructor(buffer);
  atomicsLoad(view, 0);
  return typedArrayBuffer(typedArraySubarray(view, 1));
}
/** @compileFixture Parsed by the authority guard, never called. */
export function indexed(entries: readonly Descriptor[]): void {
  for (let i = 0; i < entries.length; i++) void entries[i];
}
/** @compileFixture Parsed by the authority guard, never called. */
export function ordinaryPayload(values: string[]): string[] {
  return values.map((value) => value.toUpperCase());
}
/** @compileFixture Parsed by the authority guard, never called. */
export function runtimeMethod(stream: Stream): number {
  return stream.read([]);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function plainObjectSpread(stream: Stream): object {
  return { stream };
}
/** @compileFixture Parsed by the authority guard, never called. */
export function harmlessText(): string {
  return "Atomics.load(privateState); new Proxy(privateState, {})";
}
/** @compileFixture Parsed by the authority guard, never called. */
export function aliasedBuiltin(stream: Stream): object {
  const inspect = Object.getPrototypeOf;
  return inspect(stream);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function aliasedConstructor(buffer: PrivateAlias): Int32Array {
  const View = Int32Array;
  return new View(buffer);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function privateFunctionReceiver(stream: Stream): unknown {
  return stream.read.bind(null);
}
class RuntimeCaller {
  call(_stream: Stream): void {}
}
/** @compileFixture Parsed by the authority guard, never called. */
export function ordinaryNamedCall(stream: Stream): void {
  new RuntimeCaller().call(stream);
}

/** @compileFixture Parsed by the authority guard, never called. */
export function renamedCaptureGetter(buffer: PrivateAlias): ArrayBufferLike {
  return new SafeView(buffer).buffer;
}
/** @compileFixture Parsed by the authority guard, never called. */
export function renamedCaptured(buffer: PrivateAlias): ArrayBufferLike {
  return typedArrayBuffer(new SafeView(buffer));
}

/** @compileFixture Parsed by the authority guard, never called. */
export function livePrototypeCall(view: Int32Array): void {
  Int32Array.prototype.set.call(view, [1]);
}

const nativeDefine = Object.defineProperty;
/** @compileFixture Parsed by the authority guard, never called. */
export function inheritedDescriptor(stream: Stream): void {
  nativeDefine({}, "entry", { value: stream });
}
/** @compileFixture Parsed by the authority guard, never called. */
export function inheritedOptions(): SharedArrayBuffer {
  return new SharedArrayBuffer(4, { maxByteLength: 8 });
}
/** @compileFixture Parsed by the authority guard, never called. */
export function inheritedPropertyMap(): object {
  return Object.create(null, {
    __proto__: null,
    entry: { value: 1 },
  } as unknown as PropertyDescriptorMap);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function inheritedProxyHandler(stream: Stream): Stream {
  return new Proxy(stream, {
    get() {
      return undefined;
    },
  });
}
/** @compileFixture Parsed by the authority guard, never called. */
export function liveIdentity(): string {
  return crypto.randomUUID();
}
/** @compileFixture Parsed by the authority guard, never called. */
export function liveMessage(
  host: import("../../browser/worker.js").RuntimeWorkerHost,
  message: import("../../browser/worker.js").RuntimeWorkerMessage,
): void {
  host.postMessage(message);
}
/** @compileFixture Parsed by the authority guard, never called. */
export function capturedDescriptor(stream: Stream): void {
  const descriptor = { __proto__: null, value: stream, writable: true };
  objectDefineProperty({}, "entry", descriptor);
}

/** @compileFixture Parsed by the authority guard, never called. */
export function privateArrayBinding(entries: readonly Descriptor[]): void {
  const [entry] = entries;
  void entry;
}
/** @compileFixture Parsed by the authority guard, never called. */
export function privateParameterBinding([entry]: readonly Descriptor[]): void {
  void entry;
}
/** @compileFixture Parsed by the authority guard, never called. */
export function privateCallbackBinding(callback: () => void): void {
  const entries = objectEntries({ callback });
  const [name, value] = entries[0]!;
  void name;
  void value;
}
/** @compileFixture Parsed by the authority guard, never called. */
export function privateImportBinding(imports: WebAssembly.Imports): void {
  const entries = objectEntries(imports);
  const [name, namespace] = entries[0]!;
  void name;
  void namespace;
}
/** @compileFixture Parsed by the authority guard, never called. */
export function ordinaryArrayBinding(entries: readonly string[]): void {
  const [entry] = entries;
  void entry;
}
