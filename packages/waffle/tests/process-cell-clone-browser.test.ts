import { expect, test } from "bun:test";
import { browserStaleCellClone } from "./process-cell-clone-browser.ts";

const NativeWorker = globalThis.Worker;
const workers: Worker[] = [];
class CellCloneWorker extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    if (url !== "/cell-worker.js") throw new Error(`Unexpected fixture worker: ${url}`);
    super(new URL("./fixtures/browser-cell-clone.ts", import.meta.url), options);
    workers.push(this);
  }
}
for (const job of [false, true]) {
  test(`browser cell-clone fixture recycles its ${job ? "job" : "process"} row after return`, async () => {
    globalThis.Worker = CellCloneWorker;
    try {
      await browserStaleCellClone(job);
      expect(workers).toHaveLength(1);
    } finally {
      globalThis.Worker = NativeWorker;
      for (const worker of workers.splice(0)) await worker.terminate();
    }
  });
}
