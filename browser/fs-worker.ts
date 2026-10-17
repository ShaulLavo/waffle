import { installFilesystemWorker, MemoryBackend, PersistentBackend, IndexedDBStorage, OpfsStorage } from "../fs/index";
installFilesystemWorker(self, async options => options.persistence === false
  ? new MemoryBackend()
  : PersistentBackend.open(await (options.storage === "opfs" ? OpfsStorage.open(options.name ?? "waffle-workspace") : IndexedDBStorage.open(options.name ?? "waffle-workspace"))));
