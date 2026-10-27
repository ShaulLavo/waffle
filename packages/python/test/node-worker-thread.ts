import { parentPort, workerData, MessagePort } from "node:worker_threads";
import { installNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
if (!parentPort) throw new Error("Worker thread has no parent port");
const port = parentPort;
const events = new EventTarget();
installNodeWorkers();
Object.defineProperties(globalThis, {
  self: { value: globalThis, configurable: true },
  postMessage: {
    value: (data: unknown, transfer: readonly Transferable[] = []) =>
      port.postMessage(
        data,
        transfer.filter(
          (value): value is ArrayBuffer | MessagePort =>
            value instanceof ArrayBuffer || value instanceof MessagePort,
        ),
      ),
    configurable: true,
  },
  addEventListener: { value: events.addEventListener.bind(events), configurable: true },
  removeEventListener: { value: events.removeEventListener.bind(events), configurable: true },
});
let ready = false;
const queued: unknown[] = [];
function dispatch(data: unknown) {
  const event = new MessageEvent("message", { data });
  const listener: unknown = Reflect.get(globalThis, "onmessage");
  if (typeof listener === "function") listener.call(globalThis, event);
  events.dispatchEvent(event);
}
port.on("message", (data) => {
  if (ready) dispatch(data);
  else queued.push(data);
});
await import(workerData.entry);
ready = true;
for (const data of queued) dispatch(data);
port.on("close", () => {
  void stopNodeWorkers();
});
