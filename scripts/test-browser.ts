import { runOwned } from "./owned-command.ts";

const stopped = new AbortController();
const stop = () => stopped.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const runners = [
  "tests/storage-browser-runner.ts",
  "tests/storage-lock-browser-runner.ts",
  "tests/process-recycling-browser-runner.ts",
];
try {
  const results = await Promise.allSettled(
    runners.map((runner) =>
      runOwned([process.execPath, runner, "chromium", "firefox", "webkit"], {
        cwd: import.meta.dir + "/..",
        env: process.env,
        signal: stopped.signal,
      }),
    ),
  );
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [new Error(`${runners[index]} failed`, { cause: result.reason })]
      : [],
  );
  if (failures.length) throw new AggregateError(failures, "Browser matrix failed");
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
