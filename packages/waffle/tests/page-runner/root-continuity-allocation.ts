import type { RootContinuityRequest, RootContinuityStorage } from "../root-continuity-command.js";
import type { StorageEntry } from "../storage-allocation.js";

export function rootContinuityStorage(
  request: RootContinuityRequest,
  allocate: (entry: StorageEntry) => Promise<void>,
  current: () => boolean,
): RootContinuityStorage {
  const name = `root-continuity-${request.control}-${request.run}`;
  return {
    name: () => name,
    async allocate(entry) {
      if (entry.kind !== "indexeddb" || entry.name !== name)
        throw new Error("Unexpected root continuity database");
      if (!current()) throw new Error("Root continuity allocation document is no longer current");
      await allocate(entry);
      if (!current())
        throw new Error("Root continuity allocation acknowledgement is no longer current");
    },
  };
}
