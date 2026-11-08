const descriptor = Object.getOwnPropertyDescriptor;
const prototype = Object.getPrototypeOf;
const apply = Reflect.apply;
const slice = String.prototype.slice;
const indexOf = String.prototype.indexOf;
const stringify = String;
const NativeError = Error;
const errorPrototypes = new Set([
  Error.prototype,
  TypeError.prototype,
  RangeError.prototype,
  ReferenceError.prototype,
  SyntaxError.prototype,
  URIError.prototype,
  EvalError.prototype,
  AggregateError.prototype,
]);
const has = Set.prototype.has;
const errorParent = prototype(NativeError);
const functionParent = prototype(errorParent);
const nativeStackGetter = descriptor(new NativeError(), "stack")?.get;
const nativePrepareStackTrace: unknown = descriptor(NativeError, "prepareStackTrace")?.value;
const nativeIsError: unknown = descriptor(NativeError, "isError")?.value;

type ThrowSite = "import" | "return-observer";
type ThrownObservation = {
  site: ThrowSite;
  valueType: string;
  value?: string | boolean | null;
  name?: string;
  message?: string;
  stack?: string;
};

function property(value: object, key: string): PropertyDescriptor | undefined {
  const own = descriptor(value, key);
  if (own) return own;
  const parent: unknown = prototype(value);
  if (!apply(has, errorPrototypes, [parent])) return undefined;
  return descriptor(parent, key);
}
function text(field: PropertyDescriptor | undefined, limit: number): string | undefined {
  if (!field || !("value" in field) || typeof field.value !== "string") return undefined;
  return apply(slice, field.value, [0, limit]);
}
function safeErrorField(field: PropertyDescriptor | undefined): boolean {
  return (
    !!field && "value" in field && (field.value === undefined || typeof field.value === "string")
  );
}
function stack(value: object): string | undefined {
  // V8's native stack getter formats name/message and can call prepareStackTrace.
  if (!safeErrorField(property(value, "name")) || !safeErrorField(property(value, "message")))
    return undefined;
  if (prototype(NativeError) !== errorParent || prototype(errorParent) !== functionParent)
    return undefined;
  const prepare =
    descriptor(NativeError, "prepareStackTrace") ??
    descriptor(errorParent, "prepareStackTrace") ??
    descriptor(functionParent, "prepareStackTrace");
  if (
    prepare &&
    (!("value" in prepare) ||
      (prepare.value !== undefined && prepare.value !== nativePrepareStackTrace))
  )
    return undefined;
  const field = descriptor(value, "stack");
  if (!field) return undefined;
  if ("value" in field) return typeof field.value === "string" ? field.value : undefined;
  if (!nativeStackGetter || field.get !== nativeStackGetter) return undefined;
  const result: unknown = apply(nativeStackGetter, value, []);
  return typeof result === "string" ? result : undefined;
}
function boundedStack(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let result = "",
    start = 0;
  for (let line = 0; line < 5 && start < value.length; line++) {
    const newline: number = apply(indexOf, value, ["\n", start]);
    const end = newline < 0 ? value.length : newline;
    const part: string = apply(slice, value, [start, end < start + 256 ? end : start + 256]);
    result += (line === 0 ? "" : "\n") + part;
    start = end + 1;
  }
  return result;
}
export function thrownObservation(value: unknown, site: ThrowSite): ThrownObservation {
  const result: ThrownObservation = { site, valueType: value === null ? "null" : typeof value };
  if (value === null || typeof value === "boolean") return { ...result, value };
  if (typeof value === "string") return { ...result, value: apply(slice, value, [0, 512]) };
  if (typeof value === "number")
    return { ...result, value: value === 0 && 1 / value < 0 ? "-0" : stringify(value) };
  if (typeof value !== "object" || typeof nativeIsError !== "function" || !nativeIsError(value))
    return result;
  try {
    result.name = text(property(value, "name"), 80);
    result.message = text(property(value, "message"), 512);
    result.stack = boundedStack(stack(value));
  } catch {}
  return result;
}
