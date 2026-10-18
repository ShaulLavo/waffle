export type BrowserResourceOwner = {
  creation: Promise<{ close(): Promise<void> }>;
  stopped: boolean;
  stopping?: Promise<void>;
};

async function bounded<T>(operation: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Process browser ${phase} did not settle during teardown`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Context creation can itself stall. Keep ownership until closure is confirmed;
 * the caller must still close its browser when this bounded attempt fails. */
export function stopBrowserResource<T extends BrowserResourceOwner>(
  owners: Set<T>,
  owner: T,
  timeoutMs = 10_000,
): Promise<void> {
  return (owner.stopping ??= (async () => {
    // Keep a late creation attached to its teardown even after the bounded caller
    // has returned. A timed-out launch must not later create an unowned browser.
    const creation = owner.creation.catch(() => undefined);
    const closure = creation.then(async (resource) => {
      await resource?.close();
      owner.stopped = true;
      owners.delete(owner);
    });
    // Observe closure immediately: creation can settle before its own deadline.
    void closure.catch(() => {});
    await bounded(creation, timeoutMs, "resource creation");
    await bounded(closure, timeoutMs, "resource closure");
  })());
}

/** Never let one stalled context prevent the enclosing browser from shutting down.
 * A confirmed browser close also disposes its in-flight and already-created contexts. */
export async function closeBrowserResources<
  C extends BrowserResourceOwner,
  B extends BrowserResourceOwner,
>(contexts: Set<C>, browsers: Set<B>, timeoutMs = 10_000): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const owner of contexts) {
    try {
      await stopBrowserResource(contexts, owner, timeoutMs);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const owner of browsers) {
    try {
      await stopBrowserResource(browsers, owner, timeoutMs);
    } catch (error) {
      errors.push(error);
    }
  }
  if (browsers.size === 0) contexts.clear();
  return errors;
}
