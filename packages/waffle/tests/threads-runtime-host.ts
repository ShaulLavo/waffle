import { BrowserProcessBroker } from "../browser/process-broker.js";
import { bytes, declareSharedMemoryPlatform } from "../memory/index.js";
import { createRuntime } from "../runtime.js";

type ProcessFilesystem = ConstructorParameters<typeof BrowserProcessBroker>[0]["filesystem"];

export function createThreadRuntime(
  local: boolean,
  errors: string[],
  fixture?: { workerURL: string | URL; connect(filesystem: ProcessFilesystem): void },
) {
  return createRuntime({
    sharedMemory: declareSharedMemoryPlatform({
      kind: "bounded",
      budgetBytes: bytes(3 * 1024 ** 3),
      counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
    }),
    filesystem: {
      mode: "memory",
      workerURL:
        fixture?.workerURL ??
        (local ? new URL("../browser/fs-worker.ts", import.meta.url) : "/fs-worker.js"),
    },
    processHost: (options) => {
      fixture?.connect(options.filesystem);
      return new BrowserProcessBroker({
        ...options,
        onError: (error) => errors.push(String(error)),
      });
    },
  });
}
