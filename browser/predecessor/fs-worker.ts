import { installFilesystemWorker, MemoryBackend, PersistentBackend, IndexedDBStorage, OpfsStorage } from "@bun-wasm/runtime/fs";
installFilesystemWorker(self, async options => options.persistence === false
  ? new MemoryBackend()
  : PersistentBackend.open(await (options.storage === "opfs" ? OpfsStorage.open(options.name ?? "bun-wasm-workspace") : IndexedDBStorage.open(options.name ?? "bun-wasm-workspace"))));
