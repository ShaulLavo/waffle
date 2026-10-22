import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle.js";

const lifecycle = new BrowserRunnerLifecycle(300_000);
try {
  await lifecycle.init();
  const bundle = await browserBundle("tests/indexeddb-chunks-browser.ts");
  const origin = lifecycle.serve({ "/": "<!doctype html><title>IndexedDB chunk controls</title>", "/tests.js": bundle }, 46431);
  const browser = await lifecycle.launch("chromium");
  const page = await browser.newPage();
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const path = "/tests.js";
    const suite = await import(path);
    return suite.indexedDBChunkControls();
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await lifecycle.close();
}
