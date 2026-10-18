import { afterEach, expect, spyOn, test } from "bun:test";
import { createRuntime, type Runtime, type RuntimeStartupObserver, type RuntimeStartupStage } from "../index.js";
import { SharedFilesystem } from "../browser/shared-fs.js";
import { IndexedDBStorage, type StorageLockManager } from "../fs/indexeddb.js";
import { MemoryBackend } from "../fs/backend.js";
import { installFilesystemWorker } from "../fs/service.js";
import { reportRuntimeStartup } from "../fs/startup.js";
import type { FilesystemConnection } from "../fs/protocol.js";

const originalWorker = globalThis.Worker;
const workers: TestWorker[] = [];
const runtimes: Runtime[] = [];
const filesystems: SharedFilesystem[] = [];
const clockSpies: ReturnType<typeof spyOn>[] = [];
const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
let backendFactory: () => MemoryBackend | Promise<MemoryBackend> = () => new MemoryBackend();
class TestWorker {
  messages: any[] = [];
  diagnostics: any[] = [];
  ports: MessagePort[] = [];
  listeners: EventListener[] = [];
  stopped = false;
  scope = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: (data: unknown) => {
    this.diagnostics.push(data);
    queueMicrotask(() => this.emit(data));
  } };
  constructor() {
    workers.push(this);
    installFilesystemWorker(this.scope, backendFactory);
  }
  addEventListener(type: string, listener: EventListener) { if (type === "message") this.listeners.push(listener); }
  emit(data: unknown) { for (const listener of this.listeners) listener({ data } as MessageEvent); }
  postMessage(message: { connect: FilesystemConnection; observeStartup?: true }) {
    this.messages.push(message);
    this.ports.push(message.connect.port);
    queueMicrotask(() => this.scope.onmessage!({ data: message } as MessageEvent));
  }
  terminate() { this.stopped = true; }
}
function installWorker(): void { globalThis.Worker = TestWorker as unknown as typeof Worker; }
function filesystem(onStartupStage?: RuntimeStartupObserver): SharedFilesystem {
  installWorker();
  const fs = new SharedFilesystem({ workerURL: "https://example.test/fs.js", persistence: false }, onStartupStage);
  filesystems.push(fs);
  return fs;
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const fs of filesystems.splice(0)) fs.dispose();
  for (const worker of workers.splice(0)) for (const port of worker.ports) port.close();
  for (const spy of clockSpies.splice(0)) spy.mockRestore();
  backendFactory = () => new MemoryBackend();
  globalThis.Worker = originalWorker;
});

test("runtime observation is opt-in, with no diagnostic clocks or messages by default", async () => {
  const clock = spyOn(performance, "now"); clockSpies.push(clock);
  installWorker();
  const runtime = createRuntime({ filesystem: { workerURL: "https://example.test/fs.js", persistence: false } });
  runtimes.push(runtime);
  expect(await runtime.filesystem.listFiles()).toEqual([]);
  expect(workers[0]!.messages[0]).not.toHaveProperty("observeStartup");
  expect(workers[0]!.diagnostics).toEqual([]);
  expect(clock).not.toHaveBeenCalled();
  await runtime.dispose();
  expect(workers[0]!.stopped).toBe(true);
});

test("runtime forwards fixed stages and original worker timestamps, with readiness after backend setup", async () => {
  const seen: [RuntimeStartupStage, number][] = [];
  const clock = spyOn(performance, "now").mockReturnValue(123); clockSpies.push(clock);
  let release!: (backend: MemoryBackend) => void;
  backendFactory = () => new Promise(resolve => { release = resolve; });
  installWorker();
  const runtime = createRuntime({ filesystem: { workerURL: "https://example.test/fs.js", persistence: false },
    onStartupStage: (stage, timestamp) => { seen.push([stage, timestamp]); } });
  runtimes.push(runtime);
  expect(seen.map(([stage]) => stage)).toEqual(["filesystem-worker-created", "filesystem-connect-requested"]);
  await tick();
  expect(seen.map(([stage]) => stage)).toEqual(["filesystem-worker-created", "filesystem-connect-requested", "filesystem-connected"]);
  expect(workers[0]!.messages[0].observeStartup).toBe(true);
  release(new MemoryBackend());
  expect(await runtime.filesystem.listFiles()).toEqual([]);
  await tick();
  expect(seen.map(([stage]) => stage)).toEqual(["filesystem-worker-created", "filesystem-connect-requested", "filesystem-connected", "filesystem-ready"]);
  expect(seen.every(([, timestamp]) => timestamp === performance.timeOrigin + 123)).toBe(true);
  expect(clock).toHaveBeenCalledTimes(4); // Forwarding a worker event must not sample a page clock.
  const fork = runtime.filesystem.fork();
  workers[0]!.ports.push(fork.port);
  await tick();
  expect(seen).toHaveLength(4);
});

test("worker message boundary rejects unknown stages and nonfinite clocks without forwarding payloads", async () => {
  const seen: unknown[][] = [];
  filesystem((...args) => { seen.push(args); });
  await tick();
  seen.length = 0;
  const worker = workers[0]!;
  for (const data of [null, {}, { type: "filesystem-startup", stage: "private/path", timestamp: 1 },
    { type: "filesystem-startup", stage: "filesystem-ready", timestamp: NaN },
    { type: "filesystem-startup", stage: "filesystem-ready", timestamp: Infinity },
    { type: "filesystem-startup", stage: "filesystem-ready", timestamp: "1" },
    { type: "filesystem-startup", stage: "filesystem-worker-created", timestamp: 1 }]) worker.emit(data);
  expect(seen).toEqual([]);
  worker.emit({ type: "filesystem-startup", stage: "filesystem-ready", timestamp: 42, payload: { private: "never forwarded" } });
  expect(seen).toEqual([["filesystem-ready", 42]]);
});

test("throwing, rejected and hostile thenable observers cannot interrupt startup or teardown", async () => {
  for (const observe of [() => { throw new Error("observer throw"); },
    () => Promise.reject(new Error("observer rejection")),
    () => ({ get then(): never { throw new Error("observer then"); } }),
    () => new Promise<void>(() => {})] satisfies RuntimeStartupObserver[]) {
    const fs = filesystem(observe);
    expect(await fs.listFiles()).toEqual([]);
    await tick();
    fs.dispose();
    expect(workers.at(-1)!.stopped).toBe(true);
  }
});

/** Controllable browser primitives: no timers, real storage, accounts, or lock contention. */
function indexedDBFixture() {
  const opening = {} as IDBOpenDBRequest;
  const get = {} as IDBRequest;
  let transaction!: IDBTransaction;
  let grant!: () => void;
  let closed = false;
  const db = {
    close() { closed = true; },
    transaction() {
      transaction = { objectStore: () => ({ get: () => get, put() {} }) } as unknown as IDBTransaction;
      return transaction;
    },
  } as unknown as IDBDatabase;
  const indexedDB = { open: () => opening } as unknown as IDBFactory;
  const locks: StorageLockManager = { request(_name, _options, callback) {
    return new Promise((resolve, reject) => { grant = () => { void callback({}).then(resolve, reject); }; });
  } };
  return {
    indexedDB, locks,
    opened() { Object.defineProperty(opening, "result", { value: db }); opening.onsuccess!({} as Event); },
    grant() { grant(); },
    committed() { Object.defineProperty(get, "result", { value: undefined }); get.onsuccess!({} as Event); transaction.oncomplete!({} as Event); },
    get closed() { return closed; },
  };
}

test("IndexedDB stages bracket the actual open, lock grant and epoch transaction completion", async () => {
  const fixture = indexedDBFixture();
  const seen: RuntimeStartupStage[] = [];
  const opening = IndexedDBStorage.open("fixture", { ...fixture, onStartupStage: stage => { seen.push(stage); } });
  expect(seen).toEqual(["indexeddb-open-requested"]);
  fixture.opened(); await tick();
  expect(seen).toEqual(["indexeddb-open-requested", "indexeddb-open-resolved", "filesystem-lock-requested"]);
  fixture.grant(); await tick();
  expect(seen.slice(-2)).toEqual(["filesystem-lock-acquired", "filesystem-epoch-requested"]);
  expect(seen).not.toContain("filesystem-epoch-resolved");
  fixture.committed();
  const storage = await opening;
  try { expect(seen.at(-1)).toBe("filesystem-epoch-resolved"); }
  finally { await storage.close(); }
  expect(fixture.closed).toBe(true);
});

test("IndexedDB performs no diagnostic clock calls without an observer", async () => {
  const clock = spyOn(performance, "now"); clockSpies.push(clock);
  const fixture = indexedDBFixture();
  const opening = IndexedDBStorage.open("fixture", fixture);
  fixture.opened(); await tick(); fixture.grant(); await tick(); fixture.committed();
  const storage = await opening;
  await storage.close();
  expect(clock).not.toHaveBeenCalled();
});

test("disabled reporter does not sample the clock", () => {
  const clock = spyOn(performance, "now"); clockSpies.push(clock);
  reportRuntimeStartup(undefined, "filesystem-ready");
  expect(clock).not.toHaveBeenCalled();
});
