/** Preserve the body failure while attempting every disposer in its original order. */
export async function finishNetworkCase(
  primary: { error: unknown } | undefined,
  disposers: readonly (() => unknown)[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (!errors.length) return;
  if (primary) errors.unshift(primary.error);
  throw new AggregateError(errors, "Network case and fixture cleanup failed");
}
