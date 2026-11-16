import { join } from "node:path";
import { runBrowserSuite } from "../scripts/browser-command.js";

if (process.argv.slice(2).join(" ") !== "webkit")
  throw new Error("Bootstrap arrival controls require webkit");
await runBrowserSuite(
  [
    process.execPath,
    "test",
    join(import.meta.dir, "page-runner/bootstrap-arrival-browser.test.ts"),
  ],
  {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, BOOTSTRAP_ARRIVAL_BROWSER_CONTROLS: "1" },
  },
);
