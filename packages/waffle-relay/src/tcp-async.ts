export async function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    throw signal.reason;
  }
  const cancellation = Promise.withResolvers<never>();
  const abort = () => cancellation.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([promise, cancellation.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("TCP cleanup deadline")), ms);
  try {
    return await cancellable(promise, abort.signal);
  } finally {
    clearTimeout(timer);
  }
}
