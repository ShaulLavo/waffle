import type { GraphicsOpen } from "../display/protocol.js";
import {
  sharedArrayBufferByteLength,
  SharedArrayBufferConstructor,
  reflectApply,
} from "../../proc/intrinsics.js";
import { descriptor } from "../../proc/intrinsics/core.js";
import { gpuPayloadLayout } from "./generated/tables.js";
const growableGetter = descriptor(SharedArrayBufferConstructor.prototype, "growable")?.get;
function fixedBuffer(value: unknown, bytes: number): value is SharedArrayBuffer {
  if (!(value instanceof SharedArrayBufferConstructor)) return false;
  return (
    sharedArrayBufferByteLength(value) === bytes &&
    (!growableGetter || reflectApply(growableGetter, value, []) !== true)
  );
}
export function validGraphicsOpen(
  data: unknown,
  commandBytes: number,
  completionBytes: number,
): data is GraphicsOpen {
  if (!data || typeof data !== "object" || !("type" in data) || data.type !== "open") return false;
  return (
    "id" in data &&
    Number.isSafeInteger(data.id) &&
    Number(data.id) > 0 &&
    "control" in data &&
    fixedBuffer(data.control, 64) &&
    "commands" in data &&
    fixedBuffer(data.commands, commandBytes + 64) &&
    "replies" in data &&
    fixedBuffer(data.replies, completionBytes + 64) &&
    "arena" in data &&
    fixedBuffer(data.arena, gpuPayloadLayout.byteLength) &&
    data.control !== data.commands &&
    data.control !== data.replies &&
    data.commands !== data.replies &&
    data.arena !== data.control &&
    data.arena !== data.commands &&
    data.arena !== data.replies
  );
}
/** Internal G0.1 protocol. No runtime capability or guest import is activated here. */
export const GPU_LIMITS = Object.freeze({
  logicalBytes: 16 * 1024 * 1024,
  serviceBytes: 64 * 1024 * 1024,
  copyBytes: 64 * 1024,
  pending: 64,
  handles: 4096,
  decodeValues: 65536,
});

export const GPU_TERMINAL = Object.freeze({
  closed: 1,
  protocol: 2,
  resource: 3,
  revoked: 4,
  service: 5,
});
export type ConnectionState =
  | { readonly kind: "ready" }
  | {
      readonly kind: "terminal";
      readonly reason: number;
    };

export class GpuProtocolError extends Error {}
export class GpuResourceError extends Error {}
export class GpuCallError extends Error {}

export interface Handle {
  readonly id: number;
  readonly generation: number;
}

export function checkedSpan(size: number, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0)
    throw new GpuProtocolError("Invalid byte span");
  if (offset > size || length > size - offset)
    throw new GpuProtocolError("Byte span exceeds input");
}

/** Ordinary service heap credit, separate from the shared-control allocation ledger. */
export class ServiceCredit {
  #used = 0;
  constructor(readonly limit: number = GPU_LIMITS.serviceBytes) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid heap credit");
  }
  get used(): number {
    return this.#used;
  }
  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit - this.#used)
      throw new GpuResourceError("GPU service heap credit exhausted");
    this.#used += bytes;
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.#used -= bytes;
    };
  }
}
