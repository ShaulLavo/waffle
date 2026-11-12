import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { IndexedDBStorage } from "../../fs/indexeddb.js";
import { indexeddbCallerDelivery } from "./indexeddb-caller-delivery.js";

const mode = process.argv[2];
assert.ok(mode === "loss" || mode === "versionchange");
const confirmation = new Error("background confirmation");
const native = indexeddbCallerDelivery({ queryFailure: { value: confirmation } });
const unhandled: unknown[] = [];
const record = (reason: unknown): void => {
  unhandled.push(reason);
};
process.on("unhandledRejection", record);
const storage = await IndexedDBStorage.open("background-confirmation", { locks: native.locks });
try {
  if (mode === "loss") native.loss.reject(new DOMException("stolen", "AbortError"));
  else native.database.onversionchange?.();
  await native.querySeen.promise;
  await setImmediate();
  if (mode === "loss") await assert.rejects(storage.flush(), /opened in another tab/);
  const closing = storage.close();
  assert.equal(storage.close(), closing);
  await assert.rejects(closing, (error) => error === confirmation);
  await setImmediate();
  assert.deepEqual(unhandled, []);
  assert.equal(native.queries, 1);
  console.log(JSON.stringify({ mode, unhandled: 0, confirmationRetained: true, queries: 1 }));
} finally {
  await storage.close().catch(() => {});
  process.removeListener("unhandledRejection", record);
  native.restore();
}
