import { parentPort, workerData } from "node:worker_threads";
import { createSupervisedWaitImports } from "../../interrupt/wait.js";
import { terminalInterrupt } from "../../interrupt/check.js";
import { claimOutcome, type OutcomeWord } from "../../proc/outcome.js";

export interface WaitWorkerInput {
  bytes: Uint8Array<ArrayBuffer>;
  memory: WebAssembly.Memory;
  registration: Int32Array;
  outcome: OutcomeWord;
  gate: Int32Array;
  address: number;
  expected: number | bigint;
  timeout: bigint;
  entry: string;
  race?: "before-native" | "after-native";
  poison?: boolean;
}
const input: WaitWorkerInput = workerData;
const port = parentPort;
if (!port) throw new Error("missing owned parent port");
let checks = 0;
const terminal = () => {
  checks++;
  if (input.race === "after-native" && checks === 2)
    claimOutcome(input.outcome, { kind: "exited", code: 0 });
  if (input.race !== "before-native" || checks !== 1) return terminalInterrupt(input.outcome);
  Atomics.store(input.gate, 0, 1);
  Atomics.notify(input.gate, 0);
  Atomics.wait(input.gate, 1, 0);
  return 0;
};
const imports = createSupervisedWaitImports(input.memory, input.registration, terminal);
const load = Atomics.load,
  store = Atomics.store,
  wait = Atomics.wait;
try {
  if (input.poison) {
    const denied = () => {
      throw new Error("guest replaced native atomic");
    };
    Atomics.load = denied;
    Atomics.store = denied;
    Atomics.wait = denied;
  }
  const instance = new WebAssembly.Instance(new WebAssembly.Module(input.bytes), {
    env: { memory: input.memory, value: () => 17 },
    runtime_proc: { __waffle_fatal: () => terminalInterrupt(input.outcome), ...imports },
  });
  const run = instance.exports[input.entry];
  if (typeof run !== "function") throw new Error("missing test entry");
  const result = run(input.address, input.expected, input.timeout);
  port.postMessage({ kind: "returned", result, checks });
} catch (error) {
  port.postMessage({ kind: "trapped", native: error instanceof WebAssembly.RuntimeError, checks });
} finally {
  Atomics.load = load;
  Atomics.store = store;
  Atomics.wait = wait;
  port.close();
}
