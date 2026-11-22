import type {
  SleepingCollectorMessage,
  SleepingCollectorRequest,
} from "./fixtures/sleeping-collector-worker.js";

// docs/webkit-blocking-waits.md in a real browser. Workers that sleep with a collection cycle
// open must not stop another Worker from creating a Wasm memory past the engine's fast-memory
// limit, which is what a process start does.

interface SleepingCollectorReport {
  /** Starts while sleepers used the runtime's wait. None may stall. */
  readonly waffle: {
    readonly started: number;
    readonly stalled: number;
    readonly slowestMs: number;
  };
  /** The same with the engine's own wait: the control that shows the engine defect. */
  readonly native: { readonly attempts: number; readonly stalled: number };
}

const SLEEPERS = 6;
const WORKER = "/worker.js";

type Outcome = { readonly stalled: true } | { readonly stalled: false; readonly ms: number };

function run(
  workers: Worker[],
  request: SleepingCollectorRequest,
  until: SleepingCollectorMessage["step"],
  capMs: number,
): Promise<Outcome> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER, { type: "module" });
    workers.push(worker);
    const timer = setTimeout(() => resolve({ stalled: true }), capMs);
    worker.onmessage = ({ data }: MessageEvent<SleepingCollectorMessage>) => {
      if (data.step !== until) return;
      clearTimeout(timer);
      resolve({ stalled: false, ms: data.step === "started" ? data.ms : 0 });
    };
    worker.postMessage(request);
  });
}

/** One set of sleepers, then starts one after another. Stops at the first start that stalls. */
async function round(
  wait: SleepingCollectorRequest["wait"],
  starts: number,
  capMs: number,
): Promise<{ started: number; stalled: number; slowestMs: number }> {
  const workers: Worker[] = [];
  const cells = new SharedArrayBuffer(4);
  const result = { started: 0, stalled: 0, slowestMs: 0 };
  try {
    const sleepers = Array.from({ length: SLEEPERS }, () =>
      run(
        workers,
        { role: "sleeper", wait, cells, size: 100 + Math.floor(Math.random() * 200) },
        "sleeping",
        120_000,
      ),
    );
    if ((await Promise.all(sleepers)).some((sleeper) => sleeper.stalled))
      throw new Error("a sleeper never reported that it was about to sleep");
    for (let index = 0; index < starts && !result.stalled; index++) {
      const size = 5 + Math.floor(Math.random() * 30);
      const outcome = await run(workers, { role: "starter", wait, cells, size }, "started", capMs);
      if (outcome.stalled) result.stalled++;
      else {
        result.started++;
        result.slowestMs = Math.max(result.slowestMs, outcome.ms);
      }
    }
  } finally {
    for (const worker of workers) worker.terminate();
  }
  return result;
}

/** @browserEntry Starts Workers beside sleeping ones, with the runtime's wait and with the engine's. */
export async function sleepingCollector(): Promise<SleepingCollectorReport> {
  // The engine keeps a fixed number of fast Wasm memories. With these alive, every later
  // memory creation collects synchronously first.
  const fast = Array.from({ length: 8 }, () => new WebAssembly.Memory({ initial: 1 }));
  const waffle = { started: 0, stalled: 0, slowestMs: 0 };
  // Sleepers pin the collector only when a cycle is open as they block, about every second
  // round, so several rounds are needed to meet the condition.
  for (let index = 0; index < 4; index++) {
    // A hang cap: the longest wake the runtime's wait allows is two seconds.
    const result = await round("waffle", 30, 60_000);
    waffle.started += result.started;
    waffle.stalled += result.stalled;
    waffle.slowestMs = Math.max(waffle.slowestMs, result.slowestMs);
  }
  // The control runs last: a start that stalls in the engine cannot be terminated.
  const native = { attempts: 0, stalled: 0 };
  while (native.attempts < 4 && !native.stalled) {
    native.attempts++;
    native.stalled += (await round("native", 10, 8000)).stalled;
  }
  if (fast.length !== 8) throw new Error("the fast memories were collected");
  return { waffle, native };
}
