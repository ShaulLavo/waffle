import { createRuntime, type Runtime } from "waffle/runtime";
import { cleanupStorage, startPage } from "waffle/testing/page-runner/page";
import { record } from "./protocol.js";

declare const HOST_STORAGE_CONTROL: string;
type Request = { mode: string };
type StorageControl = {
  returned: boolean;
  constructors: number;
  workers: number;
  returnedAt: number;
  taskEnds: number;
  sentinelsChecked: number;
  opens: string[];
  allocationSeen: boolean;
  ackReceived: boolean;
  attempts: number;
  operation: string;
  release(): void;
  exercise(name: string): Promise<void>;
  snapshot(): Promise<unknown>;
};
declare global {
  interface Window {
    __storageControl: StorageControl;
  }
}
const config = window.__suiteConfiguration;
const foreign = `host-storage-${config.run}-foreign`;
const sentinels = [foreign, "waffle-workspace"];
const release = Promise.withResolvers<void>();
let runtime: Runtime | undefined;
const channelName = `host-storage-${config.run}`;
const channel = new BroadcastChannel(channelName);
const state: StorageControl = {
  returned: false,
  constructors: 0,
  workers: 0,
  returnedAt: Infinity,
  taskEnds: 0,
  sentinelsChecked: 0,
  opens: [],
  allocationSeen: false,
  ackReceived: false,
  attempts: 0,
  operation: "",
  release: release.resolve,
  exercise,
  snapshot,
};
window.__storageControl = state;
channel.onmessage = (event: MessageEvent<unknown>) => {
  if (!record(event.data) || typeof event.data.name !== "string") return;
  state.opens.push(event.data.name);
  if (!state.returned || typeof event.data.at !== "number" || event.data.at < state.returnedAt)
    throw new Error("WORKER_OPEN_BEFORE_VALID_RETURN");
};
const NativeWorker = Worker;
class ObservedWorker extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    state.workers++;
    super(url, options);
  }
}
globalThis.Worker = ObservedWorker;
async function snapshot(): Promise<unknown> {
  if (config.role === "case") {
    for (const name of sentinels) await sentinel(name, false);
    state.sentinelsChecked = sentinels.length;
  }
  return {
    role: config.role,
    returned: state.returned,
    constructors: state.constructors,
    workers: state.workers,
    opens: state.opens,
    attempts: state.attempts,
    taskEnds: state.taskEnds,
    sentinelsChecked: state.sentinelsChecked,
    reporter: window.__pageRunner,
  };
}
async function database(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => request.result.createObjectStore("sentinel");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function sentinelTransaction(db: IDBDatabase, name: string, write: boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("sentinel", write ? "readwrite" : "readonly");
    const store = tx.objectStore("sentinel");
    const request = write ? store.put(`content:${name}`, "key") : store.get("key");
    request.onsuccess = () => {
      if (!write && request.result !== `content:${name}`) reject(new Error("SENTINEL_CHANGED"));
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
async function sentinel(name: string, write: boolean): Promise<void> {
  const db = await database(name);
  try {
    await sentinelTransaction(db, name, write);
  } finally {
    db.close();
  }
}
async function exercise(name: string): Promise<void> {
  if (!state.returned || !state.ackReceived) throw new Error("CONSTRUCTOR_BEFORE_VALID_RETURN");
  state.constructors++;
  runtime = createRuntime({
    filesystem: {
      mode: "fast",
      name,
      workerURL: `/storage-worker.js?channel=${encodeURIComponent(channelName)}`,
    },
  });
  try {
    await runtime.filesystem.writeFile(
      "/owned-value",
      new TextEncoder().encode("actual FAST value"),
    );
    const bytes = await runtime.filesystem.readFile("/owned-value");
    if (!bytes || new TextDecoder().decode(bytes) !== "actual FAST value")
      throw new Error("FAST_READ_MISMATCH");
  } finally {
    await runtime.dispose();
    runtime = undefined;
  }
}
const post = globalThis.fetch.bind(globalThis);
Reflect.set(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const body = String(init?.body);
  if (body.includes('"kind":"task-end"')) state.taskEnds++;
  const response = await post(input, init);
  if (!String(init?.body).includes('"kind":"allocation"')) return response;
  state.allocationSeen = true;
  state.attempts++;
  if (["delayed", "slot"].includes(HOST_STORAGE_CONTROL) && state.attempts === 1)
    await release.promise;
  if (HOST_STORAGE_CONTROL === "recovered" && state.attempts === 1) throw new Error("LOST_ACK");
  if (HOST_STORAGE_CONTROL === "exhausted") throw new Error("EXHAUSTED_ACK");
  if (HOST_STORAGE_CONTROL === "late") await new Promise((resolve) => setTimeout(resolve, 400));
  state.ackReceived = response.ok;
  return response;
});
startPage<Request>({
  list: async () => {
    for (const name of sentinels) await sentinel(name, true);
    return { ids: ["storage"] };
  },
  run: {
    kind: "host",
    async teardown() {
      // A settled proof is not a physical-shutdown claim for an unfinished owner.
      return { constructors: state.constructors, opens: state.opens, runtimePresent: !!runtime };
    },
  },
  finish: async (ledger) => {
    const blocked =
      HOST_STORAGE_CONTROL === "blocked" && ledger[0] ? await database(ledger[0].name) : undefined;
    let remaining;
    try {
      remaining = await cleanupStorage(ledger, HOST_STORAGE_CONTROL === "blocked" ? 60 : 8000);
    } finally {
      blocked?.close();
    }

    for (const name of sentinels) await sentinel(name, false);
    state.sentinelsChecked = sentinels.length;
    const fixtureRemaining = await cleanupStorage(
      sentinels.map((name) => ({ kind: "indexeddb", name })),
    );
    if (fixtureRemaining.length) throw new Error("Fixture sentinel cleanup failed");
    channel.close();
    return remaining;
  },
});
