import { resolve } from "node:path";
import {
  prepareWorkspaceSafari,
  serveWorkspaceSafari,
} from "../tooling/workspace-safari-runner.js";
import { BrowserRunnerLifecycle } from "./browser-runner-lifecycle.js";

export async function runWorkspaceSafariLocal(): Promise<void> {
  const lifecycle = new BrowserRunnerLifecycle(180_000);
  let server: ReturnType<typeof serveWorkspaceSafari> | undefined;
  try {
    await lifecycle.init();
    const directory = resolve(lifecycle.scratch, "public-package");
    await prepareWorkspaceSafari(directory);
    server = serveWorkspaceSafari(directory);
    const browser = await lifecycle.launch("chromium");
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    const report = await page.evaluate(async () => {
      const path = "/browser.js";
      const fixture: typeof import("./workspace-safari-browser.js") = await import(path);
      return fixture.runWorkspaceSafari();
    });
    console.log(
      JSON.stringify({ runtime: "local Chromium control, not Safari proof", report }, null, 2),
    );
  } finally {
    await server?.stop(true);
    await lifecycle.close();
  }
}
if (import.meta.main) await runWorkspaceSafariLocal();
