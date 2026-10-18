import { installFilesystemWorker, MemoryBackend, PersistentBackend, IndexedDBStorage, OpfsStorage } from "../fs/index.js";
installFilesystemWorker(self, async (options, onStartupStage) => {
  if (options.persistence === false) return new MemoryBackend();
  let backend: PersistentBackend | undefined;
  const storage = options.storage === "opfs"
    ? await OpfsStorage.open(options.name ?? "waffle-workspace", { onStartupStage })
    : await IndexedDBStorage.open(options.name ?? "waffle-workspace", { onStartupStage, onOwnershipLost() {
      backend?.dispose();
      self.postMessage({ type: "filesystem-ownership-lost" });
      self.close();
    } });
  backend = await PersistentBackend.open(storage);
  return backend;
});
