import { navigateTestPage } from "./browser-navigation.js";
if (process.argv[2] === "ios-safari") {
  const { nativeMain } = await import("./page-runner/native.js");
  const { commandAdapter } = await import("./page-runner/command-suites.js");
  process.exit(await nativeMain(commandAdapter("guest-watch"), process.argv.slice(3), {}));
}
import { resolve } from "node:path";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle.js";

const engines = ["chromium", "firefox", "webkit"] as const;
const isEngine = (name: string): name is (typeof engines)[number] =>
  engines.some((engine) => engine === name);
const names = process.argv.length > 2 ? process.argv.slice(2) : ["chromium"];
const lifecycle = new BrowserRunnerLifecycle(120_000);

async function proveRelay(page: import("playwright").Page): Promise<void> {
  const relay = await page.evaluate(async () => {
    const path = "/race.js";
    const cases: typeof import("./notification-race-cases.js") = await import(path);
    return cases.notificationRelayRaceCase(new URL("/helper.js", location.href).href);
  });
  console.log(JSON.stringify({ engine: "webkit", relay }));
}

async function prove(name: (typeof engines)[number], origin: string): Promise<void> {
  const browser = await lifecycle.launch(name);
  try {
    const page = await browser.newPage();
    await navigateTestPage(page, origin);
    const result = await page.evaluate(async () => {
      const path = "/cases.js";
      const cases: typeof import("./guest-watch-browser-cases.js") = await import(path);
      const url = (file: string) => new URL(file, location.href).href;
      return cases.guestWatchCase(url("/guest.js"), url("/helper.js"), url("/writer.js"));
    });
    if (result.early + result.late !== 200) throw new Error("guest watch proof did not finish");
    if (name === "webkit") await proveRelay(page);
    console.log(JSON.stringify({ engine: name, version: browser.version(), result }));
  } finally {
    await lifecycle.closeBrowser(browser);
  }
}

try {
  await lifecycle.init();
  const origin = lifecycle.serve({
    "/": "<!doctype html><title>Guest filesystem watch</title>",
    "/cases.js": await browserBundle(resolve(import.meta.dir, "guest-watch-browser-cases.ts")),
    "/race.js": await browserBundle(resolve(import.meta.dir, "notification-race-cases.ts")),
    "/guest.js": await browserBundle(
      resolve(import.meta.dir, "fixtures/guest-watch-runtime-worker.ts"),
    ),
    "/writer.js": await browserBundle(
      resolve(import.meta.dir, "fixtures/guest-watch-writer-worker.ts"),
    ),
    "/helper.js": await browserBundle(
      resolve(import.meta.dir, "../browser/notification-worker.ts"),
    ),
  });
  for (const name of names) {
    if (!isEngine(name)) throw new Error(`unknown browser engine ${name}`);
    await prove(name, origin);
  }
} finally {
  await lifecycle.close();
}
