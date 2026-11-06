import { BrowserRunnerLifecycle, engines } from "./browser-runner-lifecycle.js";
import type { Browser, Page } from "playwright";
import { navigateTestPage } from "./browser-navigation.js";

const lifecycle = new BrowserRunnerLifecycle();
const observed = new Set<string>();
const served = new Map<string, boolean>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    served.set(request.url, observed.has(request.url));
    return new Response("<!doctype html><title>Navigation admission</title>", {
      status: new URL(request.url).pathname === "/error" ? 503 : 200,
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    });
  },
});

async function verifyNavigation(browser: Browser, index: number): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const url = `${server.url}${index === 9 ? "error" : index}`;
    await verifyDocument(page, url, index === 9 ? 503 : 200, browser.browserType().name());
  } finally {
    await context.close();
  }
}

async function verifyDocument(
  page: Page,
  url: string,
  status: number,
  engine: string,
): Promise<void> {
  observed.delete(url);
  served.delete(url);
  page.on("request", (request) => observed.add(request.url()));
  const response = await navigateTestPage(page, url);
  if (engine === "webkit" && served.get(url) !== true)
    throw new Error("COOP response reached WebKit before navigation request admission");
  if (response?.status() !== status) throw new Error("Navigation changed the real server response");
  if (!(await page.evaluate(() => crossOriginIsolated)))
    throw new Error("Navigation lost cross-origin isolation");
}

async function verifyPersistent(): Promise<void> {
  const profile = await lifecycle.directory(lifecycle.scratch, "p-");
  const context = await lifecycle.persistent("webkit", profile);
  try {
    await verifyDocument(await context.newPage(), `${server.url}persistent`, 200, "webkit");
  } finally {
    await lifecycle.closeContext(context);
  }
}

async function verifyExistingRoute(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const url = `${server.url}aborted`;
    await page.route(url, (route) => route.abort("failed"));
    const result = await navigateTestPage(page, url).then(
      () => "loaded",
      () => "rejected",
    );
    if (result !== "rejected" || served.has(url))
      throw new Error("Navigation bypassed the existing request handler");
  } finally {
    await context.close();
  }
}

async function verifyEngine(engine: string): Promise<void> {
  if (!isEngine(engine)) throw new Error(`Unknown browser: ${engine}`);
  const browser = await lifecycle.launch(engine);
  try {
    for (let index = 0; index < 10; index++) await verifyNavigation(browser, index);
    await verifyExistingRoute(browser);
    console.log(JSON.stringify({ engine, navigationAdmission: 10 }));
  } finally {
    await lifecycle.closeBrowser(browser);
  }
  if (engine === "webkit") await verifyPersistent();
}

function isEngine(value: string): value is keyof typeof engines {
  return Object.hasOwn(engines, value);
}

try {
  await lifecycle.init();
  for (const engine of process.argv.slice(2)) await verifyEngine(engine);
} finally {
  server.stop(true);
  await lifecycle.close();
}
