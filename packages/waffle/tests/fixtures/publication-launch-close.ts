import { mock, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { BrowserRunnerLifecycle, engines } from "../browser-runner-lifecycle.ts";
import type { BrowserContext } from "playwright";

const mode = process.argv[2];
const creation = Promise.withResolvers<BrowserContext>();
let profile = "";
let scratch = "";
let shutdown: Promise<void> | undefined;
let closeCalls = 0;
let runnerRejected = false;
const resource = {
  browser: () => null,
  close: async () => {
    closeCalls++;
    if (mode !== "confirmed") throw new Error("Unconfirmed context closure");
  },
};
const launch = spyOn(engines.webkit, "launchPersistentContext").mockImplementation(
  () => creation.promise,
);
class ControlledLifecycle extends BrowserRunnerLifecycle {
  constructor() {
    super(60_000, 5, undefined, "caller");
  }
  override async persistent(
    ...args: Parameters<BrowserRunnerLifecycle["persistent"]>
  ): Promise<BrowserContext> {
    profile = args[1];
    scratch = this.scratch;
    const pending = super.persistent(...args);
    if (mode !== "assigned") {
      shutdown = this.close();
      void shutdown.catch(() => {});
    }
    // Fault-inject only Playwright's external allocation boundary.
    creation.resolve(resource as unknown as BrowserContext);
    return pending;
  }
}
mock.module(resolve(import.meta.dir, "../browser-runner-lifecycle.ts"), () => ({
  BrowserRunnerLifecycle: ControlledLifecycle,
  browserBundle: async () => new Blob(["Fixture must not be evaluated"]),
}));
process.argv = [process.execPath, "publication-browser-runner.ts", "--workspace", "webkit"];
try {
  try {
    await import("../publication-browser-runner.ts");
  } catch {
    runnerRejected = true;
  }
  await shutdown?.catch(() => {});
  console.log(JSON.stringify({ retained: existsSync(profile), closeCalls, runnerRejected }));
} finally {
  launch.mockRestore();
  // No real consumer was created. The injected close has actually settled.
  if (scratch) await rm(scratch, { recursive: true, force: true });
}
