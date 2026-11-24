import { runBrowserSuite } from "./browser-command.ts";

const stopped = new AbortController();
const stop = () => stopped.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
type SuiteTask = { runner: string; engines: readonly string[] };
type SuiteBatch = { concurrency: number; tasks: readonly SuiteTask[] };

const gpuRunner = "tests/gpu-browser-runner.ts";
const asyncGpuRunner = "tests/gpu-async-browser-runner.ts";
const crossTabRunner = "tests/publication-cross-tab-browser-runner.ts";
const reporterControls = "tests/page-runner/browser-controls-runner.ts";
const storageRunner = "testing/storage-browser-runner.ts";
const runners = [
  "tests/process-recycling-browser-runner.ts",
  storageRunner,
  "tests/browser-navigation-browser-runner.ts",
  "tests/publication-cross-tab-browser-runner.ts",
  "tests/publication-browser-runner.ts",
  "tests/network-browser-runner.ts",
  "tests/threads-runtime-browser-runner.ts",
  "tests/link-browser-runner.ts",
  "tests/safe-staging-browser-runner.ts",
  "tests/storage-lock-browser-runner.ts",
  "tests/multitab-browser-runner.ts",
  "tests/search-executor-browser-runner.ts",
  "tests/guest-watch-browser-runner.ts",
  "tests/filesystem-transport-browser-runner.ts",
  "tests/running-member-reuse-browser-runner.ts",
  "tests/stop-order-browser-runner.ts",
  "tests/wait-async-browser-runner.ts",
  "tests/process-start-browser-runner.ts",
  "tests/interrupt-symbols-browser-runner.ts",
  gpuRunner,
];
const splitEngines = new Set([
  "tests/process-recycling-browser-runner.ts",
  storageRunner,
  gpuRunner,
]);
const fixedStoragePort = Number(process.env.STORAGE_TEST_PORT ?? 0) !== 0;
function parallelTasks(runner: string): SuiteTask[] {
  if (splitEngines.has(runner) && !(runner === storageRunner && fixedStoragePort))
    return [
      { runner, engines: ["chromium"] },
      { runner, engines: ["firefox"] },
    ];
  return [{ runner, engines: ["chromium", "firefox"] }];
}
const parallel: SuiteBatch[] = [
  {
    concurrency: 6,
    tasks: runners.filter((runner) => runner !== gpuRunner).flatMap(parallelTasks),
  },
  {
    concurrency: 2,
    tasks: parallelTasks(gpuRunner),
  },
  {
    concurrency: 3,
    tasks: [
      { runner: "tests/recovery-r42-browser-runner.ts", engines: ["chromium"] },
      { runner: "tests/gpu-native-browser-runner.ts", engines: ["chromium"] },
      { runner: asyncGpuRunner, engines: ["chromium", "firefox"] },
    ],
  },
];
const webkitTasks: SuiteTask[] = runners
  .filter((runner) => runner !== crossTabRunner)
  .map((runner) => ({ runner, engines: ["webkit"] }))
  .concat(
    [{ runner: "tests/bootstrap-arrival-browser-runner.ts", engines: ["webkit"] }],
    [{ runner: asyncGpuRunner, engines: ["webkit"] }],
  );
const isolatedTasks: SuiteTask[] = [
  { runner: "tests/workspace-continuity-browser-runner.ts", engines: ["chromium"] },
  { runner: "tests/root-continuity-browser-runner.ts", engines: ["chromium"] },
  {
    runner: "tests/root-continuity-browser-runner.ts",
    engines: ["--page-controls", "chromium"],
  },
  { runner: "tests/network-browser-runner.ts", engines: ["--page-controls", "chromium"] },
  { runner: "tests/memory-group-browser-runner.ts", engines: ["chromium"] },
  { runner: "tests/fs-socket-browser-runner.ts", engines: ["firefox"] },
  {
    runner: "tests/process-recycling-browser-runner.ts",
    engines: ["--page-controls", "chromium"],
  },
  {
    runner: "tests/page-runner/gpu-async-controls-runner.ts",
    engines: ["--ci", "chromium", "webkit"],
  },
  { runner: "tests/notification-browser-runner.ts", engines: [] },
];
const timingSensitiveIsolatedTasks: SuiteTask[] = [
  { runner: "tests/asset-load-recovery-browser-runner.ts", engines: [] },
  { runner: "tests/notification-fairness-browser-runner.ts", engines: [] },
];
const serialRuntime: SuiteBatch[] = [
  { concurrency: 3, tasks: webkitTasks },
  { concurrency: 1, tasks: [{ runner: crossTabRunner, engines: ["webkit"] }] },
  { concurrency: 4, tasks: isolatedTasks },
  { concurrency: 1, tasks: timingSensitiveIsolatedTasks },
];
const reporter: SuiteBatch[] = [
  { concurrency: 1, tasks: [{ runner: reporterControls, engines: ["--prepare"] }] },
  {
    concurrency: 2,
    tasks: [
      { runner: reporterControls, engines: ["chromium", "--prepared"] },
      { runner: reporterControls, engines: ["webkit", "--prepared"] },
    ],
  },
];
function selectBatches(group: string | undefined): SuiteBatch[] {
  switch (group) {
    case undefined:
      return parallel.concat(serialRuntime, reporter);
    case "parallel":
      return parallel;
    case "serial":
      return serialRuntime.concat(reporter);
    case "runtime":
      return parallel.concat(serialRuntime);
    case "reporter":
      return reporter;
    default:
      throw new Error(`Unknown WAFFLE_BROWSER_GROUP: ${group}`);
  }
}
const group = process.env.WAFFLE_BROWSER_GROUP;
const batches = selectBatches(group);

function invocationEnv(runner: string, engines: readonly string[]) {
  if ((group !== undefined && group !== "runtime") || runner !== storageRunner) return process.env;
  return { ...process.env, STORAGE_LIFECYCLE_OBSERVER: engines.includes("webkit") ? "0" : "1" };
}

function taskLabel(task: SuiteTask): string {
  return task.engines.length ? `${task.runner} ${task.engines.join(" ")}` : task.runner;
}

async function runSuiteTask(task: SuiteTask, failures: Error[]): Promise<void> {
  try {
    await runBrowserSuite([process.execPath, task.runner].concat(task.engines), {
      cwd: import.meta.dir + "/..",
      env: invocationEnv(task.runner, task.engines),
      signal: stopped.signal,
    });
  } catch (reason) {
    failures.push(new Error(`${taskLabel(task)} failed`, { cause: reason }));
  }
}

async function runBatch(batch: SuiteBatch): Promise<Error[]> {
  const failures: Error[] = [];
  const limit = Math.min(batch.concurrency, batch.tasks.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < batch.tasks.length) {
      const task = batch.tasks[nextIndex++];
      if (!task) return;
      await runSuiteTask(task, failures);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return failures;
}

let failures: Error[] = [];
try {
  for (const batch of batches) failures = failures.concat(await runBatch(batch));
  if (failures.length) throw new AggregateError(failures, "Browser matrix failed");
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
