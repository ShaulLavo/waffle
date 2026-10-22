import { existsSync } from "node:fs";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle.js";

const lifecycle = new BrowserRunnerLifecycle(300_000);
let scratchRemoved = false;
try {
  await lifecycle.init();
  console.log(JSON.stringify({ phase: "setup", ownedScratch: lifecycle.scratch, port: 46431 }));
  const bundle = await browserBundle("tests/indexeddb-chunks-browser.ts");
  const origin = lifecycle.serve(
    { "/": "<!doctype html><title>IndexedDB chunk controls</title>", "/tests.js": bundle },
    46431,
  );
  const browser = await lifecycle.launch("chromium");
  console.log(JSON.stringify({ browser: "chromium", version: browser.version() }));
  const page = await browser.newPage();
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const path = "/tests.js";
    const suite = await import(path);
    return {
      chunks: await suite.indexedDBChunkControls(),
      existing: await suite.indexedDBExistingControls(),
    };
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await lifecycle.close();
  scratchRemoved = !existsSync(lifecycle.scratch);
  console.log(
    JSON.stringify({ phase: "cleanup", ownedScratch: lifecycle.scratch, removed: scratchRemoved }),
  );
}
if (!scratchRemoved) throw new Error("Owned native test scratch was not removed");
