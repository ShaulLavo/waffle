import { gatedIndexedDB } from "./gated-indexeddb.js";

const gate = gatedIndexedDB(
  indexedDB,
  () => postMessage({ type: "probe-open-pending" }),
  () => postMessage({ type: "probe-late-database-closed" }),
);
void gate.ready.catch((error) => postMessage({ type: "probe-open-error", message: String(error) }));
Object.defineProperty(globalThis, "indexedDB", { value: gate.factory });
await import("../browser/fs-worker.js");
const receive = self.onmessage!;
self.onmessage = (event) => {
  if (event.data?.probeReleaseOpen) {
    gate.release();
    return;
  }
  receive.call(self, event);
};
