import { BrowserRunnerLifecycle, browserBundle } from "../tests/browser-runner-lifecycle.js";

const lifecycle = new BrowserRunnerLifecycle(180_000);
try {
  await lifecycle.init();
  const [controls, deadWriter, crash] = await Promise.all([
    browserBundle(import.meta.dir + "/checkpoint-controls.ts"),
    browserBundle(import.meta.dir + "/checkpoint-dead-writer.ts"),
    browserBundle(import.meta.dir + "/checkpoint-crash-before.ts"),
  ]);
  const origin = lifecycle.serve({
    "/": '<!doctype html><script type="module" src="/controls.js"></script>',
    "/controls.js": controls,
    "/dead-writer.js": deadWriter,
    "/crash-before-checkpoint.js": crash,
  });
  const profile = await lifecycle.directory(lifecycle.scratch, "controls-");
  const browser = await lifecycle.persistent("chromium", profile);
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error));
  await page.goto(origin);
  const result = await page.evaluate<unknown>("globalThis.checkpointControls()");
  console.log(JSON.stringify(result));
  await lifecycle.closeContext(browser);
} finally {
  await lifecycle.close();
}
