import type { Page, Browser } from "playwright";
import type { BrowserRunnerLifecycle } from "./browser-runner-lifecycle.js";
import { navigateTestPage } from "./browser-navigation.js";
import { encodeCrossTabValue, decodeCrossTabValue } from "./page-runner/cross-tab-value.js";

export type CrossTabPage = {
  evaluate<R, A = undefined>(body: (arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  waitForFunction<A = undefined>(body: (arg: A) => unknown, arg?: A): Promise<void>;
  addInitScript(body: () => void): Promise<void>;
  observeDeaths(): Promise<void>;
  navigate(origin: string): Promise<void>;
  close(): Promise<void>;
};
export type CrossTabContext = {
  newPage(): Promise<CrossTabPage>;
  close(): Promise<void>;
};
export type CrossTabBrowser = {
  newContext(): Promise<CrossTabContext>;
  version(): string;
};
export type CrossTabLifecycle = {
  launch(name: string): Promise<CrossTabBrowser>;
  closeBrowser(browser: CrossTabBrowser): Promise<void>;
};

function desktopPage(page: Page): CrossTabPage {
  page.on("console", (message) => console.log(message.text()));
  page.on("pageerror", (error) => console.error(error));
  return {
    evaluate: (body, arg) =>
      page.evaluate(
        `(${body.toString()})((${decodeCrossTabValue.toString()})(${JSON.stringify(encodeCrossTabValue(arg))}))`,
      ),
    waitForFunction: async (body, arg) => {
      await page.waitForFunction(
        `(${body.toString()})((${decodeCrossTabValue.toString()})(${JSON.stringify(encodeCrossTabValue(arg))}))`,
      );
    },
    addInitScript: async (body) => {
      await page.addInitScript(body);
    },
    async observeDeaths() {
      const deaths = new Map<string, Promise<void>>();
      page.on("worker", (worker) => {
        const closed = Promise.withResolvers<void>();
        worker.once("close", () => closed.resolve());
        deaths.set(worker.url(), closed.promise);
      });
      await page.exposeFunction("__publicationWaitForClose", async (url: string) => {
        const death = deaths.get(url);
        if (!death) throw new Error(`Worker not observed natively ${url}`);
        await death;
      });
    },
    navigate: async (origin) => {
      await navigateTestPage(page, origin);
    },
    close: () => page.close(),
  };
}

export function desktopCrossTabLifecycle(lifecycle: BrowserRunnerLifecycle): CrossTabLifecycle {
  const browsers = new Map<CrossTabBrowser, Browser>();
  return {
    async launch(name) {
      if (name !== "chromium" && name !== "firefox" && name !== "webkit")
        throw new Error(`unknown engine ${name}`);
      const browser = await lifecycle.launch(name);
      const binding: CrossTabBrowser = {
        version: () => browser.version(),
        async newContext() {
          const context = await browser.newContext();
          return {
            newPage: async () => desktopPage(await context.newPage()),
            close: () => context.close(),
          };
        },
      };
      browsers.set(binding, browser);
      return binding;
    },
    async closeBrowser(binding) {
      const browser = browsers.get(binding);
      if (!browser) throw new Error("Unowned cross-tab browser");
      await lifecycle.closeBrowser(browser);
    },
  };
}
