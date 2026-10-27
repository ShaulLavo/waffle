import { indexedDBCrashMatrix } from "./storage-crash-r2-indexeddb.js";
import { opfsCrashMatrix } from "./storage-crash-r2-opfs.js";

/** @browserEntry */
export async function crashMatrix() {
  return { indexeddb: await indexedDBCrashMatrix(), opfs: await opfsCrashMatrix() };
}
