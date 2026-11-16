import { join } from "node:path";
import { runBrowserSuite } from "../scripts/browser-command.js";
import { runOwned } from "../scripts/owned-command.js";

if (process.argv.slice(2).join(" ") !== "webkit")
  throw new Error("Bootstrap arrival controls require webkit");
// The matrix supervisor already owns detached descendants and its shared-memory scratch.
const run = process.env.WAFFLE_BROWSER_SHM_ROOT ? runOwned : runBrowserSuite;
await run(
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
