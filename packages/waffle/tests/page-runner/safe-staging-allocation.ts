import type { StagingDatabaseName } from "../indexeddb-checkpoint-decode-browser.js";
import type { StorageEntry } from "../storage-allocation.js";

export const stagingPrefixes = ["waffle-staged-test", "checkpoint-decoder-r30"] as const;
export function stagingDatabaseName(
  run: string,
  allocate: (entry: StorageEntry) => Promise<void>,
  current: () => boolean,
): StagingDatabaseName {
  return async (prefix) => {
    if (!stagingPrefixes.some((allowed) => allowed === prefix))
      throw new Error(`Unknown staging database prefix ${prefix}`);
    if (!current()) throw new Error("Staging allocation document is no longer current");
    const name = `${prefix}-${run}-${crypto.randomUUID()}`;
    await allocate({ kind: "indexeddb", name });
    if (!current()) throw new Error("Staging allocation acknowledgement is no longer current");
    return name;
  };
}
