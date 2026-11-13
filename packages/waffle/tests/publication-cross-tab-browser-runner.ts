import { BrowserRunnerLifecycle } from "./browser-runner-lifecycle.js";
import { crossTabAssets } from "./publication-cross-tab-assets.js";
import { crossTabCommand } from "./publication-cross-tab-command.js";
import { desktopCrossTabLifecycle } from "./publication-cross-tab-host.js";
import { crossTabTimeoutMs } from "./publication-cross-tab-inventory.js";

const startedAt = performance.now();
if (process.argv[2] === "ios-safari") {
  const { crossTabNative } = await import("./page-runner/publication-cross-tab-native.js");
  process.exitCode = await crossTabNative(process.argv.slice(3), startedAt);
} else await desktopMain();

async function desktopMain(): Promise<void> {
  const lifecycle = new BrowserRunnerLifecycle(crossTabTimeoutMs);
  const command = crossTabCommand(desktopCrossTabLifecycle(lifecycle));
  try {
    await lifecycle.init();
    const origin = lifecycle.serve(
      {
        "/": "<!doctype html><title>Private resident controls</title>",
        ...(await crossTabAssets()),
      },
      Number(process.env.PUBLICATION_CROSS_TAB_PORT ?? 0),
    );
    const cleanupOnly = process.argv.includes("--workspace-cleanup-only");
    const persistentOnly = process.argv.includes("--persistent-owner-only");
    const names = process.argv
      .slice(2)
      .filter((name) => name !== "--persistent-owner-only" && name !== "--workspace-cleanup-only");
    for (const name of names.length ? names : ["chromium"]) {
      if (cleanupOnly) await command.runWorkspaceCleanup(name, origin);
      else await command.run(name, origin, persistentOnly);
    }
  } finally {
    await lifecycle.close();
  }
}
