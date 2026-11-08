import { cleanupServiceWorker } from "./service-worker-page.js";
import type { StorageEntry } from "../storage-allocation.js";
async function deleteDatabase(name: string, timeout: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    const timer = setTimeout(() => reject(new Error(`Database delete blocked: ${name}`)), timeout);
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
    // A blocked request may still finish when its consumer exits. Do not reopen it.
  });
  if ((await indexedDB.databases()).some((database) => database.name === name))
    throw new Error(`Database remains: ${name}`);
}
async function deleteDirectory(name: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(name, { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  }
  try {
    await root.getDirectoryHandle(name);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw error;
  }
  throw new Error(`OPFS directory remains: ${name}`);
}
export async function cleanupStorage(
  entries: readonly StorageEntry[],
  timeout = 8000,
): Promise<StorageEntry[]> {
  const remaining: StorageEntry[] = [];
  const deadline = performance.now() + timeout;
  for (const entry of entries) {
    const available = deadline - performance.now();
    if (available <= 0) {
      remaining.push(entry);
      continue;
    }
    try {
      await boundedDelete(entry, Math.min(2000, available));
    } catch {
      remaining.push(entry);
    }
  }
  return remaining;
}
async function boundedDelete(entry: StorageEntry, timeout: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = deleteEntry(entry, timeout);
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Storage cleanup timeout")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function deleteEntry(entry: StorageEntry, timeout: number): Promise<void> {
  switch (entry.kind) {
    case "indexeddb": return deleteDatabase(entry.name, timeout);
    case "opfs-directory": return deleteDirectory(entry.name);
    case "service-worker": return cleanupServiceWorker(entry);
    default: { const exhaustive: never = entry; return exhaustive; }
  }
}
