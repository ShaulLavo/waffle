import { storageTests, opfsStorageTests } from "../storage-browser.js";
import type { WorkerRequest } from "./storage-worker.js";
declare const STORAGE_PAGE_LABEL: "wrong" | "missing";
globalThis.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.kind === "list") {
    globalThis.postMessage({
      result: {
        indexeddb: storageTests("/fs-worker.js", "/open-fs-worker.js").map((item) => item.label),
        opfs: opfsStorageTests("/fs-worker.js").map((item) => item.label),
      },
    });
    return;
  }
  globalThis.postMessage(STORAGE_PAGE_LABEL === "wrong" ? { result: "WRONG_WORKER_LABEL" } : {});
};
