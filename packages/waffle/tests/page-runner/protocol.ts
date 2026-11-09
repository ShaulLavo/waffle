import type { ServiceWorkerEntry, StorageEntry } from "../storage-allocation.js";
export type HostVerdict = { status: "pass"; result: unknown } | { status: "fail"; error: string };
export type HostPeer = {
  readonly signal: AbortSignal;
  script(source: string): Promise<unknown>;
  task(source: string): Promise<void>;
  reload(): Promise<HostPeer>;
  close(): Promise<void>;
};
export type HeldAssetRequest = {
  continue(): Promise<void>;
};
export type AssetHoldCallback = (request: HeldAssetRequest) => Promise<void>;
export type HostCase = {
  holdAsset(path: string, callback: AssetHoldCallback): void;
  openPeer(): Promise<HostPeer>;
  readonly signal: AbortSignal;
  remainingMs(): number;
  setTimeout(timeoutMs: number): void;
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
  | { kind: "worker-settled"; entry: ServiceWorkerEntry; outcome: "registered" | "rejected" }
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
export type Failure = {
  group: string;
  category: string;
  detail: string;
  document?: { doc: string | null; peer: string; generation: number; handle: string };
};
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
function absoluteURL(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.hash &&
      !url.username &&
      !url.password &&
      url.href === value
    );
  } catch {
    return false;
  }
}
function storageEntry(value: unknown): value is StorageEntry {
  if (!record(value) || typeof value.name !== "string" || !value.name || value.name.length >= 4096)
    return false;
  switch (value.kind) {
    case "indexeddb":
    case "opfs-directory":
      return value.name.length < 1024;
    case "service-worker":
      return (
        absoluteURL(value.name) && absoluteURL(value.clientURL) && absoluteURL(value.scriptURL)
      );
    default:
      return false;
  }
}
export function sameStorageEntry(a: StorageEntry, b: StorageEntry): boolean {
  if (a.kind !== b.kind || a.name !== b.name) return false;
  switch (a.kind) {
    case "indexeddb":
    case "opfs-directory":
      return true;
    case "service-worker":
      return (
        b.kind === "service-worker" && a.clientURL === b.clientURL && a.scriptURL === b.scriptURL
      );
    default: {
      const exhaustive: never = a;
      return exhaustive;
    }
  }
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
    case "worker-settled":
      return (
        storageEntry(value.entry) &&
        value.entry.kind === "service-worker" &&
        (value.outcome === "registered" || value.outcome === "rejected")
      );
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
  let text = errorDetail(error, { seen: new Set(), remaining: 16 }, 0).slice(0, 16_384);
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify(text)).byteLength > 8192)
    text = text.slice(0, Math.floor(text.length / 2));
  return text;
}

type ErrorTraversal = { seen: Set<object>; remaining: number };

function errorField(error: object, key: string): unknown {
  try {
    let current: object | null = error;
    for (let depth = 0; current && depth < 8; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
      current = Object.getPrototypeOf(current);
    }
  } catch {}
  return undefined;
}

function errorText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function errorDetail(error: unknown, traversal: ErrorTraversal, depth: number): string {
  if (typeof error === "string") return error.slice(0, 1600);
  if (error === null || (typeof error !== "object" && typeof error !== "function"))
    return typeof error === "bigint" ? "[bigint thrown]" : String(error);
  if (traversal.seen.has(error)) return "[circular]";
  if (traversal.remaining-- <= 0) return "[error limit]";
  traversal.seen.add(error);
  const name = errorText(errorField(error, "name"), 128) || "Error";
  const message = errorText(errorField(error, "message"), 512);
  const errno = errorField(error, "errno");
  let text = `${name}${message ? `: ${message}` : ""}`;
  if (typeof errno === "number" && Number.isFinite(errno)) text += ` (errno=${errno})`;
  text += filesystemAllocationDetail(errorField(error, "filesystemAllocation"));
  if (depth < 3) text += errorCauses(error, traversal, depth);
  const stack = errorText(errorField(error, "stack"), 1024);
  return stack ? `${text}\nStack:\n${stack}` : text;
}

function errorCauses(error: object, traversal: ErrorTraversal, depth: number): string {
  let text = "";
  const cause = errorField(error, "cause");
  if (cause !== undefined) text += `\nCause:\n${errorDetail(cause, traversal, depth + 1)}`;
  const errors = errorField(error, "errors");
  if (!errorArray(errors)) return text;
  const length = errorField(errors, "length");
  if (typeof length !== "number") return text;
  const causes: string[] = [];
  for (let index = 0; index < Math.min(length, 8); index++)
    causes.push(errorDetail(errorField(errors, String(index)), traversal, depth + 1));
  return `${text}\nCauses, primary first:\n${causes.join("\n")}`;
}

function errorArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function filesystemAllocationDetail(value: unknown): string {
  if (!record(value)) return "";
  const fields = [
    "identityOrdinal",
    "rootOrdinal",
    "kind",
    "stage",
    "rootComplete",
    "segmentSlot",
    "segmentsCompleted",
    "segmentsPlanned",
  ] satisfies (keyof import("../../fs/identity-allocation.js").FilesystemIdentityAllocation)[];
  const snapshot: Record<string, string | number | boolean | null> = {};
  for (const key of fields) {
    const field = errorField(value, key);
    if (!allocationScalar(field)) return "";
    snapshot[key] = field;
  }
  return `\nFilesystem allocation: ${JSON.stringify(snapshot)}`;
}
function allocationScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && value.length <= 32)
  );
}
