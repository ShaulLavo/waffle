import { afterEach, beforeEach, expect, test } from "bun:test";
import { ReadyWorkerPool } from "../browser/worker-pool.js";

const OriginalWorker = globalThis.Worker;
let workers: FakeWorker[];
let pool: ReadyWorkerPool;
let rejectConstruction = false;
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  stopped = 0;
  constructor(
    readonly url: string,
    readonly options?: WorkerOptions,
  ) {
    if (rejectConstruction) throw new Error("construction rejected");
    workers.push(this);
  }
  terminate() {
    this.stopped++;
  }
}
beforeEach(() => {
  workers = [];
  rejectConstruction = false;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  pool = new ReadyWorkerPool();
});
afterEach(() => {
  pool.dispose();
  for (const worker of workers) worker.terminate();
  globalThis.Worker = OriginalWorker;
});
const idleTurn = () => Bun.sleep(10);
function take(url: string): FakeWorker {
  const worker = pool.take(url);
  if (!(worker instanceof FakeWorker)) throw new Error("unexpected worker implementation");
  return worker;
}

test("taking a worker never constructs unrequested workers while idle", async () => {
  take("a");
  expect(workers).toHaveLength(1);
  await idleTurn();
  expect(workers).toHaveLength(1);
});

test("every demand gets a fresh module worker for its requested URL", async () => {
  const first = take("a");
  const second = take("a");
  const third = take("b");
  expect(second).not.toBe(first);
  expect(third).not.toBe(second);
  expect(workers.map((worker) => worker.url)).toEqual(["a", "a", "b"]);
  expect(workers.map((worker) => worker.options)).toEqual([
    { type: "module" },
    { type: "module" },
    { type: "module" },
  ]);
  await idleTurn();
  expect(workers).toHaveLength(3);
});

test("disposal never stops caller-owned workers or constructs replacements", async () => {
  const worker = take("a");
  expect(pool.isIdle(worker)).toBe(false);
  expect(pool.isIdle({})).toBe(false);
  pool.dispose();
  pool.dispose();
  expect(worker.stopped).toBe(0);
  expect(pool.isIdle(worker)).toBe(false);
  expect(() => take("a")).toThrow("disposed");
  await idleTurn();
  expect(workers).toHaveLength(1);
  worker.terminate();
  expect(workers.every((entry) => entry.stopped === 1)).toBe(true);
});

test("constructor failure propagates and retries only on the next demand", async () => {
  rejectConstruction = true;
  expect(() => take("a")).toThrow("construction rejected");
  rejectConstruction = false;
  await idleTurn();
  expect(workers).toHaveLength(0);
  take("a");
  await idleTurn();
  expect(workers).toHaveLength(1);
});
