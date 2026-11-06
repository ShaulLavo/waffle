import { resolve } from "node:path";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle.js";

const lifecycle = new BrowserRunnerLifecycle(120_000);
try {
  await lifecycle.init();
  const origin = lifecycle.serve({
    "/": "<!doctype html><title>Notification relay race</title>",
    "/cases.js": await browserBundle(resolve(import.meta.dir, "notification-race-cases.ts")),
    "/helper.js": await browserBundle(
      resolve(import.meta.dir, "../browser/notification-worker.ts"),
    ),
  });
  const browser = await lifecycle.launch("webkit");
  const page = await browser.newPage();
  await page.goto(origin, { waitUntil: "commit" });
  const result = await page.evaluate(async () => {
    const path = "/cases.js";
    const cases: typeof import("./notification-race-cases.js") = await import(path);
    return cases.notificationRelayRaceCase(new URL("/helper.js", location.href).href);
  });
  console.log(JSON.stringify({ engine: "webkit", version: browser.version(), result }));
} finally {
  await lifecycle.close();
}
