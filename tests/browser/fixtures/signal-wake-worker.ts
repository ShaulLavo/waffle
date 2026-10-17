import { parentPort, workerData } from "node:worker_threads";
import { DescriptorTable } from "../../../runtime/core/descriptors";
import { MemFS } from "../../../runtime/fs/memory";
import { ProcessABI } from "../../../runtime/proc/abi";
import type { SignalTransport } from "../../../runtime/proc/signals";
import { SubprocessHost } from "../../src/subprocess";

const { mode, budget, signals, wake } = workerData as {
  mode: "legacy" | "generic-host" | "generic-poll"; budget: SharedArrayBuffer; signals: SignalTransport; wake: Int32Array;
};
const descriptors = new DescriptorTable();
const unused = (): never => { throw new Error("unexpected service operation"); };
const host = new SubprocessHost({ budget, signalState: signals.signalState, interrupt: signals.interrupt,
  outcome: signals.outcome, output() {}, launch: unused });
const abi = new ProcessABI({ memory: new WebAssembly.Memory({ initial: 1 }), descriptors, fs: new MemFS(), pid: 1, signals, wake,
  service: { spawn: unused, wait: unused, kill: unused, killJob: unused, jobOf: unused, defaultSignal: unused } });
const selected = mode === "generic-poll" ? wake : new Int32Array(budget, 4, 1);
const nativeWait = Atomics.wait;
let generation = 0;
let result: string | undefined;
Atomics.wait = ((word: Int32Array, index: number, expected: number, milliseconds?: number) => {
  if (word.buffer !== selected.buffer || word.byteOffset + index * 4 !== selected.byteOffset) {
    throw new Error("production poll selected a different wait word");
  }
  generation++;
  parentPort!.postMessage({ phase: "waiting", generation });
  result = nativeWait(word, index, expected, 1000);
  return result;
}) as typeof Atomics.wait;
try {
  if (mode === "generic-poll") abi.imports.poll!(0, 0, -1, 0);
  else host.poll(-1);
  parentPort!.postMessage({ phase: "done", generation, result, pending: Atomics.load(signals.signalState, 2),
    interrupt: Atomics.load(signals.interrupt, 0), sequence: Atomics.load(selected, 0) });
} finally { Atomics.wait = nativeWait; host.dispose(); descriptors.dispose(); parentPort!.close(); }
