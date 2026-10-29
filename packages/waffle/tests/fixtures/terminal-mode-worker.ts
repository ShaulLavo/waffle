import { parentPort, workerData } from "node:worker_threads";
import type { TerminalContext } from "../../browser/runtime-terminals.js";
import type { WorkerProcessTransport } from "../../proc/worker-client.js";

// A foreground job that restores cooked mode the way Bun's setRawMode(false) does:
// snapshot the selection, then setMode with that expected selection.
export interface TerminalModeWorkerData {
  process: WorkerProcessTransport;
  context: TerminalContext;
  input: SharedArrayBuffer;
}
const data: TerminalModeWorkerData = workerData;
if (!parentPort) throw Error("missing host port");
const port = parentPort;
const { attachTerminal, createTerminalInputPolicy, terminalControls } =
  await import("../../browser/runtime-terminals.js");
const attachment = attachTerminal({
  context: data.context,
  process: data.process,
  checkActive() {},
  policy: createTerminalInputPolicy({ input: data.input }),
});
const ready = attachment.ready();
const controls = terminalControls(attachment.resolve(0))!;
port.on("message", (message: { kind: "restore" } | { kind: "exit" }) => {
  if (message.kind === "exit") {
    attachment.dispose();
    port.close();
    return;
  }
  const snapshot = controls.snapshot();
  if (snapshot.kind === "error") {
    port.postMessage({ kind: "restored", step: "snapshot", code: snapshot.code });
    return;
  }
  const changed = controls.setMode({ expected: snapshot.value.selection, mode: "cooked" });
  port.postMessage({
    kind: "restored",
    step: "setMode",
    code: changed.kind === "error" ? changed.code : "ok",
  });
});
port.postMessage({ kind: "ready", result: ready.kind === "ok" ? "ok" : ready.code });
