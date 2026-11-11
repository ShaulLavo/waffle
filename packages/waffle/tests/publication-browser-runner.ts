import { navigateTestPage } from "./browser-navigation.js";
import { resolve } from "node:path";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle.js";

import type { Browser, BrowserContext } from "playwright";

const startedAt = performance.now();
const nativeArgs = process.argv.slice(2).filter((argument) => argument !== "--workspace");
if (nativeArgs[0] === "ios-safari") {
  const { publicationNative } = await import("./page-runner/publication-native.js");
  process.exitCode = await publicationNative(
    process.argv.includes("--workspace") ? "workspace" : "ordinary",
    nativeArgs.slice(1),
    startedAt,
  );
} else await desktopMain();

async function desktopMain(): Promise<void> {
  const lifecycle = new BrowserRunnerLifecycle(180_000);
  const workspace = process.argv.includes("--workspace");
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
    let browser: Browser | undefined, context: BrowserContext | undefined;
    try {
      if (name === "firefox" && process.platform === "linux")
        process.env.TMPDIR = await lifecycle.directory(
          process.env.WAFFLE_BROWSER_SHM_ROOT ?? "/dev/shm",
          "waffle-ff-",
        );
      if (name === "webkit" && workspace) {
        const profile = await lifecycle.directory(lifecycle.scratch, "webkit-opfs-profile-");
        context = await lifecycle.persistent("webkit", profile);
        browser = context.browser() ?? undefined;
      } else browser = await lifecycle.launch(name);
      if (!browser) throw new Error("Persistent WebKit context has no browser");
      const page = await (context ?? browser).newPage();
      page.on("console", (message) => console.log(message.text()));
      await installDeathObserver(page);
      await navigateTestPage(page, origin);
      const passed = await page.evaluate(async (workspace) => {
        const path = "/tests.js";
        if (workspace) {
          const fixture: typeof import("./workspace-browser.js") = await import(path);
          return fixture.runWorkspaceBrowser();
        }
        const fixture: typeof import("./publication-browser.js") = await import(path);
        return fixture.runPublicationBrowser();
      }, workspace);
      console.log(
        `${name} ${browser.version()}: ${passed.length} local publication controls passed`,
      );
      for (const label of passed) console.log(`  PASS ${label}`);
    } finally {
      try {
        if (context) await lifecycle.closeContext(context);
        else if (browser) await lifecycle.closeBrowser(browser);
      } finally {
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
      }
    }
  }
  try {
    await lifecycle.init();
    const origin = lifecycle.serve({
      "/": "<!doctype html><title>Local publication controls</title>",
      "/tests.js": await browserBundle(
        resolve(import.meta.dir, workspace ? "workspace-browser.ts" : "publication-browser.ts"),
      ),
      "/fs-worker.js": await browserBundle(resolve(import.meta.dir, "../browser/fs-worker.ts")),
      "/read-worker.js": await browserBundle(
        resolve(import.meta.dir, "workspace-vfs-read-browser.ts"),
      ),
      "/guest.js": await browserBundle(resolve(import.meta.dir, "fixtures/publication-guest.ts")),
    });
    const names = process.argv.slice(2).filter((argument) => argument !== "--workspace");
    for (const name of names.length ? names : ["chromium"]) await run(name, origin);
  } finally {
    await lifecycle.close();
  }
}
