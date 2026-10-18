import { ExecutionUnwind } from "../core/unwind.js";
import { directoryState } from "../proc/directory.js";
import { controlLoad, controlWait } from "../proc/control.js";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { WasiExit } from "../core/wasi.js";
import { sharedRevoked, revokeFilesystem } from "../fs/index.js";
import { claimOutcome, outcomeWord, processOutcome, readOutcome, markStarted, reviveOutcome } from "../proc/outcome.js";
import { ExecutableFormatError, startFailure } from "../proc/start-failure.js";
import { waitStatus } from "../proc/wait-status.js";
import type { RuntimeWorkerRequest, RuntimeWorkerMessage, WorkerExecutor } from "../browser/worker.js";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(new URL("../browser/worker.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "")
    .replace(/import\("\.\.\/proc\/worker-client\.js"\)/g, "loadRuntime()")
    .concat("\nglobalThis.runBootstrap = bootstrap;\n"),
);

export async function failFirstWorkerImport(request: RuntimeWorkerRequest, postMessage: (message: RuntimeWorkerMessage) => void) {
  const context = {
    performance, Error, SharedArrayBuffer, Int32Array, BigInt64Array, Atomics, TextEncoder,
    directoryState, controlLoad, controlWait, ExecutionUnwind, WasiExit, sharedRevoked, revokeFilesystem, claimOutcome, outcomeWord, processOutcome, readOutcome, markStarted, reviveOutcome, waitStatus, ExecutableFormatError, startFailure,
    FilesystemClient: class {
      connection = request.filesystem;
      dispose() { request.filesystem.port.close(); }
    },
    loadRuntime: async () => { throw new Error("first worker-client import rejected"); },
    runBootstrap: undefined as unknown as (request: RuntimeWorkerRequest, executor: WorkerExecutor, host: object) => Promise<void>,
  };
  runInNewContext(source, context);
  await context.runBootstrap(request, { run() { throw new Error("must not execute"); } }, { crossOriginIsolated: true, postMessage });
}
