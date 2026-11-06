import { cleanupStorage } from "./storage-cleanup.js";
import { Reporter } from "./reporter.js";
import { withStorageCleanup, type StorageEntry } from "../storage-allocation.js";
declare const PAGE_RUNNER_STORAGE_FAILURE: boolean;
const config = window.__storageConfiguration;
const reporter = new Reporter(config.run);
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
async function allocation(
  entry: StorageEntry,
  worker: Worker,
  ledger: StorageEntry[],
): Promise<void> {
  await reporter.send({ kind: "allocation", entry });
  ledger.push(entry);
  worker.postMessage({ kind: "ack" });
}
function interruptedReply(
  event: MessageEvent,
  worker: Worker,
  ledger: StorageEntry[],
  timer: ReturnType<typeof setTimeout>,
  resolve: () => void,
  reject: (error: unknown) => void,
): void {
  if (event.data.interrupted) {
    clearTimeout(timer);
    worker.terminate();
    resolve();
    return;
  }
  void allocation(event.data.allocation, worker, ledger).catch(reject);
}
async function observeInterrupted(
  worker: Worker,
  name: string,
  ledger: StorageEntry[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Interrupted fixture did not allocate")), 5000);
    worker.onmessage = (event) => interruptedReply(event, worker, ledger, timer, resolve, reject);
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(event.message));
    };
    worker.postMessage({ name });
  });
}
async function interruptedCase(name: string, ledger: StorageEntry[]): Promise<void> {
  const worker = new Worker("/control-worker.js", { type: "module" });
  try {
    await observeInterrupted(worker, name, ledger);
  } finally {
    worker.terminate();
  }
}
async function run(): Promise<void> {
  const caseId = "indexeddb: control";
  await reporter.send({ kind: "hello", token: config.token, group: config.group });
  reporter.startHeartbeat(100);
  await reporter.send({ kind: "case-start", caseId });
  await reporter.send({ kind: "case-start", caseId: "opfs: control" });
  const foreignDatabase = `bun-wasm-storage-test-foreign-${crypto.randomUUID()}`;
  const foreignDirectory = `bun-wasm-foreign-${crypto.randomUUID()}`;
  const root = await navigator.storage.getDirectory();
  const ledger: StorageEntry[] = [];
  await withStorageCleanup(
    async () => {
      await openDatabase(foreignDatabase);
      await root.getDirectoryHandle(foreignDirectory, { create: true });
      await interruptedCase(`bun-wasm-storage-test-${config.run}-interrupted`, ledger);
      const ownDirectory = {
        kind: "opfs-directory",
        name: `bun-wasm-${btoa(JSON.stringify(`bun-wasm-opfs-test-${config.run}-own`))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "")}`,
      } satisfies StorageEntry;
      await reporter.send({ kind: "allocation", entry: ownDirectory });
      ledger.push(ownDirectory);
      await root.getDirectoryHandle(ownDirectory.name, { create: true });
      if (PAGE_RUNNER_STORAGE_FAILURE)
        await reporter.send({
          kind: "case-end",
          caseId,
          status: "fail",
          error: "Injected failure before exact cleanup",
        });
      const remaining = await cleanupStorage(ledger);
      if (remaining.length) throw new Error(`Own storage remains ${JSON.stringify(remaining)}`);
      if (!(await indexedDB.databases()).some((db) => db.name === foreignDatabase))
        throw new Error("Foreign prefix database deleted");
      await root.getDirectoryHandle(foreignDirectory);
      if (!ledger.some((entry) => entry.name.endsWith("-1")))
        throw new Error("Derived interrupted allocation absent from ledger");
      if (!PAGE_RUNNER_STORAGE_FAILURE)
        await reporter.send({ kind: "case-end", caseId, status: "pass" });
      await reporter.send({ kind: "case-end", caseId: "opfs: control", status: "pass" });
    },
    async () => {
      const remaining = await cleanupStorage(
        ledger.concat([
          { kind: "indexeddb", name: foreignDatabase },
          { kind: "opfs-directory", name: foreignDirectory },
        ]),
      );
      if (remaining.length)
        throw new Error(`Control teardown retained ${JSON.stringify(remaining)}`);
    },
  );
  await reporter.send({ kind: "doc-complete" });
  await reporter.readyForRetirement();
}
void run().catch((error: unknown) => {
  void reporter.send({ kind: "error", message: String(error) }).catch(() => {});
});
