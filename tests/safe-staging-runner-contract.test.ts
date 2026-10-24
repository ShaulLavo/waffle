import { expect, test } from "bun:test";

const runner = "tests/safe-staging-browser-runner.ts";
test("the browser matrix runs the native staged adapter once in each engine", async () => {
  const matrix = await Bun.file(new URL("../scripts/test-browser.ts", import.meta.url)).text();
  expect(matrix.split(`"${runner}"`).length - 1).toBe(1);
  const entry = await Bun.file(new URL("safe-staging-browser-runner.ts", import.meta.url)).text();
  expect(entry).toContain("runSafeStagingNative");
  expect(entry).toContain("process.argv.slice(2)");
  const units = await Bun.file(new URL("safe-staging.test.ts", import.meta.url)).text();
  expect(units).not.toContain("runSafeStagingNative");
  expect(units).not.toContain("SAFE_STAGING_ENGINE");
});

test("the native matrix discovers the checkpoint decoder control without a second launcher", async () => {
  const browser = await Bun.file(new URL("safe-staging-browser.ts", import.meta.url)).text();
  expect(browser).toContain(
    'import { checkpointDecodeControl } from "./indexeddb-checkpoint-decode-browser.js";',
  );
  expect(browser).toContain(
    "async function checkpointDecodeBounds(): Promise<void> {\n  await checkpointDecodeControl.run();\n}",
  );
  const cases = browser.slice(
    browser.indexOf("const cases = {"),
    browser.indexOf("/** @browserEntry"),
  );
  expect(cases.match(/^  checkpointDecodeBounds,$/gm)).toHaveLength(1);
  expect(browser.split("checkpointDecodeControl.run()").length - 1).toBe(1);
  const units = await Bun.file(new URL("indexeddb-checkpoint-decode.test.ts", import.meta.url)).text();
  expect(units).not.toContain("BrowserRunnerLifecycle");
  expect(units).not.toContain("--native");
});
