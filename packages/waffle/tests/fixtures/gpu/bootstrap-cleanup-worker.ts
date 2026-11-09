import {
  bootstrap,
  RuntimeWorkerSignal,
  type RuntimeWorkerRequest,
  type WorkerBindingsContext,
  type WorkerExecutor,
} from "../../../browser/worker.js";
import { WasiExit } from "../../../core/index.js";
import { ProcessError } from "../../../proc/errors.js";
import { RecordRing } from "../../../browser/gpu/ring.js";
import { section, text } from "../publication-wasm.js";

export type CleanupMode =
  | "signal"
  | "retained-signal"
  | "unobserved-signal"
  | "revoke-first"
  | "explicit-close"
  | "normal"
  | "exit137"
  | "error";
export interface CleanupRequest extends Omit<RuntimeWorkerRequest, "module"> {
  mode: CleanupMode;
  barrier: Int32Array;
}

export interface CleanupMetrics {
  entered: number;
  returned: number;
  signal: number;
  errno: number;
  cleanupRevocation: number;
}
interface RunState {
  request: CleanupRequest;
  memory: WebAssembly.Memory;
  metrics: CleanupMetrics;
}

// Import metadata only: no defined functions, code section or compiled guest is executed.
function graphicsImports(): WebAssembly.Module {
  const imports = ["open", "completions", "close"].flatMap((name) =>
    text("runtime_gpu").concat(text(name), [0, 0]),
  );
  return new WebAssembly.Module(
    Uint8Array.from(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [1, 0x60, 0, 0]),
        section(2, [3].concat(imports)),
      ),
    ),
  );
}
function pause(request: CleanupRequest, index: number, type: string): void {
  self.postMessage({ type });
  if (Atomics.load(request.barrier, index)) return;
  if (Atomics.wait(request.barrier, index, 0, 3000) === "timed-out")
    throw new Error(`Cleanup fixture stalled at ${type}`);
}
function gpuCall(imports: WebAssembly.Imports, name: string) {
  const method = imports.runtime_gpu?.[name];
  if (typeof method !== "function") throw new Error(`Missing GPU import ${name}`);
  return method;
}
function start(state: RunState, imports: WebAssembly.Imports, context: WorkerBindingsContext) {
  const { request, memory, metrics } = state;
  if (gpuCall(imports, "open")(0, 0) !== 0) throw new Error("GPU open failed");
  const id = new DataView(memory.buffer).getUint32(0, true);
  if (request.mode === "normal") return;
  if (request.mode === "exit137") throw new WasiExit(137);
  if (request.mode === "error") throw new ProcessError(71, "ordinary fixture error");
  if (request.mode === "explicit-close") {
    if (gpuCall(imports, "close")(id) !== 0) throw new Error("GPU close failed");
    pause(request, 0, "waiting");
    context.checkActive();
    throw new Error("Selected terminal did not unwind");
  }
  metrics.entered++;
  gpuCall(imports, "completions")(id, 16, 128, -1n, 4);
  metrics.returned++;
  throw new Error("Held GPU import returned after terminal selection");
}
function run(state: RunState, imports: WebAssembly.Imports, context: WorkerBindingsContext) {
  const { request, metrics } = state;
  try {
    start(state, imports, context);
  } catch (error) {
    if (error instanceof RuntimeWorkerSignal) metrics.signal = error.signal;
    if (error instanceof ProcessError) metrics.errno = error.errno;
    if (request.mode === "retained-signal" && error instanceof RuntimeWorkerSignal)
      pause(request, 1, "selected");
    throw error;
  }
}
function executor(state: RunState): WorkerExecutor {
  return {
    instantiate(imports, context) {
      return { exports: { memory: state.memory, _start: () => run(state, imports, context) } };
    },
    beforeFinish() {
      if (!state.request.graphics) throw new Error("Missing graphics connection");
      state.metrics.cleanupRevocation = Atomics.load(
        new Int32Array(state.request.graphics.revocation),
        0,
      );
    },
    run: (_context, exited) => exited ?? 0,
  };
}
async function execute(request: CleanupRequest): Promise<void> {
  const state: RunState = {
    request,
    memory: new WebAssembly.Memory({ initial: 1 }),
    metrics: { entered: 0, returned: 0, signal: 0, errno: 0, cleanupRevocation: -1 },
  };
  const originalWait = RecordRing.prototype.wait;
  RecordRing.prototype.wait = function (seen, timeout, check) {
    pause(request, 0, "waiting");
    return originalWait.call(this, seen, timeout, check);
  };
  try {
    await bootstrap({ ...request, module: graphicsImports() }, executor(state), {
      crossOriginIsolated: true,
      postMessage: (message) => self.postMessage(message),
    });
    self.postMessage({ type: "finished", metrics: state.metrics });
  } finally {
    RecordRing.prototype.wait = originalWait;
  }
}
self.onmessage = ({ data }: MessageEvent<CleanupRequest>) => {
  void execute(data).catch((error: unknown) =>
    self.postMessage({ type: "fixture-error", message: String(error) }),
  );
};
