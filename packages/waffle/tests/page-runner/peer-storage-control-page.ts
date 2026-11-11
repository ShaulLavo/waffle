import { startPage } from "./page-main.js";
import { cleanupStorage } from "./storage-cleanup.js";
import { storageLockCases } from "../storage-lock-cases.js";
import type { StorageLockRequest } from "../storage-lock-host.js";
import { record } from "./protocol.js";

declare const PEER_STORAGE_INTERRUPTED: boolean;
const selected = storageLockCases.filter(
  (item) => item.ordinal === 1 || (!PEER_STORAGE_INTERRUPTED && item.ordinal === 7),
);
const original = globalThis.fetch.bind(globalThis);
Reflect.set(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await original(input, init);
  const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  if (!record(body) || body.kind !== "allocation") return response;
  Reflect.set(window, "__allocationAccepted", true);
  const path = "/fixture.js";
  const fixture: typeof import("../storage-lock-browser.js") = await import(path);
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (fixture.lockTest.constructions() !== 0 || fixture.lockTest.probes().length !== 0)
    throw new Error("Storage opened before actual allocation ACK");
  return response;
});
startPage<StorageLockRequest>({
  list: async () => selected.map((item) => item.id),
  run: {
    kind: "host",
    peer: async (request, allocate) => {
      const path = "/fixture.js";
      const fixture: typeof import("../storage-lock-browser.js") = await import(path);
      fixture.lockTest.configure({ name: () => request.name, allocate });
    },
    teardown: async () => true,
  },
  finish: async (ledger) => {
    const remaining = await cleanupStorage(ledger);
    const run = window.__suiteConfiguration.run;
    const foreign = `peer-foreign-${run}`;
    if (!(await indexedDB.databases()).some((entry) => entry.name === foreign))
      throw new Error("Unrelated database deleted");
    const root = await navigator.storage.getDirectory();
    await root.getDirectoryHandle(foreign);
    await root.removeEntry(foreign, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(foreign);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    return remaining;
  },
});
