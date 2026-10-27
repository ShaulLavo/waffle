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
  constructor(readonly url: string) {
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
const refill = () => Bun.sleep(10);
function take(url: string): FakeWorker {
  const worker = pool.take(url);
  if (!(worker instanceof FakeWorker)) throw new Error("unexpected worker implementation");
  return worker;
}

test("two unused workers are precreated off the demand stack and leased once", async () => {
  const first = take("a");
  expect(workers).toHaveLength(1);
  await refill();
  expect(workers).toHaveLength(3);
  expect(take("a")).toBe(workers[1]!);
  expect(take("a")).toBe(workers[2]!);
  expect(workers).toHaveLength(3);
  expect(take("a")).not.toBe(first);
  expect(workers).toHaveLength(4);
  await refill();
  expect(workers).toHaveLength(6);
  pool.dispose();
  expect(workers.map((worker) => worker.stopped)).toEqual([0, 0, 0, 0, 1, 1]);
});

test("worker URLs never share workers and the total idle bound stays two", async () => {
  take("a");
  await refill();
  take("b");
  await refill();
  expect(workers.map((worker) => worker.stopped)).toEqual([0, 1, 1, 0, 0, 0]);
  expect(take("b")).toBe(workers[4]!);
  expect(workers).toHaveLength(6);
});

test("idle crashes and unsolicited messages discard workers without a retry loop", async () => {
  take("a");
  await refill();
  const bad = workers[1]!,
    noisy = workers[2]!;
  const error = bad.onerror!;
  let prevented = false;
  error({
    preventDefault() {
      prevented = true;
    },
  } as ErrorEvent);
  noisy.onmessage!({ data: { type: "exit", code: 0 } } as MessageEvent);
  error({ preventDefault() {} } as ErrorEvent);
  await refill();
  expect(prevented).toBe(true);
  expect(workers).toHaveLength(3);
  expect(bad.stopped).toBe(1);
  expect(noisy.stopped).toBe(1);
  expect(take("a")).toBe(workers[3]!);
});

test("a leased worker loses idle callbacks and is never stopped by pool disposal", async () => {
  take("a");
  await refill();
  const idle = workers[1]!;
  const late = idle.onerror!;
  expect(take("a")).toBe(idle);
  expect(idle.onerror).toBeNull();
  expect(idle.onmessage).toBeNull();
  late({ preventDefault() {} } as ErrorEvent);
  pool.dispose();
  expect(idle.stopped).toBe(0);
  expect(() => take("a")).toThrow("disposed");
  await refill();
  expect(workers).toHaveLength(3);
});

test("disposal cancels pending construction and initialization failures do not spin", async () => {
  take("a");
  pool.dispose();
  await refill();
  expect(workers).toHaveLength(1);
  pool = new ReadyWorkerPool();
  take("a");
  rejectConstruction = true;
  await refill();
  expect(workers).toHaveLength(2);
  expect(() => take("a")).toThrow("construction rejected");
  rejectConstruction = false;
  take("a");
  await refill();
  expect(workers).toHaveLength(5);
});
