import { resolve } from "node:path";
import type { BrowserContext } from "playwright";
import { BrowserRunnerLifecycle, browserBundle } from "../tests/browser-runner-lifecycle.js";
import {
  quotaCases,
  type QuotaCase,
  type QuotaReceipt,
  type runQuotaCase,
} from "../tests/storage-quota-r2-browser.js";
import type { AdapterKind } from "../tests/storage-quota-r2-probes.js";

type Cell = { backend: AdapterKind; cell: QuotaCase };
export function quotaMatrix(): Cell[] {
  return (["indexeddb", "opfs"] as const)
    .flatMap<Cell>((backend) => quotaCases.map((cell) => ({ backend, cell })))
    .concat([{ backend: "opfs", cell: "cleanup-retry" }]);
}
function workerMain(): void {
  globalThis.onmessage = async (event: MessageEvent<Cell>) => {
    try {
      const path = "/quota.js";
      const module: { runQuotaCase: typeof runQuotaCase } = await import(path);
      globalThis.postMessage({
        result: await module.runQuotaCase(event.data.backend, event.data.cell),
      });
    } catch (error) {
      globalThis.postMessage({ error: String(error) });
    }
  };
}
function pageRequest(cell: Cell): Promise<QuotaReceipt> {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/worker.js", { type: "module" });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("quota cell exceeded 90 second deadline"));
    }, 90_000);
    const stop = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    worker.onmessage = (
      event: MessageEvent<{ error?: string; result: QuotaReceipt; progress?: unknown }>,
    ) => {
      if (event.data.progress) {
        console.log(JSON.stringify(event.data.progress));
        return;
      }
      stop();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.result);
    };
    worker.onerror = (event) => {
      stop();
      reject(new Error(event.message));
    };
    worker.onmessageerror = () => {
      stop();
      reject(new Error("quota worker response decode failed"));
    };
    worker.postMessage(cell);
  });
}
async function runCell(context: BrowserContext, origin: string, cell: Cell): Promise<QuotaReceipt> {
  const page = await context.newPage();
  page.setDefaultTimeout(100_000);
  page.on("console", (message) =>
    console.log(JSON.stringify({ kind: "quota-progress", ...cell, observation: message.text() })),
  );
  try {
    await page.goto(origin);
    return await page.evaluate(pageRequest, cell);
  } finally {
    await page.close();
  }
}
/** @public */
export async function runQuotaMatrix(selected: string[]): Promise<void> {
  const lifecycle = new BrowserRunnerLifecycle(600_000);
  const failures: string[] = [];
  try {
    await lifecycle.init();
    const origin = lifecycle.serve({
      "/": "<!doctype html><title>Quota reclamation fixture</title>",
      "/quota.js": await browserBundle(
        resolve(import.meta.dir, "../tests/storage-quota-r2-browser.ts"),
      ),
      "/worker.js": `(${workerMain.toString()})();`,
    });
    for (const engine of selected) await runEngine(lifecycle, origin, engine, failures);
  } finally {
    await lifecycle.close();
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} quota cells failed`);
}
async function runEngine(
  lifecycle: BrowserRunnerLifecycle,
  origin: string,
  engine: string,
  failures: string[],
): Promise<void> {
  if (engine !== "chromium" && engine !== "firefox" && engine !== "webkit")
    throw new Error(`Unknown browser ${engine}`);
  const profile = await lifecycle.directory(lifecycle.scratch, `${engine}-quota-`);
  const context = await lifecycle.persistent(engine, profile);
  try {
    for (const cell of quotaMatrix()) await collectCell(context, origin, engine, cell, failures);
  } finally {
    await lifecycle.closeContext(context);
    await lifecycle.removeDirectory(profile);
  }
}
async function collectCell(
  context: BrowserContext,
  origin: string,
  engine: string,
  cell: Cell,
  failures: string[],
): Promise<void> {
  try {
    const result = await runCell(context, origin, cell);
    console.log(JSON.stringify({ engine, ...result }));
    if (result.failures.length || !result.cleanup)
      failures.push(`${engine} ${cell.backend} ${cell.cell}: ${result.failures.join("; ")}`);
  } catch (error) {
    const failure = `${engine} ${cell.backend} ${cell.cell}: ${String(error)}`;
    failures.push(failure);
    console.error(JSON.stringify({ engine, ...cell, controllerFailure: String(error) }));
  }
}
if (import.meta.main)
  await runQuotaMatrix(
    process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "firefox", "webkit"],
  );
