import { PersistentBackend } from "../fs/persistent.js";

// Gate only recovery. Storage still opens through the real production worker,
// allocating its real IndexedDB epoch and holding the actual workspace Web Lock.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => unknown) | null;
  postMessage(message: unknown): void;
};
let release!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
const open = PersistentBackend.open;
PersistentBackend.open = async (...args: Parameters<typeof PersistentBackend.open>) => {
  scope.postMessage({ type: "probe-recovery" });
  await gate;
  return open.apply(PersistentBackend, args);
};

await import("../browser/fs-worker.js");
const receive = scope.onmessage;
if (!receive) throw new Error("Production filesystem worker did not install a message handler");
scope.onmessage = event => {
  if (event.data?.probeReleaseRecovery === true) {
    release();
    scope.postMessage({ type: "probe-recovery-released" });
    return;
  }
  const result = receive.call(globalThis, event);
  // Emit only after the production dispose handler has synchronously received
  // the request and aborted startup. This is a barrier, not an inferred delay.
  if (event.data?.dispose === true) scope.postMessage({ type: "probe-dispose-received" });
  return result;
};
