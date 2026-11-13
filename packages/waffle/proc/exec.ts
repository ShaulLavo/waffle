import { ExecutionUnwind } from "../core/unwind.js";
import {
  Int32ArrayConstructor,
  Uint8ArrayConstructor,
  atomicsLoad,
  atomicsStore,
  decodeUtf8,
  encodeUtf8Prefix,
  typedArraySet,
  typedArrayLength,
} from "./intrinsics.ts";
import { describeStartError, START_DIAGNOSTIC_BYTES } from "./start-diagnostic.ts";

export const EXEC_COMPLETION_BYTES = 12 + START_DIAGNOSTIC_BYTES;

export class ProcessReplaced extends ExecutionUnwind {}

export function publishExecCompletion(
  buffer: SharedArrayBuffer,
  result: number,
  error?: unknown,
): void {
  const words = new Int32ArrayConstructor(buffer, 0, 3);
  if (atomicsLoad(words, 0) !== 0) return;
  const bytes = new Uint8ArrayConstructor(buffer, 12, START_DIAGNOSTIC_BYTES);
  const diagnostic = encodeUtf8Prefix(
    error === undefined ? "" : describeStartError(error),
    START_DIAGNOSTIC_BYTES,
  );
  typedArraySet(bytes, diagnostic);
  const length = typedArrayLength(diagnostic);
  atomicsStore(words, 2, length);
  atomicsStore(words, 1, result);
  atomicsStore(words, 0, 1);
}

export function readExecCompletion(
  buffer: SharedArrayBuffer,
): { readonly result: number; readonly diagnostic: string } | null {
  const words = new Int32ArrayConstructor(buffer, 0, 3);
  if (atomicsLoad(words, 0) === 0) return null;
  const length = atomicsLoad(words, 2);
  const copy = new Uint8ArrayConstructor(length);
  typedArraySet(copy, new Uint8ArrayConstructor(buffer, 12, length));
  return { result: atomicsLoad(words, 1), diagnostic: decodeUtf8(copy) };
}
