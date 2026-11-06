import type { FrameworkTask, FrameworkUpdate, Json } from "./framework-types.js";
export type { FrameworkTask, FrameworkUpdate, Json } from "./framework-types.js";
export interface FrameworkObservation {
  collected(tasks: readonly FrameworkTask[]): Promise<void>;
  taskStarted(id: string): void;
  taskUpdate(updates: readonly FrameworkUpdate[]): void;
  caseSettled(updates: readonly FrameworkUpdate[]): void;
  error(error: Json, source: string): void;
  executionFlushed(): void;
  testerCleanupSettled(): void;
  cleanupResponseReceived(): void;
  catcherInstalled(): void;
  waitForInitialViewport(): Promise<{ permit: string; width: 414; height: 896 }>;
  waitForRetirement(): Promise<void>;
}
const observations = new WeakMap<Document, FrameworkObservation>();
// The bootstrap installs one accessor before any framework module evaluates.
export function getFrameworkObservation(): FrameworkObservation | undefined {
  if (typeof document === "undefined") return;
  const accessor: unknown = Reflect.get(globalThis, Symbol.for("waffle.framework.observation"));
  return typeof accessor === "function" ? accessor() : observations.get(document);
}
