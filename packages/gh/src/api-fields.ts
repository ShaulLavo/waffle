import { GhError } from "./errors.ts";
import { readRequired } from "./filesystem.ts";
import { decode } from "./json.ts";
import type { PlaceholderResolver } from "./repository.ts";
import type { Invocation, JsonObject, JsonValue, QueryEntry } from "./types.ts";

const ARRAY = Symbol("array");
const EMPTY_ARRAY = Symbol("empty-array");
type Segment = string | typeof ARRAY;

export interface PreparedFields {
  readonly values: JsonObject;
  readonly count: number;
}

export async function prepareFields(
  invocation: Invocation,
  raw: readonly string[],
  typed: readonly string[],
  placeholders: PlaceholderResolver,
): Promise<PreparedFields> {
  const values: JsonObject = {};
  for (const assignment of raw) await assign(invocation, values, assignment, false, placeholders);
  for (const assignment of typed) await assign(invocation, values, assignment, true, placeholders);
  return { values, count: raw.length + typed.length };
}

export function flattenFields(values: JsonObject): QueryEntry[] {
  return Object.entries(values).flatMap(([key, value]) => flattenValue(key, value));
}

function flattenValue(key: string, value: JsonValue): QueryEntry[] {
  if (Array.isArray(value)) return value.flatMap((entry) => flattenValue(`${key}[]`, entry));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([child, item]) => flattenValue(`${key}[${child}]`, item));
  return [[key, scalar(value)]];
}

async function assign(
  invocation: Invocation,
  target: JsonObject,
  assignment: string,
  typed: boolean,
  placeholders: PlaceholderResolver,
): Promise<void> {
  const equal = assignment.indexOf("=");
  const key = equal < 0 ? assignment : assignment.slice(0, equal);
  const rawValue = equal < 0 ? undefined : assignment.slice(equal + 1);
  const path = fieldPath(key);
  if (rawValue === undefined) {
    if (!typed || path.at(-1) !== ARRAY) throw new GhError(`field requires key=value: ${key}`);
    setPath(target, path, EMPTY_ARRAY);
    return;
  }
  const expanded = typed ? await placeholders.expand(rawValue) : rawValue;
  const value = typed ? await typedValue(invocation, expanded) : expanded;
  setPath(target, path, value);
}

async function typedValue(invocation: Invocation, value: string): Promise<JsonValue> {
  if (value.startsWith("@")) return decode(await readRequired(invocation, value.slice(1)));
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
  }
  return value;
}

function fieldPath(key: string): Segment[] {
  const root = /^[^[\]]+/.exec(key)?.[0];
  if (!root) throw new GhError(`invalid field key: ${key}`);
  const suffix = key.slice(root.length);
  const segments: Segment[] = [root];
  for (const match of suffix.matchAll(/\[([^[\]]*)\]/g)) segments.push(match[1] || ARRAY);
  const consumed = suffix.replace(/\[([^[\]]*)\]/g, "");
  if (consumed) throw new GhError(`invalid field key: ${key}`);
  return segments;
}

function setPath(
  target: JsonObject,
  path: readonly Segment[],
  value: JsonValue | typeof EMPTY_ARRAY,
): void {
  const [head, ...rest] = path;
  if (typeof head !== "string") throw new GhError("invalid array field");
  if (!rest.length) {
    target[head] = value === EMPTY_ARRAY ? [] : value;
    return;
  }
  if (rest[0] === ARRAY) {
    setArrayPath(target, head, rest.slice(1), value);
    return;
  }
  const child = target[head] ?? {};
  if (!child || typeof child !== "object" || Array.isArray(child))
    throw new GhError(`field mixes object and scalar values: ${head}`);
  target[head] = child;
  setPath(child, rest, value);
}

function setArrayPath(
  target: JsonObject,
  key: string,
  rest: readonly Segment[],
  value: JsonValue | typeof EMPTY_ARRAY,
): void {
  const existing = target[key] ?? [];
  if (!Array.isArray(existing)) throw new GhError(`field mixes array and scalar values: ${key}`);
  target[key] = existing;
  if (!rest.length) {
    if (value !== EMPTY_ARRAY) existing.push(value);
    return;
  }
  const last = existing.at(-1);
  const child = last && typeof last === "object" && !Array.isArray(last) ? last : {};
  if (child !== last) existing.push(child);
  setPath(child, rest, value);
}

function scalar(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "object") throw new GhError("nested query value must contain scalars");
  return String(value);
}
