const sharedMemory = declareSharedMemoryPlatform({ kind: "unbounded" });
import { declareSharedMemoryPlatform } from "waffle";
import { createRuntime } from "waffle";
import { qualifyPython } from "./qualification.ts";
import { browserUsageCases } from "./public-usage.ts";

Reflect.set(
  globalThis,
  "pythonPackageResult",
  (async () => {
    const runtime = createRuntime({
      sharedMemory,
      filesystem: { mode: "memory", workerURL: "/waffle-dist/browser/fs-worker.js" },
    });
    try {
      return await qualifyPython(runtime, {
        workerUrl: new URL("/waffle-dist/browser/preview1-worker.js", location.href),
        wasmUrl: new URL("/assets/python.wasm", location.href),
        payloadUrl: new URL("/assets/python-stdlib.json", location.href),
        publicUsageCases: browserUsageCases,
      });
    } finally {
      await runtime.dispose();
      document.body.dataset.disposed = String(runtime.disposed);
    }
  })(),
);
