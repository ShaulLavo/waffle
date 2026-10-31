import { test } from "bun:test";
import { browserQuietStartFailure, hostRootStartFailure } from "./start-failure-quiet-browser.js";

const worker = new URL("./fixtures/start-failure-quiet-worker.ts", import.meta.url).href;
for (const sink of ["pipe", "terminal"] as const) {
  for (const stage of [
    "lazy-loader",
    "invalid-module",
    "missing-start",
    "adapter-entry",
    "nested",
  ] as const)
    test(
      `runtime_proc ${stage} reports only to its parent and host (${sink})`,
      () => browserQuietStartFailure(stage, sink, worker),
      15_000,
    );
}
test(
  "runtime_proc startup failure still invokes a registered controller hook",
  () => browserQuietStartFailure("adapter-entry", "pipe", worker, true),
  15_000,
);
test("embedder root with a bookkeeping parent keeps its generic stderr line", hostRootStartFailure);
