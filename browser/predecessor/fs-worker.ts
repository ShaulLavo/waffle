import { installFilesystemWorker, MemoryBackend, PersistentBackend, IndexedDBStorage } from "@bun-wasm/runtime/fs";
installFilesystemWorker(self, async options => options.persistence === false
  ? new MemoryBackend()
  : PersistentBackend.open(await IndexedDBStorage.open(options.name ?? "bun-wasm-workspace")));
