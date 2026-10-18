import {
  installFilesystemWorker,
  MemoryBackend,
  PersistentBackend,
  IndexedDBStorage,
  OpfsStorage,
} from "../fs/index.js";
import { resolveVfs, requireVfsCapabilities } from "../fs/vfs.js";
installFilesystemWorker(self, async (options, onStartupStage, signal, onWaiting) => {
  const { descriptor, whenBusy } = resolveVfs(options);
  requireVfsCapabilities(descriptor.id);
  if (descriptor.id === "memory") return new MemoryBackend();
  let backend: PersistentBackend | undefined;
  let ownershipLost = false;
  const storage =
    descriptor.id === "opfs-memory"
      ? await OpfsStorage.open(options.name ?? "waffle-workspace", {
          onStartupStage,
          signal,
          onWaiting,
        })
      : await IndexedDBStorage.open(options.name ?? "waffle-workspace", {
          onStartupStage,
          signal,
          onWaiting,
          whenBusy,
          onOwnershipLost() {
            ownershipLost = true;
            backend?.dispose();
            self.postMessage({ type: "filesystem-ownership-lost" });
            // The page owns worker termination. During startup disposal it retains this
            // worker until recovery settles and the acquired backend has acknowledged cleanup.
          },
        });
  try {
    backend = await PersistentBackend.open(storage);
    // Recovery can finish after ownership loss, before the page handles its message.
    // Never publish that late backend or connect the queued guest requests to it.
    if (ownershipLost) {
      backend.dispose();
      throw new Error("Filesystem ownership was lost during recovery");
    }
    return backend;
  } catch (error) {
    await storage.close();
    throw error;
  }
});
