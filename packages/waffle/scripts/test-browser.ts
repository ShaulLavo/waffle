import { runBrowserSuite } from "./browser-command.ts";

const stopped = new AbortController();
const stop = () => stopped.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const runners = [
  "tests/safe-staging-browser-runner.ts",
  "tests/storage-browser-runner.ts",
  "tests/storage-lock-browser-runner.ts",
  "tests/process-recycling-browser-runner.ts",
  "tests/network-browser-runner.ts",
  "tests/publication-browser-runner.ts",
  "tests/publication-cross-tab-browser-runner.ts",
  "tests/search-executor-browser-runner.ts",
  "tests/guest-watch-browser-runner.ts",
];
const parallel = [runners.map((runner) => ({ runner, engines: ["chromium", "firefox"] }))].concat([
  [{ runner: "tests/recovery-r42-browser-runner.ts", engines: ["chromium"] }],
]);
const serial = runners
  .map((runner) => [{ runner, engines: ["webkit"] }])
  .concat(
    [[{ runner: "tests/workspace-continuity-browser-runner.ts", engines: ["chromium"] }]],
    [[{ runner: "tests/root-continuity-browser-runner.ts", engines: ["chromium"] }]],
    [[{ runner: "tests/memory-group-browser-runner.ts", engines: ["chromium"] }]],
    [[{ runner: "tests/fs-socket-browser-runner.ts", engines: ["firefox"] }]],
  );
// CI runs the two groups on separate runners; each keeps its own order.
const group = process.env.WAFFLE_BROWSER_GROUP;
if (group !== undefined && group !== "parallel" && group !== "serial")
  throw new Error(`Unknown WAFFLE_BROWSER_GROUP: ${group}`);
const batches = (group === "serial" ? [] : parallel).concat(group === "parallel" ? [] : serial);
let failures: Error[] = [];
try {
  for (const batch of batches) {
    const results = await Promise.allSettled(
      batch.map(({ runner, engines }) =>
        runBrowserSuite([process.execPath, runner].concat(engines), {
          cwd: import.meta.dir + "/..",
          env: process.env,
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
