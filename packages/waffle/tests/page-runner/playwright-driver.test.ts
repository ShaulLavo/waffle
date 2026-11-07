import { expect, spyOn, test } from "bun:test";
import { BrowserRunnerLifecycle } from "../browser-runner-lifecycle.js";
import { PlaywrightDriver } from "./playwright-driver.js";

test("browser temporary roots are siblings of host scratch under a CI supervisor", async () => {
  const root = "/home/runner/work/_temp/wb-123456";
  let requested: string | undefined;
  const init = spyOn(BrowserRunnerLifecycle.prototype, "init").mockImplementation(async (value) => {
    requested = value;
    throw new Error("Stopped at the owned allocation boundary");
  });
  const driver = new PlaywrightDriver("chromium", `${root}/w-pr-123456`);
  try {
    await expect(driver.start(AbortSignal.timeout(1000))).rejects.toThrow("allocation boundary");
    expect(requested).toBe(root);
  } finally {
    await driver.stop();
    init.mockRestore();
  }
});
