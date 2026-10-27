import { parentPort, workerData } from "node:worker_threads";
import { DescriptorTable } from "../../core/descriptors.js";
import { MemFS } from "../../fs/memory.js";
import { ProcessABI, ProcessSignalExit } from "../../proc/abi.js";
import { WorkerProcessClient, type WorkerProcessTransport } from "../../proc/worker-client.js";
import { controlLoad } from "../../proc/control.js";
import { SIGNAL_PENDING } from "../../proc/signals.js";

const data: { transport: WorkerProcessTransport; job: number } = workerData;
const descriptors = new DescriptorTable();
const client = new WorkerProcessClient({
  transport: data.transport,
  descriptors,
  codec: {
    export(): never {
      throw new Error("unexpected descriptor");
    },
    import(): never {
      throw new Error("unexpected descriptor");
    },
    discard() {},
  },
  postMessage: (message) => parentPort!.postMessage(message),
});
const memory = new WebAssembly.Memory({ initial: 1 });
const abi = new ProcessABI({
  memory,
  descriptors,
  fs: new MemFS(),
  service: client,
  pid: client.pid,
  signals: client.signals,
  wake: client.wake,
});
try {
  parentPort!.postMessage({ kind: "waiting" });
  const result = abi.imports.wait_job!(data.job, 2, 0);
  const pending = controlLoad(client.signals.signalState, 15) & SIGNAL_PENDING;
  const first = abi.imports.interrupted!();
  const second = abi.imports.interrupted!();
  parentPort!.postMessage({
    kind: "complete",
    result,
    pending,
    first,
    second,
    outcome: Array.from(new Int32Array(memory.buffer, 0, 2)),
  });
} catch (error) {
  if (!(error instanceof ProcessSignalExit)) throw error;
  parentPort!.postMessage({ kind: "fatal", signal: error.signal });
} finally {
  descriptors.dispose();
  parentPort!.close();
}
