import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPageSuite } from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
import { runtimeThreadCases } from "../threads-runtime-cases.js";
import { threadsRuntimeAdapter, threadRuntimeId } from "./threads-runtime-suite.js";

const browserTest = process.env.THREAD_RUNTIME_BROWSER_CONTROLS === "1" ? test : test.skip;
for (const tamper of [false, true]) {
  browserTest(
    `typed thread page executes actual Runtime, fixture tamper ${tamper}`,
    async () => {
      const root = await mkdtemp(
        join(
          process.env.PROCESS_SCRATCH_ROOT ?? process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(),
          "wtb-",
        ),
      );
      let driver: PlaywrightDriver | undefined;
      try {
        const directory = process.env.THREAD_FIXTURE_DIR;
        if (!directory)
          throw new Error("THREAD_FIXTURE_DIR is required for real thread page controls");
        const adapter = threadsRuntimeAdapter(directory);
        const assets = await adapter.assets({
          scratch: root,
          signal: new AbortController().signal,
        });
        if (tamper)
          assets["/threads.wasm"] = new Blob(["changed bytes"], { type: "application/wasm" });
        const result = await runPageSuite(
          adapter,
          (path) => (driver = new PlaywrightDriver("chromium", path)),
          {
            resultPath: process.env.THREAD_RUNTIME_RESULTS_DIR
              ? join(
                  process.env.THREAD_RUNTIME_RESULTS_DIR,
                  `typed-page-${tamper ? "tamper" : "complete"}.json`,
                )
              : join(root, "result.json"),
            scratchRoot: root,
            port: "ephemeral",
            assets,
          },
        );
        expect(result.required).toEqual(runtimeThreadCases.map(threadRuntimeId));
        expect(result.selected).toEqual(result.required);
        expect(result.omitted).toEqual([]);
        expect(result.exit).toBe(tamper ? 1 : 0);
        if (tamper)
          expect(JSON.stringify(result.outcomes)).toContain(
            "stock artifact does not match the verified producer receipt",
          );
        else {
          expect(Object.keys(result.results)).toEqual(result.required);
          expect(new Set(result.documents.map((item) => item.doc)).size).toBe(11);
        }
        expect(result.cleanup.scratch.status).toBe("confirmed");
        expect(result.cleanup.server.status).toBe("confirmed");
        expect(await readdir(root)).toEqual([]);
      } finally {
        await driver?.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
}
