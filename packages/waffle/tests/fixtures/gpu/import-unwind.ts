import { RuntimeWorkerSignal } from "../../../browser/worker.js";
import { WasiExit } from "../../../core/index.js";
import { ProcessSignalExit } from "../../../proc/abi.js";

type ImportUnwind = { kind: "signal"; code: number } | { kind: "exit"; code: number };

export function importUnwind(error: unknown): ImportUnwind | undefined {
  if (error instanceof RuntimeWorkerSignal || error instanceof ProcessSignalExit)
    return { kind: "signal", code: error.signal };
  if (error instanceof WasiExit) return { kind: "exit", code: error.code };
  return undefined;
}
