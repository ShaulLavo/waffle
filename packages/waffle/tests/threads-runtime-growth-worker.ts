import {
  bootstrapGuestWorker,
  type GuestWorkerEvent,
  type GuestWorkerRequest,
} from "../thread/guest-worker.js";

type WasmBufferConversion = { toResizableBuffer?(): unknown };

function resizableView(
  memory: WebAssembly.Memory & WasmBufferConversion,
): { kind: "supported"; view: Uint8Array } | { kind: "missing" | "rejected" } {
  if (typeof memory.toResizableBuffer !== "function") return { kind: "missing" };
  let buffer: unknown;
  try {
    const clone: WasmBufferConversion = structuredClone(memory);
    if (!clone.toResizableBuffer) return { kind: "missing" };
    buffer = clone.toResizableBuffer();
  } catch {
    return { kind: "rejected" };
  }
  if (!(buffer instanceof SharedArrayBuffer) || !buffer.growable)
    throw new Error("shared Wasm conversion did not return a growable SAB");
  return { kind: "supported", view: new Uint8Array(buffer) };
}

export interface GrowthObservation {
  kind: "growth-observed";
  phase: "received" | "instantiated" | "returned";
  fixed: number;
  refreshed: number;
  resizable: number | "missing" | "rejected";
}

self.onmessage = ({ data }: MessageEvent<GuestWorkerRequest>) => {
  self.onmessage = null;
  const { memory, entry } = data;
  if (entry.kind !== "secondary" || entry.startArg !== 2) {
    void bootstrapGuestWorker(data, self);
    return;
  }
  const kept = new Uint8Array(memory.buffer);
  const resizable = resizableView(memory);
  const observe = (phase: GrowthObservation["phase"]) =>
    self.postMessage({
      kind: "growth-observed",
      phase,
      fixed: kept.byteLength,
      refreshed: memory.buffer.byteLength,
      resizable: resizable.kind === "supported" ? resizable.view.byteLength : resizable.kind,
    } satisfies GrowthObservation);
  observe("received");
  void bootstrapGuestWorker(data, {
    addEventListener: self.addEventListener.bind(self),
    removeEventListener: self.removeEventListener.bind(self),
    postMessage(event: GuestWorkerEvent) {
      if (event.kind === "ready") observe("instantiated");
      if (event.kind === "thread-returned") observe("returned");
      self.postMessage(event);
    },
  });
};
