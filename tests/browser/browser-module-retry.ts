import assert from "node:assert/strict";
import type { Browser } from "playwright";
import { playwright, session, ready, writeFile, run } from "./playground.mjs";

const program = `
import { mkdirSync, writeFileSync } from "node:fs";
for (const retry of ["a", "b"]) {
  const dir = "retry-" + retry;
  mkdirSync(dir, { recursive: true });
  // Imports link backwards, so B must be cached before the missing import fails.
  writeFileSync(dir + "/a.mjs", 'import {missing} from "./missing.mjs"; import {b} from "./b.mjs"; export function a() { return "a"; } export const result = b() + missing;');
  writeFileSync(dir + "/b.mjs", 'import {a} from "./a.mjs"; export function b() { return a() + "b"; }');
  let failed = false;
  try { await import("./" + dir + "/a.mjs"); }
  catch (error) { if (!String(error.message).includes("missing.mjs")) throw error; failed = true; console.log("first load", retry, error.code, error.message); }
  if (!failed) throw new Error("missing import unexpectedly succeeded");
  writeFileSync(dir + "/missing.mjs", 'export const missing = ":fresh";');
  const loaded = await import("./" + dir + "/" + retry + ".mjs");
  const root = await import("./" + dir + "/a.mjs");
  if (root.result !== "ab:fresh") throw new Error("incorrect retry value " + root.result);
  if (retry === "b" && loaded.b() !== "ab") throw new Error("cached child did not recover");
  console.log("retry", retry, root.result);
}
`;

const failures: string[] = [];
const s = session("bun-wasm-module-retry-");
const deadline = setTimeout(() => { void s.cleanup().finally(() => process.exit(1)); }, 300000);
try {
  const url = await s.serve();
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"]) {
    const browser: Browser = await s.launch(playwright[name]);
    const page = await browser.newPage();
    const httpErrors: string[] = [];
    page.on("response", response => { if (response.status() >= 400 && response.url().includes("/__bunwasm/m/")) httpErrors.push(`${response.status()} sw=${response.fromServiceWorker()} ${response.url()}`); });
    await page.goto(`${url}?engine=browser`);
    assert.match(await ready(page), /ready/);
    await writeFile(page, "/home/user/module-retry.ts", program);
    const checked = await run(page, "bun run module-retry.ts");
    console.log(JSON.stringify({ browser: name, httpErrors, ...checked }));
    if (checked.code !== 0 || httpErrors.length || !["a", "b"].every(entry => checked.output.includes(`retry ${entry} ab:fresh`))) failures.push(`${name}: ${checked.output} ${httpErrors.join("; ")}`);
    await browser.close();
  }
  assert.deepEqual(failures, []);
} finally { clearTimeout(deadline); await s.cleanup(); }
