export type ResourceCloseEvent =
  | { kind: "started"; resource: { close(): Promise<void> } }
  | { kind: "fulfilled"; resource: { close(): Promise<void> } }
  | { kind: "rejected"; resource: { close(): Promise<void> }; reason: unknown };
export type ResourceCloseObserver = { record(event: ResourceCloseEvent): void; errors: unknown[] };
export type BrowserResourceOwner = {
  creation: Promise<{ close(): Promise<void> }>;
  stopped: boolean;
  observeClose?: ResourceCloseObserver;
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

function notifyClose(observer: ResourceCloseObserver, event: ResourceCloseEvent): void {
  try {
    observer.record(event);
  } catch (reason) {
    observer.errors.push(reason);
  }
}
function closeResource(
  resource: Awaited<BrowserResourceOwner["creation"]> | undefined,
  observer?: ResourceCloseObserver,
): Promise<void> | undefined {
  if (!resource) return;
  if (!observer) return resource.close();
  notifyClose(observer, { kind: "started", resource });
  try {
    const promise = resource.close();
    void promise.then(
      () => notifyClose(observer, { kind: "fulfilled", resource }),
      (reason: unknown) => notifyClose(observer, { kind: "rejected", resource, reason }),
    );
    return promise;
  } catch (reason) {
    notifyClose(observer, { kind: "rejected", resource, reason });
    throw reason;
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
      await closeResource(resource, owner.observeClose);
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
