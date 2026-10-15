import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { playwright, ready, run, session, writeFile } from "./playground.mjs";

const base = process.argv[2];
assert.ok(base, "usage: node web/tests/bench-memory.mjs <site URL> [output.json]");
const count = Number(process.env.RUNS ?? 5);
const buildsResponse = await fetch(new URL("playground/engine-builds.json", base));
assert.ok(buildsResponse.ok, "site must publish its wasm hashes");
const wasmBuilds = await buildsResponse.json();
const workerResponse = await fetch(new URL("playground/worker.js", base));
assert.ok(workerResponse.ok, "site must publish its host worker");
const hostWorkerSha256 = createHash("sha256").update(new Uint8Array(await workerResponse.arrayBuffer())).digest("hex");
const s = session("bun-wasm-memory-bench-");
const results = [];
const native = `let sum = 0;
const start = performance.now();
for (let i = 0; i < 50000; i++) sum += Number(Bun.hash("tiny") & 255n);
console.log("NATIVE_MS", performance.now() - start, sum);`;
const nativeString = `let size = 0;
const start = performance.now();
for (let i = 0; i < 50000; i++) size += process.cwd().length;
console.log("STRING_MS", performance.now() - start, size);`;
const writes = `const start = performance.now();
for (let i = 0; i < 2000; i++) console.log("small write", i);
console.log("WRITE_MS", performance.now() - start);`;

async function timedRun(page, source, marker) {
  await writeFile(page, "/home/user/measure.js", source);
  const result = await run(page, "bun run measure.js", 120000);
  assert.equal(result.code, 0, result.output);
  const match = result.output.match(new RegExp(`${marker} ([0-9.]+)`));
  assert.ok(match, result.output);
  return { guestMs: Number(match[1]), wallMs: result.ms };
}

async function measure(name) {
  const browser = await s.launch(playwright[name]);
  try {
    const item = { browser: name, version: browser.version(), support: null, samples: [] };
    for (let i = 0; i < count; i++) item.samples.push(await sample(browser, item));
    results.push(item);
  } finally {
    await browser.close();
  }
}

async function sample(browser, item) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  try {
    await context.addInitScript(countRootCommits);
    const page = await context.newPage();
    const start = performance.now();
    await page.goto(new URL("playground/?engine=browser", base).href);
    const status = await ready(page);
    const readyMs = performance.now() - start;
    assert.match(status, /ready/);
    item.support ??= await page.evaluate(() => {
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
      const convert = memory.toResizableBuffer;
      const buffer = convert?.call(memory);
      return { toResizableBuffer: typeof convert, resizable: buffer?.resizable ?? false,
        toGrowableSharedArrayBuffer: typeof memory.toGrowableSharedArrayBuffer,
        userAgent: navigator.userAgent };
    });
    await timedRun(page, native, "NATIVE_MS");
    await timedRun(page, nativeString, "STRING_MS");
    await timedRun(page, writes, "WRITE_MS");
    const nativeResult = await timedRun(page, native, "NATIVE_MS");
    const stringResult = await timedRun(page, nativeString, "STRING_MS");
    const writeResult = await timedRun(page, writes, "WRITE_MS");
    const sandbox = await context.newPage();
    const renderStart = performance.now();
    await sandbox.goto(new URL("?engine=browser", base).href);
    await sandbox.frameLocator("#preview").locator("button.counter").waitFor({ timeout: 180000 });
    const firstRenderMs = performance.now() - renderStart;
    const renderCommits = await sandbox.frameLocator("#preview").locator("button.counter").evaluate(() => globalThis.__memoryRenderCommits);
    assert.ok(renderCommits > 0, "React root-commit hook must run");
    const sample = { readyMs, native: nativeResult, nativeString: stringResult, fdWrite: writeResult, firstRenderMs, renderCommits };
    console.error(item.browser, JSON.stringify(sample));
    return sample;
  } finally {
    await context.close();
  }
}

function countRootCommits() {
  globalThis.__memoryRenderCommits = 0;
  globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot: () => { globalThis.__memoryRenderCommits++; },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
  };
}

try {
  for (const name of (process.env.BROWSERS ?? "chromium,webkit").split(",")) await measure(name);
  const output = JSON.stringify({ runs: count, nativeCalls: 50000, writes: 2000, wasmBuilds, hostWorkerSha256, results }, null, 2);
  if (process.argv[3]) writeFileSync(process.argv[3], output + "\n");
  console.log(output);
} finally {
  await s.cleanup();
}
