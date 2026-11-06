const reservedBytesBrand: unique symbol = Symbol("waffle.reserved-bytes");
const wasmPagesBrand: unique symbol = Symbol("waffle.wasm-pages");
export type ReservedBytes = number & { readonly [reservedBytesBrand]: true };
export type WasmPages = number & { readonly [wasmPagesBrand]: true };
function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}
export function bytes(value: number): ReservedBytes {
  return integer(value, "bytes") as ReservedBytes;
}
export function pages(value: number): WasmPages {
  if (value > 65_536) throw new RangeError("pages exceed wasm32 memory");
  return integer(value, "pages") as WasmPages;
}
export interface CountedKinds {
  readonly fixedBuffer: boolean;
  readonly sharedMemory: boolean;
  readonly privateMemory: boolean;
}
/** Snapshot provenance. Only an omitted `sharedMemory` option selects the default. */
export type SharedMemoryPlatform =
  | { readonly kind: "unbounded"; readonly source: "default" }
  | { readonly kind: "unbounded"; readonly source: "application" }
  | {
      readonly kind: "bounded";
      readonly source: "application";
      readonly budgetBytes: ReservedBytes;
      readonly counts: CountedKinds;
    };
/** An issued application declaration, the only accepted explicit Runtime input. */
export type SharedMemoryDeclaration = Extract<
  SharedMemoryPlatform,
  { readonly source: "application" }
>;
const issued = new WeakSet<object>();
/** Internal issuance for the default and the public factory. Never reads the host environment. */
export function issuePlatform<P extends SharedMemoryPlatform>(platform: P): P {
  const frozen = Object.freeze(
    platform.kind === "bounded"
      ? { ...platform, counts: Object.freeze({ ...platform.counts }) }
      : platform,
  );
  issued.add(frozen);
  return frozen as P;
}
/** Package-private omission default. It is unbounded on every user agent. */
export const defaultSharedMemoryPlatform = issuePlatform({
  kind: "unbounded",
  source: "default",
});
export function validatePlatform(platform: unknown): asserts platform is SharedMemoryPlatform {
  if (typeof platform !== "object" || platform === null || !issued.has(platform))
    throw new TypeError("Shared memory requires an issued shared-memory declaration");
}
/** Explicit input must be issued by the factory; a default recovered from a snapshot is not. */
export function validateDeclaration(value: unknown): SharedMemoryDeclaration {
  validatePlatform(value);
  if (value.source !== "application")
    throw new TypeError("Explicit shared memory requires an application declaration");
  return value;
}
type PlatformInput =
  | { readonly kind: "unbounded" }
  | {
      readonly kind: "bounded";
      readonly budgetBytes: ReservedBytes;
      readonly counts: CountedKinds;
    };
export function declareSharedMemoryPlatform(input: PlatformInput): SharedMemoryDeclaration {
  if (!input || typeof input !== "object") throw new TypeError("Invalid shared-memory declaration");
  if (input.kind === "unbounded")
    return issuePlatform({ kind: "unbounded", source: "application" });
  if (input.kind !== "bounded") throw new TypeError("Invalid shared-memory declaration kind");
  const { budgetBytes, counts } = input;
  if (typeof budgetBytes !== "number" || !Number.isSafeInteger(budgetBytes) || budgetBytes <= 0)
    throw new TypeError("Shared-memory budget must be a positive safe integer");
  if (!counts || typeof counts !== "object")
    throw new TypeError("Missing shared-memory counted kinds");
  const { fixedBuffer, sharedMemory, privateMemory } = counts;
  if (
    typeof fixedBuffer !== "boolean" ||
    typeof sharedMemory !== "boolean" ||
    typeof privateMemory !== "boolean"
  )
    throw new TypeError("Shared-memory counted kinds must be booleans");
  return issuePlatform({
    kind: "bounded",
    source: "application",
    budgetBytes,
    counts: { fixedBuffer, sharedMemory, privateMemory },
  });
}
