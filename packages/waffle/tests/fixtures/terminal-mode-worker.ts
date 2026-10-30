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
export type TerminalModeRequest =
  | { readonly kind: "restore"; readonly takeSignal?: boolean }
  | { readonly kind: "exit" };
export interface TerminalModeReply {
  readonly kind: "restored";
  readonly step: "snapshot" | "setMode";
  readonly code: string;
  readonly pending: boolean;
}
const data: TerminalModeWorkerData = workerData;
if (!parentPort) throw Error("missing host port");
const port = parentPort;
const { attachTerminal, createTerminalInputPolicy, terminalControls } =
  await import("../../browser/runtime-terminals.js");
const { workerProcessState } = await import("../../proc/worker-client.js");
const { signalPending, takeSignal } = await import("../../proc/signals.js");
const signals = workerProcessState(data.process).signals;
const attachment = attachTerminal({
  context: data.context,
  process: data.process,
  checkActive() {},
  policy: createTerminalInputPolicy({ input: data.input }),
});
const ready = attachment.ready();
const controls = terminalControls(attachment.resolve(0))!;
function restore(): Omit<TerminalModeReply, "pending"> {
  const snapshot = controls.snapshot();
  if (snapshot.kind === "error") return { kind: "restored", step: "snapshot", code: snapshot.code };
  const changed = controls.setMode({ expected: snapshot.value.selection, mode: "cooked" });
  return {
    kind: "restored",
    step: "setMode",
    code: changed.kind === "error" ? changed.code : "ok",
  };
}
port.on("message", (message: TerminalModeRequest) => {
  if (message.kind === "exit") {
    attachment.dispose();
    port.close();
    return;
  }
  // Dispatching a handler clears its pending bit first, as the guest ABI does.
  if (message.takeSignal) takeSignal(signals.signalState, signals.interrupt);
  const reply: TerminalModeReply = { ...restore(), pending: signalPending(signals) };
  port.postMessage(reply);
});
port.postMessage({ kind: "ready", result: ready.kind === "ok" ? "ok" : ready.code });
