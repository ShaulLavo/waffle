import { storageTests } from "../storage-browser.js";
import type { StorageEntry } from "../storage-allocation.js";
async function openDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}
self.onmessage = async (event: MessageEvent<{ name: string }>) => {
  const name = event.data.name;
  if (typeof name !== "string") return;
  const hooks = {
    name: () => name,
    async allocate(entry: StorageEntry) {
      globalThis.postMessage({ allocation: entry });
      await new Promise<void>((resolve) =>
        globalThis.addEventListener("message", () => resolve(), { once: true }),
      );
      if (!entry.name.endsWith("-1")) return;
      await openDatabase(entry.name);
      globalThis.postMessage({ interrupted: entry.name });
      await new Promise(() => {});
    },
  };
  const fixture = storageTests("/fs-worker.js", "/open-fs-worker.js", hooks).find(
    (test) =>
      test.label ===
      "epoch fencing rejects a stale writer before payload, journal and compaction writes",
  );
  if (!fixture) throw new Error("Missing actual epoch-fencing factory case");
  await fixture.run();
};
