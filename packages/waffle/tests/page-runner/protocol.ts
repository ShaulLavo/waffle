import type { StorageEntry } from "../storage-allocation.js";
export type Body =
  | { kind: "hello"; token: string; group: string }
  | { kind: "list"; cases: Record<"indexeddb" | "opfs", string[]> }
  | { kind: "allocation"; entry: StorageEntry }
  | { kind: "case-start"; caseId: string }
  | { kind: "case-end"; caseId: string; status: "pass" | "fail"; error?: string }
  | { kind: "error"; message: string }
  | { kind: "doc-complete" | "retire-ready" }
  | { kind: "run-complete"; remaining: StorageEntry[] };
export type Message = { run: string; doc: string; seq: number } & Body;
export type Outcome =
  | { status: "pending" }
  | { status: "running"; startedAt: number }
  | { status: "pass"; provisional: boolean }
  | { status: "fail"; detail: string };
export type Failure = { group: string; category: string; detail: string };
export type Budgets = {
  hello: number;
  heartbeat: number;
  case: number;
  group: number;
  run: number;
};
export const storageBudgets = { hello: 20_000, heartbeat: 10_000, case: 60_000, group: 90_000 };
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}
export function storageEntry(value: unknown): value is StorageEntry {
  return (
    record(value) &&
    (value.kind === "indexeddb" || value.kind === "opfs-directory") &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length < 1024
  );
}
export function listIds(value: unknown): string[] {
  if (!record(value) || !strings(value.indexeddb) || !strings(value.opfs))
    throw new Error("Invalid storage list backend arrays");
  const ids = value.indexeddb
    .map((label) => `indexeddb: ${label}`)
    .concat(value.opfs.map((label) => `opfs: ${label}`));
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate storage list IDs");
  return ids;
}
function validBody(value: Record<string, unknown>): boolean {
  switch (value.kind) {
    case "hello":
      return typeof value.token === "string" && typeof value.group === "string";
    case "list":
      listIds(value.cases);
      return true;
    case "allocation":
      return storageEntry(value.entry);
    case "case-start":
      return typeof value.caseId === "string";
    case "case-end":
      return (
        typeof value.caseId === "string" &&
        (value.status === "pass" || (value.status === "fail" && typeof value.error === "string"))
      );
    case "error":
      return typeof value.message === "string";
    case "doc-complete":
    case "retire-ready":
      return true;
    case "run-complete":
      return Array.isArray(value.remaining) && value.remaining.every(storageEntry);
    default:
      return false;
  }
}
export function parseMessage(value: unknown): Message {
  if (
    !record(value) ||
    typeof value.run !== "string" ||
    typeof value.doc !== "string" ||
    !value.doc ||
    !Number.isSafeInteger(value.seq) ||
    typeof value.seq !== "number" ||
    value.seq < 0 ||
    !validBody(value)
  )
    throw new Error("Invalid page report, controls and transitions are unsupported");
  return value as Message;
}
export function exactInventory(required: readonly string[], actual: readonly string[]): void {
  if (
    required.length !== actual.length ||
    new Set(actual).size !== actual.length ||
    actual.some((id) => !required.includes(id))
  )
    throw new Error("Storage inventory does not cover required cases exactly once");
}
export function validateWorkerLabel(returned: unknown, expected: string): void {
  if (returned !== expected)
    throw new Error(`Wrong Worker label: ${JSON.stringify(returned)}, expected ${expected}`);
}
