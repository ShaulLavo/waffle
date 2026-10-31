// Threads take no parent CLI flags: test-runner and stdin-module flags are not theirs.
import { Worker as Thread, MessagePort } from "node:worker_threads";
const bootstrap = new URL("./node-worker-thread.ts", import.meta.url);
const live = new Set<Thread>();
class WorkerFailure extends Event {
  readonly error: Error;
  constructor(error: Error) {
    super("error", { cancelable: true });
    this.error = error;
  }
  get message() {
    return this.error.message;
  }
}
class NodeWorker extends EventTarget {
  readonly thread: Thread;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: WorkerFailure) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  constructor(url: string | URL) {
    super();
    this.thread = new Thread(bootstrap, { workerData: { entry: String(url) }, execArgv: [] });
    live.add(this.thread);
    this.thread.on("exit", () => live.delete(this.thread));
    this.thread.on("message", (data) => {
      const event = new MessageEvent("message", { data });
      this.onmessage?.(event);
      this.dispatchEvent(event);
    });
    this.thread.on("messageerror", (data) => {
      const event = new MessageEvent("messageerror", { data });
      this.onmessageerror?.(event);
      this.dispatchEvent(event);
    });
    this.thread.on("error", (error) => {
      const event = new WorkerFailure(error instanceof Error ? error : new Error(String(error)));
      this.onerror?.(event);
      this.dispatchEvent(event);
    });
  }
  postMessage(message: unknown, transfer: readonly unknown[] = []) {
    this.thread.postMessage(
      message,
      transfer.filter(
        (value): value is ArrayBuffer | MessagePort =>
          value instanceof ArrayBuffer || value instanceof MessagePort,
      ),
    );
  }
  terminate() {
    return this.thread.terminate();
  }
}
export function liveNodeWorkers(): number {
  return live.size;
}
export function installNodeWorkers(): void {
  Object.defineProperty(globalThis, "Worker", { value: NodeWorker, configurable: true });
  Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, configurable: true });
}
export async function stopNodeWorkers(): Promise<void> {
  await Promise.all(Array.from(live, (thread) => thread.terminate()));
}
