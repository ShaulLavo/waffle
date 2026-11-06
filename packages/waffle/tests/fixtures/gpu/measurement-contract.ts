import { qualificationRecord } from "./qualification-contract.js";

export type Measurement<T> =
  | { kind: "measured"; value: T }
  | { kind: "unsupported" | "unavailable" | "unmet" | "failed"; reason: string };
export interface MeasurementOptions {
  trials: number;
  warmup: number;
  extraWorkers: number;
  timeoutMs: number;
  runtimeFixture: boolean;
}
export const defaultMeasurementOptions: MeasurementOptions = {
  trials: 5,
  warmup: 1,
  extraWorkers: 2,
  timeoutMs: 15_000,
  runtimeFixture: false,
};
export function measurementOptions(value: unknown): MeasurementOptions {
  const input = qualificationRecord(value);
  const integer = (key: string, low: number, high: number): number => {
    const item = input[key];
    if (typeof item !== "number" || !Number.isInteger(item) || item < low || item > high)
      throw new Error(`Measurement ${key} must be an integer in ${low}..${high}`);
    return item;
  };
  if (typeof input.runtimeFixture !== "boolean") throw new Error("Expected runtimeFixture boolean");
  return {
    trials: integer("trials", 1, 30),
    warmup: integer("warmup", 0, 5),
    extraWorkers: integer("extraWorkers", 1, 4),
    timeoutMs: integer("timeoutMs", 100, 30_000),
    runtimeFixture: input.runtimeFixture,
  };
}
export function distribution(samples: readonly number[]) {
  if (!samples.length || samples.some((sample) => !Number.isFinite(sample) || sample < 0))
    throw new Error("Expected nonempty finite nonnegative measurement samples");
  const sorted = samples.toSorted((first, second) => first - second);
  return {
    samplesMs: samples,
    count: samples.length,
    minMs: sorted[0]!,
    medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    maxMs: sorted[sorted.length - 1]!,
  };
}
export async function measure<T>(operation: () => Promise<T>): Promise<Measurement<T>> {
  try {
    return { kind: "measured", value: await operation() };
  } catch (error) {
    return { kind: "failed", reason: String(error) };
  }
}
export function unavailableMemory() {
  return {
    kind: "unavailable",
    reason:
      "Browser exposes no per-worker/device physical memory counter. No physical-memory estimate is made.",
  } satisfies Measurement<never>;
}
export function assertUpload(actual: Uint32Array, expected: Uint32Array): void {
  if (actual.length !== expected.length || actual.some((word, index) => word !== expected[index]))
    throw new Error("SAB writeBuffer readback differs from the source pattern");
}
export function assertImagePixel(pixel: readonly number[], red: number): void {
  if (
    pixel.length !== 4 ||
    Math.abs(pixel[0]! - red) > 8 ||
    Math.abs(pixel[1]! - (255 - red)) > 8 ||
    pixel[2]! > 8 ||
    pixel[3]! < 247
  )
    throw new Error(`Image transfer pixel differs: ${JSON.stringify(pixel)}`);
}
export function assertWake(value: unknown): number {
  const reply = qualificationRecord(value);
  if (reply.async !== true || reply.result !== "ok" || reply.notified !== 1)
    throw new Error(`waitAsync positive control failed: ${JSON.stringify(reply)}`);
  if (
    typeof reply.elapsedMs !== "number" ||
    !Number.isFinite(reply.elapsedMs) ||
    reply.elapsedMs < 0
  )
    throw new Error("waitAsync clock/control failed");
  return reply.elapsedMs;
}
export type MeasurementRequest =
  | { kind: "probe" }
  | { kind: "notify" }
  | { kind: "device" }
  | { kind: "upload"; options: MeasurementOptions; corrupt: boolean }
  | { kind: "image"; options: MeasurementOptions; width: number; height: number; suppress: boolean }
  | { kind: "wait"; control: SharedArrayBuffer; timeoutMs: number; notifier: "page" | "worker" }
  | { kind: "dispose" };
export function measurementRequest(value: unknown): MeasurementRequest {
  const entry = qualificationRecord(value);
  if (
    entry.kind === "probe" ||
    entry.kind === "device" ||
    entry.kind === "dispose" ||
    entry.kind === "notify"
  )
    return { kind: entry.kind };
  if (entry.kind === "wait") {
    if (!(entry.control instanceof SharedArrayBuffer) || entry.control.byteLength !== 16)
      throw new Error("Expected 16-byte shared wake control");
    if (
      typeof entry.timeoutMs !== "number" ||
      !Number.isFinite(entry.timeoutMs) ||
      entry.timeoutMs < 1 ||
      entry.timeoutMs > 30_000
    )
      throw new Error("Invalid wait timeout");
    if (entry.notifier !== "page" && entry.notifier !== "worker")
      throw new Error("Invalid notifier realm");
    return {
      kind: entry.kind,
      control: entry.control,
      timeoutMs: entry.timeoutMs,
      notifier: entry.notifier,
    };
  }
  const options = measurementOptions(entry.options);
  if (entry.kind === "upload" && typeof entry.corrupt === "boolean")
    return { kind: entry.kind, options, corrupt: entry.corrupt };
  if (entry.kind !== "image" || typeof entry.suppress !== "boolean")
    throw new Error("Unknown measurement command");
  if (
    !(
      (entry.width === 1920 && entry.height === 1080) ||
      (entry.width === 3840 && entry.height === 2160)
    )
  )
    throw new Error("Only bounded 1080p and 4K image measurements are accepted");
  return {
    kind: entry.kind,
    options,
    width: entry.width,
    height: entry.height,
    suppress: entry.suppress,
  };
}
