export const retentionSampleMs = [500, 3_000, 8_000, 14_000];
export const pressurePolicy = { arrays: 4, bytesPerArray: 256 * 1024, intervalMs: 250 };
export const canvasSize = 64;
export type QualificationRequest =
  | { kind: "attach"; canvas: OffscreenCanvas; control: SharedArrayBuffer }
  | { kind: "capabilities" }
  | { kind: "bitmap"; suppressTransfer: boolean }
  | { kind: "stable-frame"; suppressTransfer: boolean }
  | { kind: "pressure" }
  | { kind: "dispose" };

export function pressureBurst(): number {
  let checksum = 0;
  for (let index = 0; index < pressurePolicy.arrays; index++) {
    const bytes = new Uint8Array(pressurePolicy.bytesPerArray);
    bytes.fill(index + 1);
    checksum += bytes[bytes.length - 1]!;
  }
  return checksum;
}

export function qualificationRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected qualification record");
  return value as Record<string, unknown>;
}

export function qualificationRequest(value: unknown): QualificationRequest {
  const entry = qualificationRecord(value);
  if (entry.kind === "attach") {
    if (!(entry.canvas instanceof OffscreenCanvas) || !(entry.control instanceof SharedArrayBuffer))
      throw new Error("Expected transferred canvas and shared realm control");
    return { kind: entry.kind, canvas: entry.canvas, control: entry.control };
  }
  if (entry.kind === "bitmap" || entry.kind === "stable-frame") {
    if (typeof entry.suppressTransfer !== "boolean") throw new Error("Expected transfer control");
    return { kind: entry.kind, suppressTransfer: entry.suppressTransfer };
  }
  if (entry.kind === "capabilities" || entry.kind === "pressure" || entry.kind === "dispose")
    return { kind: entry.kind };
  throw new Error("Unknown qualification command");
}
