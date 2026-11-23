import { resolve } from "node:path";
import {
  BrowserRunnerLifecycle,
  browserBundle,
  engines,
} from "../testing/browser-runner-lifecycle.js";
import { navigateTestPage } from "../testing/browser-navigation.js";

const lifecycle = new BrowserRunnerLifecycle(120_000);
const sources = {
  "/cases.js": "notification-fairness-cases.ts",
  "/traffic.js": "fixtures/notification-traffic-worker.ts",
  "/probe.js": "fixtures/notification-probed-worker.ts",
  "/guest.js": "fixtures/notification-deadline-worker.ts",
  "/helper.js": "../browser/notification-worker.ts",
};
function isEngine(value: string): value is keyof typeof engines {
  return Object.hasOwn(engines, value);
}
async function prove(name: keyof typeof engines, origin: string): Promise<void> {
  const browser = await lifecycle.launch(name);
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.error(error));
    await navigateTestPage(page, origin);
    console.log(
      JSON.stringify({
        engine: name,
        waitAsync: await page.evaluate(() => typeof Atomics.waitAsync),
      }),
    );
    const result = await page.evaluate(async () => {
      const path = "/cases.js";
      const cases: typeof import("./notification-fairness-cases.js") = await import(path);
      const url = (file: string) => new URL(file, location.href).href;
      return cases.notificationFairnessCases({
        traffic: url("/traffic.js"),
        probe: url("/probe.js"),
        helper: url("/helper.js"),
        guest: url("/guest.js"),
      });
    });
    console.log(JSON.stringify({ engine: name, version: browser.version(), result }));
  } finally {
    await lifecycle.closeBrowser(browser);
  }
}
try {
  await lifecycle.init();
  console.log(
    JSON.stringify({
      resources: "notification-fairness",
      scratch: lifecycle.scratch,
      sources: Object.keys(sources),
    }),
  );
  const routes: Record<string, Blob | string> = {
    "/": "<!doctype html><title>Notification fairness</title>",
  };
  for (const [path, source] of Object.entries(sources))
    routes[path] = await browserBundle(resolve(import.meta.dir, source));
  const origin = lifecycle.serve(routes);
  const names = process.argv.length > 2 ? process.argv.slice(2) : ["chromium", "firefox", "webkit"];
  for (const name of names) {
    if (!isEngine(name)) throw new Error(`unknown browser engine ${name}`);
    await prove(name, origin);
  }
} finally {
  await lifecycle.close();
}
