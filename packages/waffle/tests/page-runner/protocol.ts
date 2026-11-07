import type { StorageEntry } from "../storage-allocation.js";
export type HostVerdict = { status: "pass"; result: unknown } | { status: "fail"; error: string };
export type HostPeer = {
  readonly signal: AbortSignal;
  script(source: string): Promise<unknown>;
  task(source: string): Promise<void>;
  reload(): Promise<HostPeer>;
  close(): Promise<void>;
};
export type HostCase = {
  openPeer(): Promise<HostPeer>;
  readonly signal: AbortSignal;
  remainingMs(): number;
  script(source: string): Promise<unknown>;
  task(source: string): Promise<void>;
  allocateDatabase(prefix: string): Promise<string>;
  sleep(ms: number): Promise<void>;
};
export type Body =
  | { kind: "hello"; token: string; group: string }
  | { kind: "peer-ready" }
  | { kind: "transition-ready"; transitionId: string }
  | { kind: "list"; cases: unknown }
  | { kind: "allocation"; entry: StorageEntry }
  | { kind: "case-start" | "case-ready" | "case-teardown"; caseId: string }
  | { kind: "task-end"; caseId: string; operation: string; status: "pass" | "fail"; error?: string }
  | { kind: "case-end"; caseId: string; status: "pass" | "fail"; error?: string; result?: unknown }
  | { kind: "error"; message: string }
  | { kind: "doc-complete" | "retire-ready" }
  | { kind: "run-complete"; remaining: StorageEntry[] };
export type Message = { run: string; doc: string; seq: number } & Body;
export type Outcome =
  | { status: "pending" }
  | { status: "running"; startedAt: number }
  | { status: "pass"; provisional: boolean }
  | { status: "fail"; detail: string }
  | { status: "host"; detail: string };
export type Failure = { group: string; category: string; detail: string };
export type Budgets = {
  hello: number;
  heartbeat: number;
  case: number;
  group: number;
  run: number;
  operation?: number;
  teardown?: number;
  caseDocument?: number;
};
export const storageBudgets = { hello: 20_000, heartbeat: 10_000, case: 60_000, group: 90_000 };
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}
function storageEntry(value: unknown): value is StorageEntry {
  return (
    record(value) &&
    (value.kind === "indexeddb" || value.kind === "opfs-directory") &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length < 1024
  );
}
function validBody(value: Record<string, unknown>): boolean {
  switch (value.kind) {
    case "hello":
      return typeof value.token === "string" && typeof value.group === "string";
    case "peer-ready":
      return true;
    case "transition-ready":
      return typeof value.transitionId === "string" && value.transitionId.length > 0;
    case "list":
      return "cases" in value;
    case "allocation":
      return storageEntry(value.entry);
    case "case-start":
    case "case-ready":
    case "case-teardown":
      return typeof value.caseId === "string";
    case "task-end":
      return (
        typeof value.caseId === "string" &&
        typeof value.operation === "string" &&
        (value.status === "pass" || (value.status === "fail" && typeof value.error === "string"))
      );
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
    throw new Error("Invalid page report or unsupported control");
  return value as Message;
}
export function exactInventory(required: readonly string[], actual: readonly string[]): void {
  if (
    required.length !== actual.length ||
    new Set(actual).size !== actual.length ||
    actual.some((id) => !required.includes(id))
  )
    throw new Error("Suite inventory does not cover required cases exactly once");
}
export function validateWorkerLabel(returned: unknown, expected: string): void {
  if (returned !== expected)
    throw new Error(`Wrong Worker label: ${JSON.stringify(returned)}, expected ${expected}`);
}

export const resultByteLimit = 48 * 1024;

export function formatHostError(error: unknown): string {
  let text = String(error).slice(0, 16_384);
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify(text)).byteLength > 8192)
    text = text.slice(0, Math.floor(text.length / 2));
  return text;
}
