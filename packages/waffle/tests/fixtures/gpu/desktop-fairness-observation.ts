import type { FairnessSnapshot, FairnessSlice } from "./fairness-observer.js";
import { qualificationRecord } from "./qualification-contract.js";

function numbers(value: Record<string, unknown>, keys: readonly string[]) {
  return keys.every(
    (key) =>
      typeof value[key] === "number" && Number.isFinite(value[key]) && Number(value[key]) >= 0,
  );
}
function slice(value: unknown): value is FairnessSlice {
  const item = qualificationRecord(value);
  return (
    numbers(item, [
      "connection",
      "start",
      "end",
      "records",
      "draws",
      "nativeMs",
      "longestNativeMs",
      "firstRecord",
      "lastRecord",
      "bytes",
    ]) && typeof item.kind === "string"
  );
}
function blob(value: unknown): value is FairnessSnapshot["blobs"][number] {
  const item = qualificationRecord(value);
  return (
    numbers(item, ["connection", "commandRingBytes", "bytes", "draws", "start"]) &&
    (item.end === null || typeof item.end === "number")
  );
}
function present(value: unknown): value is FairnessSnapshot["presents"][number] {
  const item = qualificationRecord(value);
  return (
    numbers(item, ["connection", "at"]) &&
    Array.isArray(item.otherLargeDraws) &&
    item.otherLargeDraws.every((draws: unknown) => typeof draws === "number")
  );
}
function queue(value: unknown): value is FairnessSnapshot["queue"][number] {
  const item = qualificationRecord(value),
    settlement = qualificationRecord(item.settlement);
  return (
    numbers(item, ["connection", "start"]) &&
    (settlement.kind === "pending" ||
      ((settlement.kind === "completed" || settlement.kind === "rejected") &&
        typeof settlement.at === "number"))
  );
}
function aggregates(value: unknown): value is FairnessSnapshot["records"] {
  return Object.values(qualificationRecord(value)).every((item) =>
    numbers(qualificationRecord(item), ["count", "totalMs", "maxMs"]),
  );
}
function snapshot(value: unknown): value is FairnessSnapshot {
  const item = qualificationRecord(value);
  return (
    numbers(item, ["at", "epoch"]) &&
    typeof item.armed === "boolean" &&
    typeof item.overflow === "boolean" &&
    Array.isArray(item.slices) &&
    item.slices.every(slice) &&
    Array.isArray(item.blobs) &&
    item.blobs.every(blob) &&
    Array.isArray(item.presents) &&
    item.presents.every(present) &&
    Array.isArray(item.queue) &&
    item.queue.every(queue) &&
    aggregates(item.records) &&
    aggregates(item.native)
  );
}
export function desktopObservation(value: unknown): FairnessSnapshot {
  const result = qualificationRecord(value);
  if (!snapshot(result.fairness)) throw new Error("Malformed current desktop fairness snapshot");
  return result.fairness;
}
