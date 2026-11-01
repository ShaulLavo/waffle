import {
  bootstrapGuestWorker,
  type GuestWorkerRequest,
  type GuestWorkerEvent,
} from "../thread/guest-worker.ts";

export interface GuestFixtureRequest extends GuestWorkerRequest {
  poison: boolean;
}
export type GuestFixtureEvent = GuestWorkerEvent | { kind: "poison-armed" };
function poisonNatives(): void {
  const denied = () => {
    throw new Error("guest-mutable native observed private state");
  };
  Atomics.load = denied;
  Atomics.store = denied;
  Atomics.wait = denied;
  Atomics.notify = denied;
  MessagePort.prototype.postMessage = denied;
  MessagePort.prototype.close = denied;
  DataView.prototype.setUint32 = denied;
  DataView.prototype.setBigUint64 = denied;
  DataView.prototype.getUint32 = denied;
  DataView.prototype.getBigUint64 = denied;
  Object.defineProperty(WebAssembly.Memory.prototype, "buffer", {
    get: denied,
    configurable: true,
  });
  let armed = false;
  try {
    Atomics.load(new Int32Array(new SharedArrayBuffer(4)), 0);
  } catch {
    armed = true;
  }
  if (!armed) throw new Error("native observer did not arm");
  self.postMessage({ kind: "poison-armed" } satisfies GuestFixtureEvent);
}
self.onmessage = ({ data }: MessageEvent<GuestFixtureRequest>) => {
  self.onmessage = null;
  void bootstrapGuestWorker(data, {
    postMessage(event) {
      if (event.kind === "ready" && data.poison) poisonNatives();
      self.postMessage(event);
    },
    addEventListener: (type, listener) => self.addEventListener(type, listener),
    removeEventListener: (type, listener) => self.removeEventListener(type, listener),
  }).catch((error) => {
    throw error;
  });
};
