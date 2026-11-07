import type { GraphicsOpen } from "./protocol.js";
import {
  sharedArrayBufferByteLength,
  SharedArrayBufferConstructor,
  reflectApply,
} from "../../proc/intrinsics.js";
import { descriptor } from "../../proc/intrinsics/core.js";
import { gpuPayloadLayout } from "./generated/graphics-layout.js";
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
