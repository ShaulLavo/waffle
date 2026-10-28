import { parentPort, workerData } from "node:worker_threads";
import { pauseInputAcquisition } from "./terminal-input-pause.js";

const data: { input: SharedArrayBuffer; flags: SharedArrayBuffer } = workerData;
if (!parentPort) throw Error("missing host port");
const port = parentPort;
const flags = new Int32Array(data.flags);
pauseInputAcquisition(data.input, () => {
  port.postMessage("held");
  Atomics.wait(flags, 1, 0);
});
const { attachTerminalInput } = await import("../../browser/terminal-input.js");
const input = attachTerminalInput(data.input);
port.on("message", () => {
  const count = input.push(Uint8Array.of(66));
  port.postMessage({ kind: "released", count });
});
port.postMessage("ready");
