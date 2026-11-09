import { record } from "./protocol.js";
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
export interface Driver {
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
