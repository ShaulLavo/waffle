import { resolve } from "node:path";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle.js";

const lifecycle = new BrowserRunnerLifecycle(180_000);
async function installDeathObserver(page: import("playwright").Page): Promise<void> {
  const deaths = new Map<string, Promise<void>>();
  page.on("worker", (worker) => {
    const closed = Promise.withResolvers<void>();
    worker.once("close", () => closed.resolve());
    deaths.set(worker.url(), closed.promise);
  });
  await page.exposeFunction("__publicationWaitForClose", async (url: string) => {
    const closed = deaths.get(url);
    if (!closed) throw new Error(`Worker was not observed by the browser: ${url}`);
    await closed;
  });
}
async function run(name: string, origin: string): Promise<void> {
  if (name !== "chromium" && name !== "firefox" && name !== "webkit")
    throw new Error(`Unknown browser: ${name}`);
  const previousTmp = process.env.TMPDIR;
  if (name === "firefox" && process.platform === "linux")
    process.env.TMPDIR = await lifecycle.directory(
      process.env.WAFFLE_BROWSER_SHM_ROOT ?? "/dev/shm",
      "waffle-ff-",
    );
  const browser = await lifecycle.launch(name);
  try {
    const page = await browser.newPage();
    await installDeathObserver(page);
    await page.goto(origin);
    const passed = await page.evaluate(async () => {
      const path = "/tests.js";
      const fixture: typeof import("./publication-browser.js") = await import(path);
      return fixture.runPublicationBrowser();
    });
    console.log(`${name} ${browser.version()}: ${passed.length} local publication controls passed`);
    for (const label of passed) console.log(`  PASS ${label}`);
  } finally {
    await lifecycle.closeBrowser(browser);
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
  }
}
try {
  await lifecycle.init();
  const origin = lifecycle.serve({
    "/": "<!doctype html><title>Local publication controls</title>",
    "/tests.js": await browserBundle(resolve(import.meta.dir, "publication-browser.ts")),
    "/fs-worker.js": await browserBundle(resolve(import.meta.dir, "../browser/fs-worker.ts")),
    "/guest.js": await browserBundle(resolve(import.meta.dir, "fixtures/publication-guest.ts")),
  });
  const names = process.argv.slice(2);
  for (const name of names.length ? names : ["chromium"]) await run(name, origin);
} finally {
  await lifecycle.close();
}
