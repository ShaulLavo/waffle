import { runBrowserSuite } from "./browser-command.ts";

const stopped = new AbortController();
const stop = () => stopped.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const gpuRunner = "tests/gpu-browser-runner.ts";
const asyncGpuRunner = "tests/gpu-async-browser-runner.ts";
const reporterControls = "tests/page-runner/browser-controls-runner.ts";
const storageRunner = "tests/storage-browser-runner.ts";
const runners = [
  "tests/browser-navigation-browser-runner.ts",
  "tests/link-browser-runner.ts",
  "tests/safe-staging-browser-runner.ts",
  storageRunner,
  "tests/storage-lock-browser-runner.ts",
  "tests/process-recycling-browser-runner.ts",
  "tests/network-browser-runner.ts",
  "tests/publication-browser-runner.ts",
  "tests/publication-cross-tab-browser-runner.ts",
  "tests/search-executor-browser-runner.ts",
  "tests/guest-watch-browser-runner.ts",
  "tests/filesystem-transport-browser-runner.ts",
  "tests/threads-runtime-browser-runner.ts",
  "tests/running-member-reuse-browser-runner.ts",
  "tests/stop-order-browser-runner.ts",
  "tests/process-start-browser-runner.ts",
  gpuRunner,
];
const parallel = [
  runners
    .filter((runner) => runner !== gpuRunner)
    .map((runner) => ({ runner, engines: ["chromium", "firefox"] })),
].concat([
  [{ runner: gpuRunner, engines: ["chromium", "firefox"] }],
  [{ runner: "tests/recovery-r42-browser-runner.ts", engines: ["chromium"] }],
  [{ runner: "tests/gpu-native-browser-runner.ts", engines: ["chromium"] }],
  [{ runner: asyncGpuRunner, engines: ["chromium", "firefox"] }],
]);
const serialBeforeReporter = runners
  .map((runner) => [{ runner, engines: ["webkit"] }])
  .concat(
    [[{ runner: "tests/bootstrap-arrival-browser-runner.ts", engines: ["webkit"] }]],
    [[{ runner: asyncGpuRunner, engines: ["webkit"] }]],
    [[{ runner: "tests/workspace-continuity-browser-runner.ts", engines: ["chromium"] }]],
    [[{ runner: "tests/root-continuity-browser-runner.ts", engines: ["chromium"] }]],
    [
      [
        {
          runner: "tests/root-continuity-browser-runner.ts",
          engines: ["--page-controls", "chromium"],
        },
      ],
    ],
    [[{ runner: "tests/network-browser-runner.ts", engines: ["--page-controls", "chromium"] }]],
    [[{ runner: "tests/memory-group-browser-runner.ts", engines: ["chromium"] }]],
    [[{ runner: "tests/fs-socket-browser-runner.ts", engines: ["firefox"] }]],
  );
const reporter = [
  [{ runner: reporterControls, engines: ["--prepare"] }],
  [{ runner: reporterControls, engines: ["chromium", "--prepared"] }],
  [{ runner: reporterControls, engines: ["webkit", "--prepared"] }],
];
const serialAfterReporter = [
  [
    {
      runner: "tests/process-recycling-browser-runner.ts",
      engines: ["--page-controls", "chromium"],
    },
  ],
  [
    {
      runner: "tests/page-runner/gpu-async-controls-runner.ts",
      engines: ["--ci", "chromium", "webkit"],
    },
  ],
  [{ runner: "tests/notification-browser-runner.ts", engines: [] }],
  [{ runner: "tests/asset-load-recovery-browser-runner.ts", engines: [] }],
  [{ runner: "tests/notification-fairness-browser-runner.ts", engines: [] }],
];
function selectBatches(group: string | undefined) {
  switch (group) {
    case undefined:
      return parallel.concat(serialBeforeReporter, reporter, serialAfterReporter);
    case "parallel":
      return parallel;
    case "serial":
      return serialBeforeReporter.concat(serialAfterReporter);
    case "runtime":
      return parallel.concat(serialBeforeReporter, serialAfterReporter);
    case "reporter":
      return reporter;
    default:
      throw new Error(`Unknown WAFFLE_BROWSER_GROUP: ${group}`);
  }
}
const group = process.env.WAFFLE_BROWSER_GROUP;
const batches = selectBatches(group);

function invocationEnv(runner: string, engines: readonly string[]) {
  if (group !== "runtime" || runner !== storageRunner) return process.env;
  return { ...process.env, STORAGE_LIFECYCLE_OBSERVER: engines.includes("webkit") ? "0" : "1" };
}

let failures: Error[] = [];
try {
  for (const batch of batches) {
    const results = await Promise.allSettled(
      batch.map(({ runner, engines }) =>
        runBrowserSuite([process.execPath, runner].concat(engines), {
          cwd: import.meta.dir + "/..",
          env: invocationEnv(runner, engines),
          signal: stopped.signal,
        }),
      ),
    );
    failures = failures.concat(
      results.flatMap((result, index) =>
        result.status === "rejected"
          ? [new Error(`${batch[index]?.runner} failed`, { cause: result.reason })]
          : [],
      ),
    );
  }
  if (failures.length) throw new AggregateError(failures, "Browser matrix failed");
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
