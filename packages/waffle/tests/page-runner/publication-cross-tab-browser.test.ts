import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { crossTabAdapter } from "./publication-cross-tab-suite.js";
import { runPageSuite } from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";

const controls = [
  { engine: "chromium", mode: "complete" },
  { engine: "chromium", mode: "wrong-original-bytes" },
  // A bounded desktop WebKit trial, independent of native Safari qualification.
  { engine: "webkit", mode: "complete" },
] as const;
for (const { engine, mode } of controls) {
  test.skipIf(process.env.PUBLICATION_BROWSER_CONTROLS !== "1")(
    `cross-tab ${engine} adapter ${mode} uses the original command and joins owned peers`,
    async () => {
      const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp", "wct-"));
      const adapter =
        mode === "complete"
          ? crossTabAdapter
          : {
              ...crossTabAdapter,
              async assets(context: Parameters<typeof crossTabAdapter.assets>[0]) {
                const assets = await crossTabAdapter.assets(context);
                assets["/original-cross-tab.js"] = assets["/cross-tab.js"]!;
                assets["/cross-tab.js"] =
                  `import { control as original } from '/original-cross-tab.js';
export async function control(operation, value) {
  const result = await original(operation, value);
  if (operation === 'persistentBaseline') result.reopened.first = [0];
  return result;
}`;
                return assets;
              },
            };
      try {
        const result = await runPageSuite(
          adapter,
          (scratch) => new PlaywrightDriver(engine, scratch),
          {
            scratchRoot: root,
            resultPath: process.env.CROSS_TAB_CONTROL_RESULTS
              ? join(process.env.CROSS_TAB_CONTROL_RESULTS, `${engine}-${mode}.json`)
              : join(root, "result.json"),
            port: "ephemeral",
          },
        );
        assert.equal(result.exit, mode === "complete" ? 0 : 1, JSON.stringify(result));
        if (mode === "complete") expect(result.failures).toEqual([]);
        else expect(JSON.stringify(result)).toContain("Expected [11,22,33,44], got [0]");
        expect(result.runComplete).toBe(true);
        expect(
          result.documents
            .filter((doc) => doc.peer !== null)
            .every((doc) => doc.physical === "closed"),
        ).toBe(true);
        expect(result.cleanup.session.status).toBe("confirmed");
        expect(result.cleanup.server.status).toBe("confirmed");
        expect(result.cleanup.scratch.status).toBe("confirmed");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    240_000,
  );
}
