import type { StorageLockManager } from "../../fs/indexeddb.js";

/** Native stand-ins schedule only the writer claim; the maintenance gate is uncontended. */
export function withUncontendedMaintenance(writer: StorageLockManager): StorageLockManager {
  return {
    query: () => writer.query(),
    request(name, options, callback) {
      if (name.startsWith("bun-wasm:filesystem:indexeddb-maintenance:")) return callback({});
      return writer.request(name, options, callback);
    },
  };
}

export async function settleStorageFixture(): Promise<void> {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}
