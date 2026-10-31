import { bindImportedMemory, createWorkerMemorySampler } from "../browser/worker-memory.js";
import { ExecutionUnwind } from "../core/unwind.js";
import { directoryState, isCollectedProcess } from "../proc/directory.js";
import * as processIntrinsics from "../proc/intrinsics.ts";
import { controlLoad, controlWait } from "../proc/control.js";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { WasiExit } from "../core/wasi.js";
import { sharedRevoked, revokeFilesystem } from "../fs/index.js";
import {
  claimOutcome,
  outcomeWord,
  processOutcome,
  readOutcome,
  markStarted,
  reviveOutcome,
} from "../proc/outcome.js";
import { ExecutableFormatError, startFailure } from "../proc/start-failure.js";
import { waitStatus } from "../proc/wait-status.js";
import type {
  RuntimeWorkerRequest,
  RuntimeWorkerMessage,
  WorkerExecutor,
} from "../browser/worker.js";

const workerSource = new URL("../browser/worker.ts", import.meta.url);
// Only worker-client fails; the bootstrap's other lazy imports load the real modules. Rewriting
// after transpiling leaves type-only import() references out of it.
const source = new Bun.Transpiler({ loader: "ts" })
  .transformSync(
    readFileSync(workerSource, "utf8")
      .replace(/^import\s+[\s\S]*?;\r?\n/gm, "")
      .replace(/^export /gm, ""),
  )
  .replace(/import\("(\.\.?\/[^"]+)"\)/g, (_, specifier: string) =>
    specifier === "../proc/worker-client.js"
      ? "loadRuntime()"
      : `loadModule(${JSON.stringify(specifier)})`,
  )
  .concat("\nglobalThis.runBootstrap = bootstrap;\n");

export async function failFirstWorkerImport(
  request: RuntimeWorkerRequest,
  postMessage: (message: RuntimeWorkerMessage) => void,
) {
  const context = {
    ...processIntrinsics,
    createWorkerMemorySampler,
    bindImportedMemory,
    performance,
    AbortController,
    Error,
    SharedArrayBuffer,
    Int32Array,
    BigInt64Array,
    Atomics,
    TextEncoder,
    directoryState,
    isCollectedProcess,
    controlLoad,
    controlWait,
    ExecutionUnwind,
    WasiExit,
    sharedRevoked,
    revokeFilesystem,
    claimOutcome,
    outcomeWord,
    processOutcome,
    readOutcome,
    markStarted,
    reviveOutcome,
    waitStatus,
    ExecutableFormatError,
    startFailure,
    FilesystemClient: class {
      connection = request.filesystem;
      dispose() {
        request.filesystem.port.close();
      }
    },
    loadModule: (specifier: string) => import(new URL(specifier, workerSource).href),
    loadRuntime: async () => {
      throw new Error("first worker-client import rejected");
    },
    runBootstrap: undefined as unknown as (
      request: RuntimeWorkerRequest,
      executor: WorkerExecutor,
      host: object,
    ) => Promise<void>,
  };
  runInNewContext(source, context);
  await context.runBootstrap(
    request,
    {
      run() {
        throw new Error("must not execute");
      },
    },
    { crossOriginIsolated: true, postMessage },
  );
}
