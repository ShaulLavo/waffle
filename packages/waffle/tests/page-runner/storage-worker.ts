import type { StorageEntry } from "../storage-allocation.js";
export type Backend = "indexeddb" | "opfs";
export type WorkerRequest =
  | { kind: "list" }
  | { kind: "run"; backend: Backend; label: string; allocationPrefix?: string };
export type TestList = Record<Backend, string[]>;

// Bun strips the types before toString(): the worker has TypeScript source, not handwritten JS.
export function storageWorker(): void {
  function labels(suites: Record<Backend, { label: string }[]>): TestList {
    return {
      indexeddb: suites.indexeddb.map((test) => test.label),
      opfs: suites.opfs.map((test) => test.label),
    };
  }
  async function runStorageRequest(request: WorkerRequest): Promise<void> {
    const modulePath = "/tests.js";
    const tests = (await import(modulePath)) as typeof import("../storage-browser");
    // The runner owns this route; imported backend suites do not assume one exists.
    const hooks =
      request.kind === "run" && request.allocationPrefix
        ? {
            name: () => `${request.allocationPrefix}-${crypto.randomUUID()}`,
            async allocate(entry: StorageEntry) {
              const acknowledged = new Promise<void>((resolve) => {
                const receive = (event: MessageEvent) => {
                  if (event.data?.kind !== "allocation-ack") return;
                  globalThis.removeEventListener("message", receive);
                  resolve();
                };
                globalThis.addEventListener("message", receive);
              });
              globalThis.postMessage({ allocation: entry });
              await acknowledged;
            },
          }
        : undefined;
    const suites = {
      indexeddb: tests.storageTests("/fs-worker.js", "/open-fs-worker.js", hooks),
      opfs: tests.opfsStorageTests("/fs-worker.js", hooks),
    };
    if (request.kind === "list") {
      globalThis.postMessage({ result: labels(suites) });
      return;
    }
    const { backend, label } = request;
    const test = suites[backend].find((test) => test.label === label);
    if (!test) throw new Error(`Unknown ${backend} storage test: ${label}`);
    await test.run();
    globalThis.postMessage({ result: label });
  }
  globalThis.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    if (event.data.kind !== "list" && event.data.kind !== "run") return;
    try {
      await runStorageRequest(event.data);
    } catch (error) {
      // WebKit's stack contains locations only: never let it replace the actual error message.
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
          : String(error);
      const environment = {
        secureContext: globalThis.isSecureContext,
        crossOriginIsolated: globalThis.crossOriginIsolated,
        getDirectory: typeof navigator.storage?.getDirectory,
        syncAccess:
          typeof FileSystemFileHandle === "undefined"
            ? "undefined"
            : typeof (
                FileSystemFileHandle.prototype as FileSystemFileHandle & {
                  createSyncAccessHandle?: unknown;
                }
              ).createSyncAccessHandle,
      };
      globalThis.postMessage({
        error: `${detail}\nWorker environment: ${JSON.stringify(environment)}`,
      });
    }
  };
}

export function storageCase<T>(
  request: WorkerRequest,
  allocate?: (entry: StorageEntry) => Promise<void>,
): Promise<T> {
  function settle(
    data: { error?: string; result: T },
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void,
  ): void {
    if (data.error) reject(new Error(data.error));
    else resolve(data.result);
  }
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker("/worker.js", { type: "module" });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("storage case worker timed out"));
    }, 45_000);
    const finish = () => {
      clearTimeout(timeout);
      worker.terminate();
    };
    worker.onmessage = (event) => {
      if (event.data?.allocation && allocate) {
        void allocate(event.data.allocation).then(
          () => worker.postMessage({ kind: "allocation-ack" }),
          (error: unknown) => {
            finish();
            reject(error);
          },
        );
        return;
      }
      finish();
      settle(event.data, resolve, reject);
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message));
    };
    worker.onmessageerror = () => {
      finish();
      reject(new Error("Could not decode storage worker response"));
    };
    worker.postMessage(request);
  });
}
