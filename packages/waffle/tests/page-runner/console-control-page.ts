import { startPage, cleanupStorage } from "./consumer-page.js";

type ControlRequest = { mode: string; marker: string };
async function workerControl({ mode, marker }: ControlRequest): Promise<void> {
  const url = new URL(
    mode === "worker-first-line" ? "/console-first-line.js" : "/console-worker.js",
    location.href,
  );
  url.searchParams.set("mode", mode);
  url.searchParams.set("marker", marker);
  const worker = new Worker(url);
  if (mode === "clean-prompt-cancel") {
    worker.terminate();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    worker.onmessage = () => resolve();
    worker.onerror = () => reject(new Error("Control worker body failed"));
    if (mode === "worker-only") worker.postMessage("log");
  });
  if (mode === "worker-error-page-terminate" || mode === "clean-completion-terminate")
    worker.terminate();
}
startPage<ControlRequest>({
  list: async () => ["console"],
  async run(request) {
    if (request.mode === "page-error") console.error(request.marker);
    if (request.mode !== "page-clean" && request.mode !== "page-error")
      await workerControl(request);
    return { body: "pass", marker: request.marker, mode: request.mode };
  },
  finish: cleanupStorage,
});
