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
