import { createRuntime } from "@waffle-os/runtime";
import {
  createLoadRecovery,
  observeWorkerEntry,
  type LoadFailure,
} from "../../../../docs/examples/asset-load-recovery.ts";

const failures: LoadFailure[] = [];
const runtime = createRuntime({
  filesystem: { mode: "memory", workerURL: new URL("/fs-worker.js", location.href) },
});
let failPreservation = false;
let editor = "unsaved editor buffer";
const workers: Worker[] = [];
let workerErrors = 0;
const recovery = createLoadRecovery({
  showFailure: (failure) => {
    failures.push(failure);
  },
  storage: () => sessionStorage,
  preserve: async () => {
    if (failPreservation) throw new Error("flush failed; copy unsaved work");
    await runtime.filesystem.flush();
    sessionStorage.setItem("recovery:editor", editor);
    sessionStorage.setItem("recovery:file", await read());
  },
  navigate: () => location.reload(),
});
const read = async () => new TextDecoder().decode(await runtime.filesystem.readFile("/dirty.txt"));
await runtime.filesystem.writeFile("/dirty.txt", "unflushed file contents");

const controls = {
  ready: true,
  async load() {
    try {
      await recovery.load("process service", () => runtime.processes());
      return "loaded";
    } catch {
      return "failed";
    }
  },
  worker(path: string) {
    const worker = new Worker(path, { type: "module" });
    workers.push(worker);
    worker.addEventListener("error", () => {
      workerErrors++;
    });
    const stop = observeWorkerEntry(worker, path, recovery.report);
    worker.addEventListener("message", (event) => {
      if (event.data === "ready") stop();
    });
    worker.postMessage("start");
  },
  async snapshot() {
    return {
      failures: failures.map(({ kind, resource, cause }) => ({
        kind,
        resource,
        message: cause instanceof Error ? cause.message : "worker error event",
      })),
      editor,
      file: await read(),
      guarded: sessionStorage.getItem("waffle:load-recovery-attempted"),
      workerErrors,
    };
  },
  async reload(fail: boolean) {
    failPreservation = fail;
    try {
      return await recovery.reload();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  },
  restored: {
    editor: sessionStorage.getItem("recovery:editor"),
    file: sessionStorage.getItem("recovery:file"),
  },
  async dispose() {
    for (const worker of workers) worker.terminate();
    try {
      await runtime.dispose();
    } catch (error) {
      if (error !== failures[0]?.cause) throw error;
    }
    editor = "";
  },
};

declare global {
  interface Window {
    assetRecovery: typeof controls;
  }
}
window.assetRecovery = controls;
