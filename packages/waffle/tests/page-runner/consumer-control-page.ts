import {
  cleanupStorage,
  isHostedPage,
  startPage,
  type PageSuite,
  type StorageEntry,
} from "waffle/testing/page-runner/page";

declare const CONSUMER_CONTROL: string;
type Request = { databaseName: string; encoded: string };
declare global {
  interface Window {
    __consumerBodyCalls: number;
    __consumerDesktopResult?: unknown;
    __consumerForeignVerified: boolean;
    __consumerOpened: number;
  }
}
window.__consumerBodyCalls = 0;
window.__consumerOpened = 0;
window.__consumerForeignVerified = false;
const labels = ["chunk", "worker", "finally"];
async function openOwned(name: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  window.__consumerOpened++;
  db.close();
}
async function verifySentinel(): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("waffle-workspace");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const actual = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction("fixture").objectStore("fixture").get("sentinel");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (actual !== "W1-foreign-sentinel") throw new Error("Foreign database value changed");
    window.__consumerForeignVerified = true;
  } finally {
    db.close();
  }
}
async function workerMarker(): Promise<string> {
  const worker = new Worker("/current/consumer-control-worker.js", { type: "module" });
  try {
    return await new Promise<string>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<string>) => resolve(event.data);
      worker.onerror = () => reject(new Error("Sibling worker failed"));
      worker.postMessage(true);
    });
  } finally {
    worker.terminate();
  }
}
async function assets(): Promise<void> {
  const chunk = await import("./consumer-control-chunk.js");
  if ((await workerMarker()) !== chunk.chunkMarker)
    throw new Error("Worker or chunk bytes changed");
  const mirrorPath = "/current/__bunwasm/mirror.js";
  const mirror: unknown = await import(mirrorPath);
  if (
    !mirror ||
    typeof mirror !== "object" ||
    !("marker" in mirror) ||
    mirror.marker !== "mirrored"
  )
    throw new Error("Mirrored dependency failed");
}
function value(mode: string, settled: boolean): unknown {
  const result = { ok: true, checks: labels, errors: [], settled };
  if (mode === "null") return null;
  if (mode === "missing") return undefined;
  if (mode === "oversize") return { ...result, text: "界".repeat(17_000) };
  if (mode === "wrong-label") return { ...result, checks: ["chunk", "worker", "wrong"] };
  if (mode === "duplicate") return { ...result, checks: ["chunk", "chunk", "finally"] };
  if (mode === "reordered") return { ...result, checks: labels.toReversed() };
  if (mode === "missing-errors") return { ok: true, checks: labels, settled };
  if (mode === "errors") return { ...result, errors: ["original pageerror.message"] };
  if (mode === "partial") return { ...result, ok: false, checks: ["chunk"], currentTest: "worker" };
  return result;
}
async function finalizer(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (CONSUMER_CONTROL === "cleanup-fail") throw new Error("SETTLED_FINALLY_FAILURE");
}
async function envelope(
  request: Request,
  allocate: (entry: StorageEntry) => Promise<void>,
): Promise<unknown> {
  window.__consumerBodyCalls++;
  if (request.encoded !== '</script><script>throw "unsafe"</script>')
    throw new Error("Unsafe configuration encoding");
  const beforeAllocation = window.__pageRunner?.ackedThrough ?? -1;
  await allocate({
    kind: "indexeddb",
    name: CONSUMER_CONTROL === "wrong-allocation" ? "waffle-workspace" : request.databaseName,
  });
  if (isHostedPage() && window.__pageRunner.ackedThrough <= beforeAllocation)
    throw new Error("Storage opened before allocation ACK");
  let settled = false;
  try {
    await openOwned(request.databaseName);
    await allocate({ kind: "indexeddb", name: request.databaseName });
    await openOwned(request.databaseName);
    await assets();
  } finally {
    await finalizer();
    settled = true;
  }
  return value(CONSUMER_CONTROL, settled);
}
const suite: PageSuite<Request> = {
  list: async () => ({ ids: ["consumer: default"] }),
  run: envelope,
  finish: async (ledger) => {
    const remaining = await cleanupStorage(ledger);
    await verifySentinel();
    return remaining;
  },
};
if (isHostedPage()) startPage(suite);

async function desktopControl(): Promise<void> {
  const databaseName = "consumer-desktop-fixture";
  let result: unknown;
  try {
    result = await envelope(
      { databaseName, encoded: '</script><script>throw "unsafe"</script>' },
      async () => {},
    );
  } finally {
    const remaining = await cleanupStorage([{ kind: "indexeddb", name: databaseName }]);
    if (remaining.length) result = { error: "Desktop fixture cleanup failed" };
  }
  window.__consumerDesktopResult = result;
}
if (!isHostedPage())
  void desktopControl().catch((error: unknown) => {
    window.__consumerDesktopResult = { error: String(error) };
  });
