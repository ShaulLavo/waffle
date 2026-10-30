import { GhError } from "./errors.ts";
import type { JsonObject, JsonValue } from "./types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

export function parseJson(bytes: Uint8Array): JsonValue {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new GhError("gh: invalid JSON response");
  }
  if (!isJsonValue(value)) throw new GhError("gh: invalid JSON response value");
  return value;
}

export function object(value: JsonValue, context = "response"): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GhError(`gh: invalid ${context}: expected an object`);
  return value;
}

export function array(value: JsonValue, context = "response"): JsonValue[] {
  if (!Array.isArray(value)) throw new GhError(`gh: invalid ${context}: expected an array`);
  return value;
}

export function compact(value: JsonValue): string {
  return JSON.stringify(value);
}

export function stableJson(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

export function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const result: JsonObject = {};
  for (const key of Object.keys(value).sort()) result[key] = sortJson(value[key]);
  return result;
}
