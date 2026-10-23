import { existsSync } from "node:fs";
import { BrowserRunnerLifecycle, browserBundle } from "../tests/browser-runner-lifecycle.js";
import { opfsCrashMatrix } from "../tests/storage-crash-r2-opfs.js";

export function crashMatrixBundle() {
  return browserBundle(new URL("../tests/storage-crash-r2-indexeddb.ts", import.meta.url).pathname);
}

async function main() {
  const lifecycle = new BrowserRunnerLifecycle(180_000);
  let removed = false;
  try {
    await lifecycle.init();
    const origin = lifecycle.serve(
      {
        "/": "<!doctype html><title>Bounded storage crash schedules</title>",
        "/tests.js": await crashMatrixBundle(),
      },
      46437,
    );
    const browser = await lifecycle.launch("chromium");
    const page = await browser.newPage();
    await page.goto(origin);
    const indexeddb = await page.evaluate(async () => {
      const path = "/tests.js";
      const suite: typeof import("../tests/storage-crash-r2-indexeddb.js") = await import(path);
      return suite.indexedDBCrashMatrix();
    });
    const opfs = await opfsCrashMatrix();
    const result = {
      browser: browser.version(),
      indexeddb,
      opfs,
      limits: [
        "FAST memory ACK is not durable flush",
        "SAFE unsupported and untested",
        "no browser-kill or physical power-loss claim",
        "bounded next E6/W8 proof, not full certification",
      ],
    };
    console.log(JSON.stringify(result, null, 2));
    if ([indexeddb, opfs].some((cells) => cells.some((cell) => !cell.ok)))
      throw new Error("Storage crash schedules failed");
  } finally {
    await lifecycle.close();
    removed = !existsSync(lifecycle.scratch);
    console.log(JSON.stringify({ phase: "cleanup", ownedScratch: lifecycle.scratch, removed }));
  }
  if (!removed) throw new Error("Owned browser scratch remains");
}

if (import.meta.main) await main();
