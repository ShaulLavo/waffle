import { bootstrapGuestWorker, type GuestWorkerRequest } from "../thread/guest-worker.ts";
self.onmessage = ({ data }: MessageEvent<GuestWorkerRequest>) => {
  self.onmessage = null;
  void bootstrapGuestWorker(data, self).catch((error) => {
    throw error;
  });
};
