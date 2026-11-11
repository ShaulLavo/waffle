import {
  reflectGet,
  isInstance,
  arrayAppend,
  StringConstructor,
  stringSlice,
  encodeUtf8Prefix,
  decodeUtf8,
} from "./intrinsics.ts";
import type { StartFailure } from "./start-errno.ts";

export const START_DIAGNOSTIC_BYTES = 4096;
export const START_DIAGNOSTIC_WORDS = 1 + START_DIAGNOSTIC_BYTES / 4;

function prefix(value: string, length: number): string {
  return stringSlice(value, 0, length) + (value.length > length ? " [truncated]" : "");
}
export function errorInstance<T>(
  value: unknown,
  constructor: Parameters<typeof isInstance<T>>[1],
): value is T {
  try {
    return isInstance(value, constructor);
  } catch {
    return false;
  }
}
export function startErrorMessage(error: unknown): string {
  const message = property(error, "message");
  return typeof message === "string" ? message : (scalar(error, 256) ?? "[object thrown]");
}
function property(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function")
    return undefined;
  try {
    return reflectGet(value, key);
  } catch {
    return undefined;
  }
}
function scalar(value: unknown, limit: number): string | undefined {
  if (typeof value === "string") return prefix(value, limit);
  if (value === null || (typeof value !== "object" && typeof value !== "function"))
    return prefix(StringConstructor(value), limit);
  return undefined;
}
function errorLine(error: unknown): string {
  const name = property(error, "name"),
    message = property(error, "message"),
    code = property(error, "code"),
    errno = property(error, "errno");
  const label = typeof name === "string" ? prefix(name, 80) : "Thrown value";
  const text = typeof message === "string" ? prefix(message, 256) : scalar(error, 256);
  let line = `${label}: ${text ?? "[object]"}`;
  if (code !== undefined) line += ` [code=${scalar(code, 80) ?? "[object]"}]`;
  if (errno !== undefined) line += ` [errno=${scalar(errno, 32) ?? "[object]"}]`;
  return line;
}

/** Only copied text crosses the worker boundary, never the original thrown object. */
export class WorkerStartError extends Error {
  constructor(
    message: string,
    readonly code: StartFailure | undefined,
    readonly diagnostic: string,
  ) {
    super(message);
  }
}

/** Bounded, non-coercing inspection also handles cycles and throwing accessors. */
export function describeStartError(error: unknown): string {
  const forwarded = errorInstance(error, WorkerStartError)
    ? property(error, "diagnostic")
    : undefined;
  if (typeof forwarded === "string") return forwarded;
  let text = "",
    current = error;
  const seen: unknown[] = [];
  for (let depth = 0; depth < 8; depth++) {
    let repeated = false;
    for (let i = 0; i < seen.length; i++) repeated ||= seen[i] === current;
    if (repeated) return `${text}\nCaused by: [circular cause]`;
    arrayAppend(seen, current);
    text += `${depth ? "\nCaused by: " : ""}${errorLine(current)}`;
    const cause = property(current, "cause");
    if (cause === undefined) break;
    current = cause;
    if (depth === 7) text += "\n[cause depth limit]";
  }
  const stack = property(error, "stack");
  if (typeof stack === "string") text += `\n${prefix(stack, 512)}`;
  return text;
}

export function diagnosticBytes(text: string): Uint8Array {
  return encodeUtf8Prefix(text, START_DIAGNOSTIC_BYTES);
}
export function diagnosticText(bytes: Uint8Array): string {
  return decodeUtf8(bytes);
}
