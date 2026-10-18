import { installFilesystemWorker, MemoryBackend, PersistentBackend, IndexedDBStorage, OpfsStorage } from "../fs/index.js";
installFilesystemWorker(self, async (options, onStartupStage, signal, onWaiting) => {
  if (options.persistence === false) return new MemoryBackend();
  let backend: PersistentBackend | undefined;
  if (options.storage === "opfs" && options.whenBusy === "takeover") throw new TypeError('OPFS storage only supports whenBusy: "wait"');
  const storage = options.storage === "opfs"
    ? await OpfsStorage.open(options.name ?? "waffle-workspace", { onStartupStage, signal, onWaiting })
    : await IndexedDBStorage.open(options.name ?? "waffle-workspace", { onStartupStage, signal, onWaiting, whenBusy: options.whenBusy, onOwnershipLost() {
      backend?.dispose();
      self.postMessage({ type: "filesystem-ownership-lost" });
      self.close();
    } });
  try {
    backend = await PersistentBackend.open(storage);
    return backend;
  } catch (error) {
    await storage.close();
    throw error;
  }
});
