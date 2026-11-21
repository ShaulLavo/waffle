import { strict as assert } from "node:assert";
import {
  BrowserRunnerLifecycle,
  engines,
} from "../../packages/waffle/tests/browser-runner-lifecycle.js";
import { navigateTestPage } from "../../packages/waffle/tests/browser-navigation.js";
import { prepare } from "./prepare.js";

type Engine = keyof typeof engines;
type RecordingPage = typeof globalThis & { ordinarySurfaceDone(): Promise<void> };

function isEngine(value: string): value is Engine {
  return Object.hasOwn(engines, value);
}

async function verify(
  runner: BrowserRunnerLifecycle,
  engine: Engine,
  url: string,
  requests: string[],
) {
  const browser = await runner.launch(engine);
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    const start = requests.length;
    await page.exposeFunction("ordinarySurfaceDone", () => {
      assert(
        !requests
          .slice(start)
          .some((path) => path === "/wit-surface-adapter.js" || path === "/generated.wasm"),
      );
    });
    await navigateTestPage(page, url);
    const evidence = await page.evaluate(async () => {
      const path = "/page.js";
      const { run }: typeof import("./scenarios.js") = await import(path);
      return run(() => (globalThis as RecordingPage).ordinarySurfaceDone());
    });
    assert.deepEqual(pageErrors, []);
    const fetched = requests.slice(start);
    assert(fetched.includes("/wit-surface-adapter.js"));
    return { engine, browser: browser.version(), requests: fetched, evidence };
  } finally {
    await runner.closeBrowser(browser);
  }
}

const selected = process.argv.slice(2);
const names = selected.length ? selected : ["chromium"];
const runner = new BrowserRunnerLifecycle();
try {
  await runner.init();
  const { imports, bytes, routes } = await prepare(runner.scratch);
  const requests: string[] = [];
  const url = runner.serve(routes, 0, () => (event) => {
    if (event.kind === "request") requests.push(event.path);
  });
  for (const name of names) {
    if (!isEngine(name)) throw new Error(`Unknown browser engine ${name}`);
    const verified = await verify(runner, name, url, requests);
    console.log(JSON.stringify({ imports, bytes, ...verified }));
  }
} finally {
  await runner.close();
}
