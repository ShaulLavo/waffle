const sharedMemory = declareSharedMemoryPlatform({ kind: "unbounded" });
import { declareSharedMemoryPlatform } from "waffle";
import { createRuntime } from "waffle";
import { runLazyBaseAcceptance } from "./family-integration.ts";

const runtime = createRuntime({
  sharedMemory,
  filesystem: { mode: "memory", workerURL: new URL("/fs-worker.js", location.href) },
});
try {
  const result = await runLazyBaseAcceptance(
    runtime,
    new URL("/preview1-worker.js", location.href),
  );
  document.body.textContent = JSON.stringify({ ok: true, result });
} catch (error) {
  document.body.textContent = JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.stack : String(error),
  });
} finally {
  await runtime.dispose();
  document.body.dataset.done = "true";
  document.body.dataset.disposed = String(runtime.disposed);
}
