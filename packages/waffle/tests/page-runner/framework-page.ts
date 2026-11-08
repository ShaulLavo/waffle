import type { FrameworkTask, FrameworkUpdate, Json } from "./framework-types.js";
export type { FrameworkTask, FrameworkUpdate, Json } from "./framework-types.js";
export interface FrameworkObservation {
  readonly signal: AbortSignal;
  collected(snapshot: () => readonly FrameworkTask[]): Promise<void>;
  taskStarted(snapshot: () => string): Promise<void>;
  taskUpdate(snapshot: () => readonly FrameworkUpdate[]): Promise<void>;
  caseSettled(snapshot: () => readonly FrameworkUpdate[] | null): Promise<void>;
  error(snapshot: () => { error: Json; source: string }): Promise<void>;
  executionFlushed(): Promise<void>;
  testerCleanupSettled(): Promise<void>;
  cleanupResponseReceived(): Promise<void>;
  catcherInstalled(): void;
  waitForInitialViewport(): Promise<{ permit: string; width: 414; height: 896 }>;
  waitForRetirement(): Promise<void>;
}
// The bootstrap installs one accessor before any framework module evaluates.
export function getFrameworkObservation(): FrameworkObservation | undefined {
  if (typeof document === "undefined") return;
  const accessor: unknown = Reflect.get(globalThis, Symbol.for("waffle.framework.observation"));
  return typeof accessor === "function" ? accessor() : undefined;
}
