import { join } from "node:path";
import { withStorageCleanup } from "../storage-allocation.js";
import { runControlProcess } from "./browser-controls-runner.js";
import { checkControl } from "./browser-controls-suite.js";

const [mode, argument, resultPath] = process.argv.slice(2);
if (!mode || !resultPath) throw new Error("Expected mode and result path");

if (mode === "supervise") {
  if (!argument) throw new Error("Expected child mode");
  const command =
    argument === "spawn-failure"
      ? ["/nonexistent-waffle-browser-controls-command"]
      : [process.execPath, join(import.meta.dir, "browser-controls-process-fixture.ts"), argument];
  process.exitCode = await runControlProcess(command, resultPath);
} else {
  const results = { path: resultPath, controls: [] };
  if (mode === "inherited") process.exitCode = 23;
  await checkControl(
    "synthetic",
    mode,
    async () => {
      if (mode === "verdict-failure") throw new TypeError("CONTROL_ASSERTION");
    },
    results,
  );
  if (mode === "verdict-failure") process.exitCode = 1;
  if (mode === "top-level") throw new Error("CONTROL_TOP_LEVEL", { cause: "ORIGINAL_CAUSE" });
  if (mode === "cleanup")
    await withStorageCleanup(
      async () => {
        throw new TypeError("CONTROL_PRIMARY");
      },
      async () => {
        throw new RangeError("CONTROL_CLEANUP");
      },
    );
  if (mode === "unhandled") {
    process.on("exit", (code) => console.log(`CONTROL_EXIT_EVENT_${code}`));
    void Promise.reject(new Error("CONTROL_UNHANDLED", { cause: "UNHANDLED_CAUSE" }));
    await Bun.sleep(20);
  }
  if (mode === "forwarded-signal") {
    const received = new Promise<void>((resolve) => {
      process.once("SIGTERM", () => {
        console.error("CONTROL_SIGNAL_FORWARDED");
        resolve();
      });
    });
    process.kill(process.ppid, "SIGTERM");
    await received;
  }
  if (mode === "abrupt") process.exit(17);
  if (mode === "signal") process.kill(process.pid, "SIGTERM");
}
