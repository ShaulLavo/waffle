import type { FrameworkObservation } from "./framework-page.js";
export function reportingTypes(observation: FrameworkObservation): void {
  const operations: Promise<void>[] = [
    observation.collected(() => []),
    observation.taskStarted(() => "id"),
    observation.taskUpdate(() => []),
    observation.caseSettled(() => null),
    observation.error(() => ({ error: null, source: "type-control" })),
    observation.executionFlushed(),
    observation.testerCleanupSettled(),
    observation.cleanupResponseReceived(),
  ];
  void Promise.allSettled(operations);
  const signal: AbortSignal = observation.signal;
  void signal;
  // @ts-expect-error Values must be captured after admission, never passed preconverted.
  void observation.collected([]);
  // @ts-expect-error Snapshot factories are synchronous.
  void observation.taskStarted(async () => "id");
  // @ts-expect-error The old error overload is not supported.
  void observation.error(null, "source");
}
