import {
  bootstrapGuestWorker,
  type GuestWorkerRequest,
  type GuestWorkerHost,
} from "./guest-worker.js";
const host = globalThis as unknown as GuestWorkerHost & {
  onmessage: ((event: MessageEvent<GuestWorkerRequest>) => void) | null;
};
host.onmessage = ({ data }) => {
  host.onmessage = null;
  void bootstrapGuestWorker(data, host);
};
