/** Observes the original command's native Workers without replacing any transport or buffer. */
export function observeFilesystemWorkers() {
  const NativeWorker = globalThis.Worker;
  const live = new Set<Worker>();
  const shared = new WeakSet<SharedArrayBuffer>();
  let sharedBuffers = 0;
  let sharedBytes = 0;
  let created = 0;
  let ready = 0;
  let completed = 0;
  let disposed = 0;
  function observe(value: unknown, seen = new Set<object>()): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value instanceof SharedArrayBuffer) {
      if (shared.has(value)) return;
      shared.add(value);
      sharedBuffers++;
      sharedBytes += value.byteLength;
      return;
    }
    if (ArrayBuffer.isView(value)) return observe(value.buffer, seen);
    for (const item of Object.values(value)) observe(item, seen);
  }
  class ObservedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      live.add(this);
      created++;
      this.addEventListener("message", ({ data }) => {
        if (data?.type === "ready") ready++;
        if (data?.type === "done") completed++;
        if (data?.type === "disposed") disposed++;
      });
    }
    override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      observe(message);
      if (Array.isArray(options)) super.postMessage(message, options);
      else super.postMessage(message, options);
    }
    override terminate(): void {
      super.terminate();
      live.delete(this);
    }
  }
  globalThis.Worker = ObservedWorker;
  return {
    snapshot() {
      return {
        created,
        ready,
        completed,
        disposed,
        live: live.size,
        sharedBuffers,
        sharedBytes,
      };
    },
    restored: () => globalThis.Worker === NativeWorker,
    close() {
      for (const worker of live) worker.terminate();
      globalThis.Worker = NativeWorker;
    },
  };
}
