import { resolve } from "node:path";
import type { Browser, Worker as BrowserWorker } from "playwright";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle.js";
import type { runOpfsRangeBrowser } from "./opfs-range-browser.js";

type Receipt = Awaited<ReturnType<typeof runOpfsRangeBrowser>>;

function workerMain() {
  globalThis.onmessage = async () => {
    try {
      const path = "/range.js";
      const module: { runOpfsRangeBrowser: typeof runOpfsRangeBrowser } = await import(path);
      globalThis.postMessage({ result: await module.runOpfsRangeBrowser() });
    } catch (error) {
      globalThis.postMessage({ error: String(error) });
    }
  };
}
function pageRequest(): Promise<Receipt> {
  return new Promise<Receipt>((resolve, reject) => {
    const worker = new Worker("/worker.js", { type: "module" });
    worker.onmessage = (event: MessageEvent<{ error?: string; result: Receipt }>) => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.result);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.onmessageerror = () => {
      worker.terminate();
      reject(new Error("Range worker response decode failed"));
    };
    worker.postMessage(null);
  });
}
function observe(worker: BrowserWorker) {
  const closed = Promise.withResolvers<void>();
  const record = { closed: false, joined: closed.promise };
  worker.once("close", () => {
    record.closed = true;
    closed.resolve();
  });
  return record;
}
async function nativeCase(browser: Browser, origin: string) {
  const workers: ReturnType<typeof observe>[] = [];
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);
    page.on("worker", (worker) => workers.push(observe(worker)));
    await page.goto(origin);
    const result = await page.evaluate(pageRequest);
    await context.close();
    await Promise.all(workers.map((worker) => worker.joined));
    if (workers.length !== 1 || !workers.every((worker) => worker.closed))
      throw new Error("Exact original worker close unobserved");
    return result;
  } finally {
    await context.close();
  }
}
async function run() {
  const lifecycle = new BrowserRunnerLifecycle(90_000);
  try {
    await lifecycle.init();
    const scratch = lifecycle.scratch;
    const origin = lifecycle.serve({
      "/": "<!doctype html><title>OPFS ranges</title>",
      "/worker.js": `(${workerMain.toString()})();`,
      "/range.js": await browserBundle(resolve(import.meta.dir, "opfs-range-browser.ts")),
    });
    const browser = await lifecycle.launch("chromium");
    const result = await nativeCase(browser, origin);
    console.log(
      JSON.stringify({ browser: browser.version(), scratch, result, originalWorkerClosed: true }),
    );
  } finally {
    await lifecycle.close();
    console.log("OPFS range runner lifecycle cleanup complete");
  }
}
await run();
