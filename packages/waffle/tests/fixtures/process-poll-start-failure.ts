import { parentPort, workerData } from "node:worker_threads";
import { DescriptorTable } from "../../core/descriptors.js";
import { MemFS } from "../../fs/memory.js";
import { ProcessABI } from "../../proc/abi.js";
import { controlLoad, controlWait } from "../../proc/control.js";
import {
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessTransport,
} from "../../proc/worker-client.js";

const { transport, childTransport, child, mixed } = workerData as {
  transport: WorkerProcessTransport;
  childTransport: WorkerProcessTransport;
  child: number;
  mixed: boolean;
};
const descriptors = new DescriptorTable();
const unused = (): never => {
  throw new Error("unexpected descriptor operation");
};
const service = new WorkerProcessClient({
  transport,
  descriptors,
  codec: { export: unused, import: unused, discard: unused },
  postMessage: unused,
});
const memory = new WebAssembly.Memory({ initial: 1 });
const waits: number[] = [];
const nativeWaits: string[] = [];
const abi = new ProcessABI({
  memory,
  descriptors,
  fs: new MemFS(),
  pid: service.pid,
  service,
  signals: service.signals,
  wake: service.wake,
  wait(milliseconds, word, expected) {
    if (!waits.length) parentPort!.postMessage({ phase: "waiting" });
    waits.push(milliseconds);
    nativeWaits.push(controlWait(word, 0, expected, milliseconds));
  },
});
const view = new DataView(memory.buffer);
view.setUint32(256, 6, true);
view.setUint32(260, child, true);
view.setUint32(272, 2, true);
view.setUint32(276, child, true);
view.setUint32(288, 4, true);
view.setUint32(292, service.jobOf(child), true);
try {
  const ready = abi.imports.poll!(256, mixed ? 3 : 1, -1, 512);
  parentPort!.postMessage({
    phase: "done",
    ready,
    eventKind: view.getUint32(520, true),
    startup: service.startStatus(service.pid, child),
    confirmed: controlLoad(workerProcessState(childTransport).confirmed),
    exited: service.childExited(service.pid, child),
    waitResult: abi.imports.wait!(child, 1024),
    waits,
    nativeWaits,
  });
} finally {
  descriptors.dispose();
}
