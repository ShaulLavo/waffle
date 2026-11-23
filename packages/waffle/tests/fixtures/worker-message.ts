/** The Worker's next message, or a rejection on its error or after 5 seconds. */
export function workerMessage(worker: Worker, label = "pipe reuse worker"): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`${label} timed out`)), 5000);
    const onMessage = (event: MessageEvent<unknown>) => finish(undefined, event.data);
    const onError = (event: ErrorEvent) => finish(event.error ?? new Error(event.message));
    function finish(error?: unknown, value?: unknown) {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve(value);
    }
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}
