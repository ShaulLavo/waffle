import type { WaitAsyncWaiterRequest } from "./fixtures/wait-async-waiter.js";

const UNTIMED_WAITS = 20;

interface WaitRun {
  readonly completed: boolean;
  readonly waits: number;
}

// Hang cap only: a timed wait loop that stops progressing for this long is stuck, not slow.
const STUCK_MS = 5000;

function runWaits(mode: WaitAsyncWaiterRequest["mode"], waits: number): Promise<WaitRun> {
  const word = new SharedArrayBuffer(4);
  const progress = new SharedArrayBuffer(4);
  const stop = new SharedArrayBuffer(4);
  const waiter = new Worker("/waiter.js", { type: "module" });
  const notifier = new Worker("/notifier.js", { type: "module" });
  const count = new Int32Array(progress);
  return new Promise<WaitRun>((resolve, reject) => {
    let last = -1;
    let lastChange = performance.now();
    const finish = (completed: boolean) => {
      clearInterval(timer);
      const stopCell = new Int32Array(stop);
      Atomics.store(stopCell, 0, 1);
      Atomics.notify(stopCell, 0);
      // A finished waiter closes itself; only a stuck one is terminated. The notifier closes itself.
      if (!completed) waiter.terminate();
      notifier.onmessage = () => resolve({ completed, waits: Atomics.load(count, 0) });
    };
    const timer = setInterval(() => {
      const value = Atomics.load(count, 0);
      if (value !== last) {
        last = value;
        lastChange = performance.now();
      } else if (performance.now() - lastChange > STUCK_MS) finish(false);
    }, 50);
    waiter.onmessage = () => finish(true);
    waiter.onerror = (event) => reject(new Error(`waiter failed: ${event.message}`));
    notifier.onerror = (event) => reject(new Error(`notifier failed: ${event.message}`));
    notifier.postMessage({ word, stop });
    waiter.postMessage({
      word,
      progress,
      mode,
      waits,
      untimed: UNTIMED_WAITS,
      timeout: 10,
    } satisfies WaitAsyncWaiterRequest);
  });
}

/** @browserEntry Called by the browser bundle through its runtime URL.
 * Timed Atomics.waitAsync racing notifies, then untimed waits in the same Worker. The native
 * run records whether this engine loses a timed wait; the settled helper must finish every wait
 * either way. */
export async function waitAsyncBrowserCases() {
  const timed = 1000;
  const expected = timed + UNTIMED_WAITS;
  const native = await runWaits("native", timed);
  const settled = await runWaits("settled", timed);
  if (!settled.completed || settled.waits !== expected)
    throw new Error(`settled waits stopped after ${settled.waits} of ${expected}`);
  return { nativeStalled: !native.completed, nativeWaits: native.waits, settled: settled.waits };
}
