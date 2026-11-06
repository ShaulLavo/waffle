import { bootstrapGuestWorker, type GuestWorkerRequest } from "../thread/guest-worker.js";

self.onmessage = ({ data }: MessageEvent<GuestWorkerRequest>) => {
  self.onmessage = null;
  void bootstrapGuestWorker(data, {
    postMessage: (event) =>
      self.postMessage({
        ...event,
        observedGuestBytes: data.memory.buffer.byteLength,
      }),
    addEventListener: (type, listener) => self.addEventListener(type, listener),
    removeEventListener: (type, listener) => self.removeEventListener(type, listener),
  });
};
