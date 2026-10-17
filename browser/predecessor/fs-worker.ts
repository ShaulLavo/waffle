import { installFilesystemWorker, MemoryBackend, PersistentBackend, IndexedDBStorage, OpfsStorage } from "@bun-wasm/runtime/fs";
installFilesystemWorker(self, async options => {
  if (options.persistence === false) return new MemoryBackend();
  let backend: PersistentBackend | undefined;
  const storage = options.storage === "opfs"
    ? await OpfsStorage.open(options.name ?? "bun-wasm-workspace")
    : await IndexedDBStorage.open(options.name ?? "bun-wasm-workspace", { onOwnershipLost() {
      backend?.dispose();
      self.postMessage({ type: "filesystem-ownership-lost" });
      self.close();
    } });
  backend = await PersistentBackend.open(storage);
  return backend;
});
