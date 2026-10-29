import { resolve } from "node:path";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle.js";

const lifecycle = new BrowserRunnerLifecycle(60_000);
try {
  await lifecycle.init();
  const origin = lifecycle.serve({
    "/": "<!doctype html><title>Filesystem socket attachment</title>",
    "/socket-attachment.js": await browserBundle(
      resolve(import.meta.dir, "fs-socket-attachment-browser.ts"),
    ),
    "/fs-worker.js": await browserBundle(resolve(import.meta.dir, "../browser/fs-worker.ts")),
  });
  const browser = await lifecycle.launch("firefox");
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    const passed = await page.evaluate(async () => {
      const path = "/socket-attachment.js";
      const module: typeof import("./fs-socket-attachment-browser.js") = await import(path);
      return module.socketAttachmentCases();
    });
    console.log(JSON.stringify({ engine: "firefox", version: browser.version(), passed }));
  } finally {
    await lifecycle.closeBrowser(browser);
  }
} finally {
  await lifecycle.close();
}
