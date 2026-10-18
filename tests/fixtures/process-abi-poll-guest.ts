import { controlLoad } from "../../proc/control.js";
import { parentPort, workerData } from "node:worker_threads";
import { ProcessABI, type ProcessService } from "../../proc/abi.js";
import { readOutcome } from "../../proc/outcome.js";
import type { SignalTransport } from "../../proc/signals.js";
import { DescriptorTable } from "../../core/descriptors.js";
import { controlWait } from "../../proc/control.js";
import { MemFS } from "../../fs/memory.js";

const { mode, pid, child, childOutcome, wake, signals } = workerData as {
  mode: "signal" | "child";
  pid: number;
  child: number;
  childOutcome: BigInt64Array;
  wake: Int32Array;
  signals: SignalTransport;
};
const descriptors = new DescriptorTable();
const memory = new WebAssembly.Memory({ initial: 1 });
const unused = (): never => {
  throw new Error("unexpected process service operation");
};
// The parent's real local supervisor publishes this outcome without notifying the pipe wake.
const service: ProcessService = {
  spawn: unused,
  startStatus: unused,
  waitJob: unused,
  jobEmpty: unused,
  wait: () => readOutcome(childOutcome),
  childExited: () => readOutcome(childOutcome) !== null,
  kill: unused,
  killJob: unused,
  jobOf: unused,
  defaultSignal: unused,
};
const abi = new ProcessABI({
  memory,
  descriptors,
  fs: new MemFS(),
  pid,
  service,
  signals,
  wake,
  wait(milliseconds, word, expected) {
    // Observe the supported parking boundary instead of replacing Atomics after
    // Waffle has captured it. Keep the real native wait and its supplied deadline.
    parentPort!.postMessage({ phase: "waiting" });
    controlWait(word, 0, expected, milliseconds);
  },
});
const view = new DataView(memory.buffer);
const fd = descriptors.open(
  {
    kind: "pipe",
    notification: wake,
    read: unused,
    write: unused,
    readiness: () => ({ readable: false, writable: false, hangup: false }),
  },
  (1n << 29n) - 1n,
  0n,
);
view.setUint32(256, mode === "child" ? 2 : 0, true);
view.setUint32(260, mode === "child" ? child : fd, true);
view.setBigUint64(264, 77n, true);
try {
  const ready = abi.imports.poll!(256, 1, -1, 512);
  parentPort!.postMessage({
    phase: "done",
    ready,
    interrupt: controlLoad(signals.interrupt, 0),
    code: mode === "child" ? readOutcome(childOutcome)!.code : 0,
  });
} finally {
  descriptors.dispose();
}
