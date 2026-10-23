import { runBrowserSuite } from "./browser-command.ts";

const stopped = new AbortController();
const stop = () => stopped.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const runners = [
  "tests/storage-browser-runner.ts",
  "tests/storage-lock-browser-runner.ts",
  "tests/process-recycling-browser-runner.ts",
  "tests/network-browser-runner.ts",
  "tests/publication-browser-runner.ts",
  "tests/publication-cross-tab-browser-runner.ts",
];
const batches = [runners.map((runner) => ({ runner, engines: ["chromium", "firefox"] }))].concat(
  runners.map((runner) => [{ runner, engines: ["webkit"] }]),
  [[{ runner: "tests/workspace-continuity-browser-runner.ts", engines: ["chromium"] }]],
);
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
