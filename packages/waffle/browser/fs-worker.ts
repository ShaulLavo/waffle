import { installFilesystemWorker } from "../fs/service.js";
import { openFilesystemWorkerBackend } from "./filesystem-worker-backend.js";

installFilesystemWorker(self, (options, onStartupStage, signal, onWaiting, callbacks) =>
  openFilesystemWorkerBackend(options, {
    onStartupStage,
    signal,
    onWaiting,
    onState: callbacks?.onState,
    onFatalError: callbacks?.onFatalError,
    onOwnershipLost() {
      if (callbacks?.onOwnershipLost) callbacks.onOwnershipLost();
      else self.postMessage({ type: "filesystem-ownership-lost" });
    },
  }),
);
