import { bootstrap, type RuntimeWorkerRequest } from "../../browser/worker.js";
import {
  assertPipeFilestat,
  pipeReadRights,
  pipeWriteRights,
  type PipeFilestatGuest,
} from "./pipe-filestat-guest.js";

declare const self: {
  onmessage: (event: MessageEvent<RuntimeWorkerRequest>) => void;
  postMessage(message: unknown): void;
};
self.onmessage = ({ data }) => {
  void bootstrap(
    data,
    {
      setup({ fs }) {
        fs.preopen = () => 1;
        fs.retain = () => {};
        fs.release = () => {};
      },
      run({ instance }) {
        const guest = instance.exports as unknown as PipeFilestatGuest;
        assertPipeFilestat(guest, 17, pipeReadRights);
        assertPipeFilestat(guest, 18, pipeWriteRights);
        return 0;
      },
    },
    { crossOriginIsolated: true, postMessage: (message) => self.postMessage(message) },
  );
};
