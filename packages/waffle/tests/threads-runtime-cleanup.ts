export type ThreadRuntimeCleanup = {
  readonly release: readonly (() => void)[];
  readonly dispose: () => Promise<void>;
  readonly workers: readonly Pick<Worker, "terminate">[];
  readonly restore: () => void;
};

function attempt(action: () => void, errors: unknown[]): void {
  try {
    action();
  } catch (error) {
    errors.push(error);
  }
}

function stopWorkers(workers: ThreadRuntimeCleanup["workers"], errors: unknown[]): void {
  for (const worker of workers) attempt(() => worker.terminate(), errors);
}

export async function cleanupThreadRuntime(resources: ThreadRuntimeCleanup): Promise<void> {
  const errors: unknown[] = [];
  try {
    for (const release of resources.release) attempt(release, errors);
    try {
      await resources.dispose();
    } catch (error) {
      errors.push(error);
    }
    stopWorkers(resources.workers, errors);
  } finally {
    resources.restore();
  }
  if (errors.length) throw new AggregateError(errors, "Runtime thread cleanup failed");
}

export function releaseThreadBarriers(barriers: Iterable<Worker>, released: boolean): void {
  if (released) return;
  const errors: unknown[] = [];
  for (const worker of barriers)
    attempt(() => worker.postMessage({ kind: "fixture-release" }), errors);
  if (errors.length) throw new AggregateError(errors, "Runtime thread barrier release failed");
}
