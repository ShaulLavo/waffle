import { bootstrapGuestWorker, type GuestWorkerRequest } from "../thread/guest-worker.ts";

self.onmessage = ({ data }: MessageEvent<GuestWorkerRequest>) => {
  self.onmessage = null;
  void bootstrapGuestWorker(data, {
    postMessage: (event) => self.postMessage(event),
    addEventListener: (type, listener) => self.addEventListener(type, listener),
    removeEventListener: (type, listener) => self.removeEventListener(type, listener),
  }).catch((error: unknown) => {
    throw error;
  });
};
