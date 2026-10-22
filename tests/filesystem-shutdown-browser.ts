export const shutdownArms = [
  "success",
  "drain-failure",
  "final-save-failure",
  "raw-close-failure",
] as const;
export type ShutdownArm = (typeof shutdownArms)[number];
export const failureReasons = [
  "error",
  "undefined",
  "null",
  "false",
  "zero",
  "negative-zero",
  "bigint-zero",
  "nan",
  "empty",
] as const;
export type FailureReason = (typeof failureReasons)[number];
export type Outcome<T> =
  | { kind: "fulfilled"; value: T }
  | { kind: "rejected"; reason: unknown }
  | { kind: "invalid"; cause: string };
export type Stage<T> = { kind: "pending" } | Outcome<T>;
export type ShutdownSpec = {
  arm: ShutdownArm;
  reason: FailureReason;
  database: string;
  nonce: string;
  marker: string;
};
export type WorkerSnapshot = {
  nonce: string;
  location: string;
  backendCloseCalls: number;
  rawCloseCalls: number;
  nativeCloseCalls: number;
  preparation: Stage<void>;
  backendClose: Stage<void>;
  nativeClose: Stage<void>;
  injectedReason: unknown;
  originalReasonMatched: Stage<boolean>;
};
export type PageSettlement = {
  request: Outcome<unknown>;
  serviceAck: Outcome<void>;
  worker: WorkerSnapshot;
};
export type ReopenResults = {
  open: Outcome<void>;
  readMarker: Outcome<string>;
  close: Outcome<void>;
  rawCleanup: Outcome<void>;
};
export interface ShutdownPage {
  start(spec: ShutdownSpec, deadline: number): Promise<void>;
  lockAvailable(): Promise<boolean>;
  release(): Promise<void>;
  originalRequest(): Promise<Outcome<unknown>>;
  serviceAck(): Promise<Outcome<void>>;
  snapshot(): Promise<WorkerSnapshot>;
  ackState(): Stage<void>;
  reopen(deadline: number): Promise<ReopenResults>;
  cleanupOriginalStorage(): Promise<Outcome<unknown>>;
  cleanupReopenedBackend(): Promise<void>;
  cleanupReopenedStorage(): Promise<void>;
  terminate(): void;
  closeClient(): Promise<Outcome<void>[]>;
  deleteDatabase(): Promise<void>;
}
declare global {
  interface Window {
    filesystemShutdownFixture: ShutdownPage;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
export function isShutdownArm(value: unknown): value is ShutdownArm {
  return shutdownArms.some((arm) => arm === value);
}
export function isFailureReason(value: unknown): value is FailureReason {
  return failureReasons.some((reason) => reason === value);
}
export function failureValue(reason: FailureReason): unknown {
  switch (reason) {
    case "error":
      return new Error("injected original shutdown failure");
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "false":
      return false;
    case "zero":
      return 0;
    case "negative-zero":
      return -0;
    case "bigint-zero":
      return 0n;
    case "nan":
      return NaN;
    case "empty":
      return "";
  }
}
export function observe<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ kind: "fulfilled", value }),
    (reason: unknown) => ({ kind: "rejected", reason }),
  );
}
export function pending<T>(): Stage<T> {
  return { kind: "pending" };
}
export function requireValue<T>(result: Outcome<T>, phase: string): T {
  if (result.kind === "rejected") throw result.reason;
  if (result.kind === "invalid") throw new Error(`${phase}: ${result.cause}`);
  return result.value;
}
export function parseOutcome(value: unknown): Outcome<unknown> {
  if (!isRecord(value)) throw new Error("Missing fixture outcome");
  if (value.kind === "fulfilled") return { kind: "fulfilled", value: value.value };
  if (value.kind === "rejected") return { kind: "rejected", reason: value.reason };
  if (value.kind === "invalid" && typeof value.cause === "string")
    return { kind: "invalid", cause: value.cause };
  throw new Error("Invalid fixture outcome");
}
function voidStage(value: unknown): Stage<void> {
  if (isRecord(value) && value.kind === "pending") return pending();
  const result = parseOutcome(value);
  if (result.kind === "fulfilled" && result.value !== undefined)
    throw new Error("Invalid fixture void outcome");
  if (result.kind === "fulfilled") return { kind: "fulfilled", value: undefined };
  return result;
}
function booleanStage(value: unknown): Stage<boolean> {
  if (isRecord(value) && value.kind === "pending") return pending();
  const result = parseOutcome(value);
  if (result.kind === "fulfilled" && typeof result.value === "boolean")
    return { kind: "fulfilled", value: result.value };
  if (result.kind !== "fulfilled") return result;
  throw new Error("Invalid fixture reason-identity outcome");
}
export function parseSnapshot(value: unknown): WorkerSnapshot {
  if (!isRecord(value)) throw new Error("Missing original worker snapshot");
  if (typeof value.nonce !== "string" || typeof value.location !== "string")
    throw new Error("Invalid original worker identity");
  if (
    !Number.isSafeInteger(value.backendCloseCalls) ||
    !Number.isSafeInteger(value.rawCloseCalls) ||
    !Number.isSafeInteger(value.nativeCloseCalls)
  )
    throw new Error("Invalid original worker counters");
  if (
    typeof value.backendCloseCalls !== "number" ||
    typeof value.rawCloseCalls !== "number" ||
    typeof value.nativeCloseCalls !== "number"
  )
    throw new Error("Missing original worker counters");
  return {
    nonce: value.nonce,
    location: value.location,
    backendCloseCalls: value.backendCloseCalls,
    rawCloseCalls: value.rawCloseCalls,
    nativeCloseCalls: value.nativeCloseCalls,
    preparation: voidStage(value.preparation),
    backendClose: voidStage(value.backendClose),
    nativeClose: voidStage(value.nativeClose),
    injectedReason: value.injectedReason,
    originalReasonMatched: booleanStage(value.originalReasonMatched),
  };
}

/** One absolute arm clock, including cleanup. A timeout is invalid, never success. */
export async function before<T>(
  deadline: number,
  phase: string,
  run: () => Promise<T>,
  maximumMs = Infinity,
): Promise<Outcome<T>> {
  const remaining = Math.min(deadline - Date.now(), maximumMs);
  if (remaining <= 0) return { kind: "invalid", cause: `${phase}: arm deadline exhausted` };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "invalid", cause: `${phase}: deadline expired` }),
      remaining,
    );
  });
  try {
    return await Promise.race([observe(Promise.resolve().then(run)), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** JSON must not erase arbitrary falsy reasons or their sign/type. */
export function evidenceJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === undefined) return { valueType: "undefined" };
    if (typeof item === "bigint") return { valueType: "bigint", value: String(item) };
    if (typeof item === "number" && Object.is(item, -0)) return { valueType: "negative-zero" };
    if (typeof item === "number" && Number.isNaN(item)) return { valueType: "nan" };
    if (item instanceof Error)
      return { valueType: "error", name: item.name, message: item.message, stack: item.stack };
    return item;
  });
}
