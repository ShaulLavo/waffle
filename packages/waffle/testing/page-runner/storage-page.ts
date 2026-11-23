import { storageCase, type WorkerRequest } from "./storage-worker.js";
import { cleanupStorage } from "./storage-cleanup.js";
import { validateWorkerLabel } from "./protocol.js";
import { startPage } from "./page-main.js";

startPage<Extract<WorkerRequest, { kind: "run" }>>({
  list: () => storageCase({ kind: "list" }),
  async run(request, allocate) {
    const returned = await storageCase<unknown>(request, allocate);
    validateWorkerLabel(returned, request.label);
    return returned;
  },
  finish: cleanupStorage,
});
