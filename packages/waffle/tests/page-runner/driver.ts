import {
  record,
  type HostKey,
  type HostWorker,
  type HostWorkerCallback,
  type HostRequestCallback,
} from "./protocol.js";
export class DeadlineError extends Error {
  constructor(label: string) {
    super(`${label} timed out`);
  }
}
export class WebDriverError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message ? `${code}: ${message}` : code);
    this.name = "WebDriverError";
  }
}
export type CleanupStep = { status: "not-created" | "confirmed" | "unconfirmed"; detail: string };
export type DriverCleanup = {
  session: CleanupStep;
  launcher: CleanupStep;
  serviceDisposition: string;
};
export interface DriverPressControl {
  /** Admission/waiter lifetime, not cancellation of an already-admitted action. */
  readonly signal: AbortSignal;
  /** Await sequentially. The callback starts its send synchronously, without preparation. */
  dispatch<T>(send: () => Promise<T>): Promise<T>;
}
export type DocumentRetirementSource =
  | "safari-listing-removed"
  | "safari-target-destroyed"
  | "safari-navigation-request"
  | "playwright-page-close"
  | "playwright-navigation";
/** Exact retirement of one observed document, independent of Worker receipts. */
export type DocumentRetirement = Readonly<{
  intent: "close" | "navigation";
  source: DocumentRetirementSource;
  at: number;
  /** First 64 outstanding Worker ordinals. outstandingCount includes any omitted ones. */
  outstandingWorkers: readonly number[];
  outstandingCount: number;
}>;
export interface DriverObservation {
  readonly failure: Promise<Error>;
  diagnosticSnapshot?(): unknown;
  workerOrdinal?(worker: HostWorker | string): number | null;
  console?(): import("./console-observation.js").ConsoleSummary;
  settleConsole?(): Promise<void>;
  navigationComplete(): void;
  check(): void;
  workers(): readonly HostWorker[];
  onRequest(callback: HostRequestCallback): () => Promise<void>;
  onWorker(callback: HostWorkerCallback): () => Promise<void>;
  waitForWorkerClose(worker: HostWorker): Promise<void>;
  waitForWorkerURLClose(url: string): Promise<void>;
  beginDocumentClose(nextURL?: string): void;
  /** Exact close retirement; rejects on loss or stop before retirement. Settles no Worker wait. */
  documentRetirement(): Promise<DocumentRetirement>;
  revokeActions(): void;
  revoke(): void;
  stop(): Promise<void>;
}
export type DriverObservationBinding = {
  console?: boolean;
  window: string;
  bootstrapURL: string;
  expectedURL: string;
  signal: AbortSignal;
  consumers: import("./owned-consumers.js").HostConsumers;
};
export interface Driver {
  observe?(binding: DriverObservationBinding): Promise<DriverObservation>;
  press(key: HostKey, control: DriverPressControl): Promise<void>;
  start(signal: AbortSignal): Promise<void>;
  createWindow(signal: AbortSignal): Promise<string>;
  selectWindow(handle: string, signal: AbortSignal): Promise<void>;
  reloadWindow(signal: AbortSignal): Promise<void>;
  closeWindow(signal: AbortSignal): Promise<void>;
  navigate(url: string, signal: AbortSignal): Promise<void>;
  handle(signal: AbortSignal): Promise<string>;
  handles(signal: AbortSignal): Promise<string[]>;
  url(signal: AbortSignal): Promise<string>;
  script(source: string, signal: AbortSignal): Promise<unknown>;
  stop(): Promise<DriverCleanup>;
  readonly uncertain: boolean;
}
export async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineError(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function parseSession(value: unknown): string {
  if (!record(value) || typeof value.sessionId !== "string" || !value.sessionId)
    throw new Error("Invalid WebDriver session answer");
  return value.sessionId;
}
export function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected WebDriver string value");
  return value;
}
