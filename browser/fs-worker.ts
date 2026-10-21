import { installFilesystemWorker } from "../fs/index.js";
import type { StorageBackend } from "../fs/storage.js";
import { openFilesystemBackend } from "./filesystem-backend.js";

installFilesystemWorker(self, async (options, onStartupStage, signal, onWaiting) => {
  let storage: StorageBackend | undefined;
  try {
    return await openFilesystemBackend(options, {
      onStartupStage,
      signal,
      onWaiting,
      retainStorage(value) {
        storage = value;
      },
      onOwnershipLost() {
        self.postMessage({ type: "filesystem-ownership-lost" });
      },
    });
  } catch (error) {
    await storage?.close();
    throw error;
  }
});
