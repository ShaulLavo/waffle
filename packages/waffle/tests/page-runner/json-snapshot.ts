import { resultByteLimit } from "./protocol.js";
export function jsonSnapshot(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Missing serializable result");
  if (new TextEncoder().encode(encoded).byteLength > resultByteLimit)
    throw new Error("Result exceeds 48 KiB UTF-8 limit");
  return encoded;
}
