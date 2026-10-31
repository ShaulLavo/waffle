import { existsSync } from "node:fs";
import { BrowserRunnerLifecycle, browserBundle, engines } from "./browser-runner-lifecycle.js";

export async function runSafeStagingNative(engine: string, control?: string): Promise<void> {
  if (!(engine in engines)) throw new Error(`Unknown staging test engine ${engine}`);
  const lifecycle = new BrowserRunnerLifecycle(180_000);
  let removed = false;
  try {
    await lifecycle.init();
    const bundle = await browserBundle("tests/safe-staging-browser.ts");
    const origin = lifecycle.serve({
      "/": "<!doctype html><title>Staged storage fixture</title>",
      "/test.js": bundle,
    });
    const browser = await lifecycle.launch(engine as keyof typeof engines);
    const page = await browser.newPage();
    page.on("console", (message) => console.log(message.text()));
    await page.goto(origin);
    const passed = await page.evaluate(async (selected) => {
      const path = "/test.js";
      const fixture: typeof import("./safe-staging-browser.js") = await import(path);
      return fixture.safeStagingNative(selected);
    }, control);
    console.log(JSON.stringify({ engine, browser: browser.version(), passed }));
  } finally {
    await lifecycle.close();
    removed = !existsSync(lifecycle.scratch);
    console.log(JSON.stringify({ phase: "cleanup", scratch: lifecycle.scratch, removed }));
  }
  if (!removed) throw new Error("Owned staging fixture scratch remains");
}
