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
  function waitForAllocationAck(resolve: () => void): void {
    const receive = (event: MessageEvent) => {
      if (event.data?.kind !== "allocation-ack") return;
      globalThis.removeEventListener("message", receive);
      resolve();
    };
    globalThis.addEventListener("message", receive);
  }
  async function reportAllocation(entry: StorageEntry): Promise<void> {
    const acknowledged = new Promise<void>(waitForAllocationAck);
    globalThis.postMessage({ allocation: entry });
    await acknowledged;
  }
  function allocationHooks(request: WorkerRequest) {
    if (request.kind !== "run" || !request.allocationPrefix) return undefined;
    return {
      name: () => `${request.allocationPrefix}-${crypto.randomUUID()}`,
      allocate: reportAllocation,
    };
  }
  function errorDetail(error: unknown, depth = 0): string {
    if (!(error instanceof Error)) return String(error).slice(0, 16_384);
    const detail = `${error.name}: ${error.message}\n${error.stack ?? ""}`;
    if (!(error instanceof AggregateError) || depth >= 3) return detail.slice(0, 16_384);
    const causes = error.errors
      .slice(0, 8)
      .map((cause) => errorDetail(cause, depth + 1).slice(0, 1600));
    return `${error.name}: ${error.message.slice(0, 1024)}\nCauses, primary first:\n${causes.join("\n")}`;
  }
  async function runStorageRequest(request: WorkerRequest): Promise<void> {
    const modulePath = "/tests.js";
    const tests = (await import(modulePath)) as typeof import("../storage-browser");
    // The runner owns this route; imported backend suites do not assume one exists.
    const hooks = allocationHooks(request);
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
      const detail = errorDetail(error);
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

type StorageReply<T> = { allocation?: StorageEntry; error?: string; result: T };
export function storageCase<T>(
  request: WorkerRequest,
  allocate?: (entry: StorageEntry) => Promise<void>,
): Promise<T> {
  function storageReply(
    data: StorageReply<T>,
    worker: Worker,
    allocate: ((entry: StorageEntry) => Promise<void>) | undefined,
    finish: () => void,
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void,
  ): void {
    const acknowledged = () => worker.postMessage({ kind: "allocation-ack" });
    const failed = (error: unknown) => {
      finish();
      reject(error);
    };
    if (data.allocation && allocate) {
      void allocate(data.allocation).then(acknowledged, failed);
      return;
    }
    finish();
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
    worker.onmessage = (event: MessageEvent<StorageReply<T>>) =>
      storageReply(event.data, worker, allocate, finish, resolve, reject);
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
