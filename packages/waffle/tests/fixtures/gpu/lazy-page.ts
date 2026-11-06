import { createRuntime, type Runtime } from "../../../runtime.js";
let runtime: Runtime;
const OriginalWorker = Worker;
const workers: { url: string; stopped: boolean }[] = [];
/** @browserEntry */
export async function lazy(stage: "filesystem" | "display" | "process" | "dispose") {
  if (stage === "filesystem") {
    globalThis.Worker = class extends OriginalWorker {
      readonly record: { url: string; stopped: boolean };
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.record = { url: String(url), stopped: false };
        workers.push(this.record);
      }
      override terminate() {
        this.record.stopped = true;
        return super.terminate();
      }
    };
    runtime = createRuntime({ filesystem: { mode: "memory", workerURL: "/fs-worker.js" } });
    await runtime.filesystem.writeFile("/lazy", "proof");
  }
  if (stage === "display") {
    const display = await runtime.display(),
      canvas = document.createElement("canvas");
    display.createSurface(canvas);
  }
  if (stage === "process") await (await runtime.processes()).ready();
  if (stage === "dispose") {
    await runtime.dispose();
    globalThis.Worker = OriginalWorker;
  }
  return {
    workers,
    resources: performance
      .getEntriesByType("resource")
      .map((entry) => new URL(entry.name).pathname),
  };
}
