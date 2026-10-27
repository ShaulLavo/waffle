import { test } from "bun:test";
import { runBrowserSuite } from "../scripts/browser-command.ts";
import { runNetworkBrowser } from "./network-browser-runner.js";

// Run through the existing subreaper without adding browsers to ordinary package unit tests.
const browserTest = process.env.WAFFLE_NETWORK_BROWSER === "1" ? test : test.skip;
browserTest(
  "real browser workers share localhost and service-worker preview HTTP",
  async () => {
    if (typeof runNetworkBrowser !== "function") throw Error("Missing network browser runner");
    await runBrowserSuite(
      [process.execPath, import.meta.dir + "/network-browser-runner.ts"].concat(
        (process.env.NETWORK_BROWSERS ?? "chromium").split(","),
      ),
      {
        cwd: import.meta.dir + "/..",
        env: process.env,
      },
    );
  },
  600_000,
);
