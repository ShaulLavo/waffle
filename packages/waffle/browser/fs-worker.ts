import { installFilesystemWorker } from "../fs/index.js";
import { openFilesystemWorkerBackend } from "./filesystem-worker-backend.js";

installFilesystemWorker(self, (options, onStartupStage, signal, onWaiting) =>
  openFilesystemWorkerBackend(options, {
    onStartupStage,
    signal,
    onWaiting,
    onOwnershipLost() {
      self.postMessage({ type: "filesystem-ownership-lost" });
    },
  }),
);
