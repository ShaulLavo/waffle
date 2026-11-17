import { createRuntime, type RuntimeSupervisor } from "../runtime.js";
import { pageRootClient } from "./fixtures/page-root-client.js";
import { stopOrderModule } from "./fixtures/stop-order-wasm.js";

// docs/host-abi.md, "Stop polling": the broker selects SIGKILL, waits a bounded time for the
// guest to unwind, and only then calls terminate(). On WebKit, terminate() landing while a
// guest still calls host imports in a loop crashes the page (plans/group-futex-retirement.md,
// gap 1), so for a polling guest every terminate() must come after the worker reported exit.

export interface StopOrderOptions {
  readonly repetitions: number;
  readonly pages: number;
  readonly polling: boolean;
  /**
   * `kill`: supervisor.kill(pid, 9) selects the outcome first. `physical`: the launch handle's
   * terminate(), a physical stop like runtime disposal, where the broker selects SIGKILL itself.
   */
  readonly stop: "kill" | "physical";
}

export interface StopOrderReport {
  readonly runs: number;
  /** Stops whose exit status reported SIGKILL. */
  readonly killed: number;
  /** Exit status count by code. A physical stop can also end with 1 (revoked or cancelled). */
  readonly codes: Readonly<Record<string, number>>;
  /** Workers terminate() was called on. */
  readonly terminated: number;
  /** Of those, the ones whose worker had already posted its exit. */
  readonly terminatedAfterExit: number;
  /** Milliseconds from kill to terminate(), per run. */
  readonly killToTerminateMs: readonly number[];
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const pause = (ms = 1) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string): Promise<void> {
  const limit = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > limit) throw new Error(`stop order observation timed out: ${label}`);
    await pause();
  }
}

interface Observed {
  pid?: number;
  exitAt?: number;
  terminateAt?: number;
}

/** Records, per process, when its worker posted exit and when the broker terminated it. */
function observeWorkers(): { byPid: Map<number, Observed>; restore(): void } {
  const NativeWorker = globalThis.Worker;
  const byPid = new Map<number, Observed>();
  globalThis.Worker = class extends NativeWorker {
    readonly observed: Observed = {};
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener("message", ({ data }) => {
        if (data?.type === "exit") this.observed.exitAt ??= performance.now();
      });
    }
    override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      const pid = (message as { runtimeProcess?: { pid?: number } })?.runtimeProcess?.pid;
      if (pid !== undefined) byPid.set((this.observed.pid = pid), this.observed);
      super.postMessage(message, transfer as Transferable[]);
    }
    override terminate() {
      this.observed.terminateAt ??= performance.now();
      super.terminate();
    }
  };
  return { byPid, restore: () => (globalThis.Worker = NativeWorker) };
}

/**
 * @browserEntry Stops `repetitions` guests through the real runtime and broker and reports, per
 * stop, whether terminate() came after the worker posted its exit.
 */
export async function stopOrder(options: StopOrderOptions): Promise<StopOrderReport> {
  const workers = observeWorkers();
  const runtime = createRuntime({ filesystem: { workerURL: "/fs-worker.js", mode: "memory" } });
  const memories = new Map<number, WebAssembly.Memory>();
  const handles = new Map<number, { terminate(): void | Promise<void> }>();
  runtime.registerAdapter("stop-order", (context, service) => {
    const handle = service.launchWorker(context, {
      workerUrl: "/worker.js",
      request: { module: context.module, args: context.request.argv, env: {} },
      onMessage(message) {
        const data = message as { type?: string; memory?: WebAssembly.Memory };
        if (data.type === "stop-order-memory" && data.memory)
          memories.set(context.pid, data.memory);
      },
    });
    handles.set(context.pid, handle);
    return handle;
  });
  const source = stopOrderModule(options.pages, options.polling);
  // A trusted cooperative module: source bytes would get interrupt checkpoints injected, and
  // the busy guest must make no host call at all.
  const module = await WebAssembly.compile(source);
  runtime.registerProgram("/spin", { adapter: "stop-order", module, cooperative: true });
  const { root, client, descriptors, notices } = pageRootClient(runtime);
  const service = await runtime.processes();
  const flush = async () => {
    while (notices.length) await service.runtimeMessage(notices.shift()!, root.pid);
  };
  let killed = 0;
  const codes: Record<string, number> = {};
  const killToTerminateMs: number[] = [];
  try {
    await runtime.filesystem.writeFile("/spin", source);
    await service.adoptRuntimeRoot(root, { memory: [] });
    const supervisor: RuntimeSupervisor = await service.ready();
    for (let run = 0; run < options.repetitions; run++) {
      const pid = client.spawn(root.pid, {
        executable: "/spin",
        argv: ["spin"],
        env: {},
        cwd: "/",
        job: -1,
        fds: [],
      });
      await flush();
      await supervisor.start(pid);
      // The guest is in its loop once its heartbeat moved twice.
      await until(() => {
        const memory = memories.get(pid);
        return !!memory && Atomics.load(new Int32Array(memory.buffer), 0) > 2;
      }, `heartbeat of ${pid}`);
      const killAt = performance.now();
      const stopped =
        options.stop === "kill" ? supervisor.kill(pid, 9) : handles.get(pid)!.terminate();
      const result = await supervisor.waitForExit(root.pid, pid);
      await stopped;
      if (result.code === 9) killed++;
      codes[result.code] = (codes[result.code] ?? 0) + 1;
      handles.delete(pid);
      client.wait(root.pid, pid);
      await flush();
      const observed = workers.byPid.get(pid);
      await until(() => observed?.terminateAt !== undefined, `terminate of ${pid}`);
      killToTerminateMs.push(Math.round(observed!.terminateAt! - killAt));
      memories.delete(pid);
    }
  } finally {
    descriptors.dispose();
    await runtime.dispose();
    workers.restore();
  }
  const observed = Array.from(workers.byPid.values());
  const terminated = observed.filter((entry) => entry.terminateAt !== undefined);
  assert(observed.length === options.repetitions, "one worker per run");
  return {
    runs: options.repetitions,
    killed,
    codes,
    terminated: terminated.length,
    terminatedAfterExit: terminated.filter(
      (entry) => entry.exitAt !== undefined && entry.exitAt <= entry.terminateAt!,
    ).length,
    killToTerminateMs,
  };
}
