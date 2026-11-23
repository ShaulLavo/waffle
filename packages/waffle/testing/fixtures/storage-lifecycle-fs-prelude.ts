import { installStorageLifecycleObserver } from "../storage-lifecycle-observer.js";
import { storageLifecycleMarker } from "../storage-lifecycle-marker.js";
import { IndexedDBStorage } from "../../fs/indexeddb.js";

installStorageLifecycleObserver("filesystem-service");
const close = IndexedDBStorage.prototype.close;
IndexedDBStorage.prototype.close = function () {
  storageLifecycleMarker("storage-close-call", "service-storage");
  const result = close.call(this);
  void result.then(
    () => storageLifecycleMarker("storage-close-fulfilled", "service-storage"),
    () => storageLifecycleMarker("storage-close-rejected", "service-storage"),
  );
  return result;
};
