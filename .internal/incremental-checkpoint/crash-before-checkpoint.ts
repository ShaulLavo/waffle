import { IndexedDBStorage } from "../fs/indexeddb.js";
import { PersistentBackend } from "../fs/persistent.js";
import { WORKSPACE } from "../fs/checkpoint-map.js";

globalThis.onmessage = async () => {
  const storage = await IndexedDBStorage.open(WORKSPACE);
  const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
  backend.execute("writeFile", ["/file"], new Uint8Array([1]));
  await backend.flush();
  backend.execute("writeFile", ["/file"], new Uint8Array([2]));
  const parked = Promise.withResolvers<"commit">();
  storage.experimentBeforeTransaction = (receipt) => {
    globalThis.postMessage(receipt);
    return parked.promise;
  };
  await backend.flush();
};
