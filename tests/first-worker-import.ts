import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { WasiExit } from "../core/wasi";
import { sharedRevoked, revokeFilesystem } from "../fs";
import { claimOutcome, outcomeWord, processOutcome, readOutcome } from "../proc/outcome";
import { waitStatus } from "../proc/wait-status";
import type { RuntimeWorkerRequest, RuntimeWorkerMessage, WorkerExecutor } from "../browser/worker";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(new URL("../browser/worker.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "")
    .replace(/import\("\.\.\/proc\/worker-client"\)/g, "loadRuntime()")
    .concat("\nglobalThis.runBootstrap = bootstrap;\n"),
);

export async function failFirstWorkerImport(request: RuntimeWorkerRequest, postMessage: (message: RuntimeWorkerMessage) => void) {
  const context = {
    performance, Error, SharedArrayBuffer, Int32Array, BigInt64Array, Atomics, TextEncoder,
    WasiExit, sharedRevoked, revokeFilesystem, claimOutcome, outcomeWord, processOutcome, readOutcome, waitStatus,
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
