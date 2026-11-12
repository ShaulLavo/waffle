/** Record independent cleanup failures in execution order, including falsy thrown values. */
export async function attemptCleanup(failures: unknown[], action: () => unknown): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push(error);
  }
}

export function throwCleanupFailures(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, message, { cause: failures[0] });
}
