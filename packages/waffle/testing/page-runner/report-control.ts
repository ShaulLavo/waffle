import { record } from "./protocol.js";
export type ReportingFailure = "capacity" | "conversion" | "cancelled";
export type HostReply = { kind: "live"; retire: boolean } | { kind: "cancelled" };
export function hostReply(value: unknown): value is HostReply {
  return (
    record(value) &&
    (value.kind === "cancelled" || (value.kind === "live" && typeof value.retire === "boolean"))
  );
}
export function reportingFailure(value: unknown): value is ReportingFailure | null {
  return value === null || value === "capacity" || value === "conversion" || value === "cancelled";
}
