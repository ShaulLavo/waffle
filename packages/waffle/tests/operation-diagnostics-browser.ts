import assert from "node:assert/strict";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { navigateTestPage } from "../testing/browser-navigation.js";

const {
  positionals: [engine],
  values,
} = parseArgs({
  allowPositionals: true,
  options: {
    cat: { type: "string" },
    baseline: { type: "string" },
    samples: { type: "string", default: "7" },
    controls: { type: "boolean", default: true, allowNegative: true },
    audit: { type: "boolean" },
  },
});
const browsers = { chromium, firefox, webkit };
if (engine !== "chromium" && engine !== "firefox" && engine !== "webkit")
  throw new Error("Expected chromium, firefox, or webkit");
if (!values.cat) throw new Error("Pass --cat with cat.wasm extracted from the Coreutils archive");
const cat = Bun.file(resolve(values.cat));
assert.ok(await cat.exists(), "Packed cat fixture is missing");
const samples = Number(values.samples);
assert.ok(Number.isSafeInteger(samples) && samples >= 0, "Expected a nonnegative --samples count");
const source = resolve(import.meta.dir, "..");
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

async function bundle(root: string, audit = false) {
  const result = await Bun.build({
    entrypoints: [
      join(root, "tests/fixtures/operation-page.ts"),
      join(root, "tests/fixtures/operation-fs-worker.ts"),
      join(root, "browser/preview1-worker.ts"),
    ].concat(audit ? [join(root, "tests/fixtures/operation-observer-worker.ts")] : []),
    format: "esm",
    target: "browser",
    splitting: true,
    naming: { entry: "[name].js", chunk: "[name]-[hash].js" },
  });
  assert.equal(result.success, true, String(result.logs));
  return new Map(result.outputs.map((output) => [basename(output.path), output]));
}

async function inventory(outputs: Awaited<ReturnType<typeof bundle>>) {
  const assets = await Promise.all(
    Array.from(outputs, async ([name, output]) => {
      const text = await output.text();
      return {
        name,
        raw: output.size,
        gzip: gzipSync(text, { level: 9 }).length,
        diagnostic:
          /Operation capture was retired|class OperationOwner|function observePipePoll/.test(text),
      };
    }),
  );
  return assets;
}

async function trackWorkers(page: Page) {
  const counts = { created: 0, closed: 0 };
  const preview1Closed: Promise<void>[] = [];
  page.on("worker", (worker) => {
    counts.created++;
    const ended = Promise.withResolvers<void>();
    if (worker.url().includes("preview1-worker")) preview1Closed.push(ended.promise);
    worker.on("close", () => {
      counts.closed++;
      ended.resolve();
    });
  });
  await page.exposeFunction("waitForOperationWorkerClose", (number: number) => {
    const ended = preview1Closed[number - 1];
    assert.ok(ended, "preview1 Worker close observer must be armed");
    return ended;
  });
  return counts;
}

async function run(
  browser: Browser,
  outputs: Awaited<ReturnType<typeof bundle>>,
  mode: "on" | "off" | "baseline",
  controls = false,
  audit = false,
) {
  const requested = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/")
        return new Response(
          '<!doctype html><body><script type="module" src="/operation-page.js"></script>',
          {
            headers: { ...headers, "Content-Type": "text/html" },
          },
        );
      if (path === "/cat.wasm")
        return new Response(cat, { headers: { ...headers, "Content-Type": "application/wasm" } });
      const name =
        path === "/browser/preview1-worker.ts"
          ? audit
            ? "operation-observer-worker.js"
            : "preview1-worker.js"
          : basename(path);
      const output = outputs.get(name);
      if (!output) return new Response("missing", { status: 404, headers });
      requested.add(name);
      return new Response(output, { headers: { ...headers, "Content-Type": "text/javascript" } });
    },
  });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const workers = await trackWorkers(page);
    const url = new URL(server.url.href);
    url.searchParams.set("mode", mode);
    url.searchParams.set("samples", String(samples));
    if (controls) url.searchParams.set("controls", "");
    if (audit) url.searchParams.set("audit", "");
    await navigateTestPage(page, url.href, { timeout: 30_000 });
    await page.waitForSelector('body[data-done="true"]', { timeout: 90_000 });
    const result = JSON.parse(await page.locator("body").innerText());
    assert.equal(result.ok, true, JSON.stringify({ result, errors }));
    assert.equal(await page.locator("body").getAttribute("data-disposed"), "true");
    assert.deepEqual(errors, []);
    await page.close();
    assert.equal(workers.closed, workers.created, "native Worker close events");
    return { result, ...workers, requested: Array.from(requested).sort() };
  } finally {
    try {
      await context?.close();
    } finally {
      await server.stop(true);
    }
  }
}

const outputs = await bundle(source);
const candidate = await inventory(outputs);
const browser = await browsers[engine].launch({ headless: true });
try {
  const on = await run(browser, outputs, "on", values.controls);
  const off = await run(browser, outputs, "off");
  const diagnostics = candidate.filter((asset) => asset.diagnostic).map(({ name }) => name);
  assert.ok(diagnostics.length >= 2, "expected independently loaded diagnostic code");
  assert.ok(diagnostics.every((name) => on.requested.includes(name)));
  assert.ok(diagnostics.every((name) => !off.requested.includes(name)));
  const baseline = values.baseline ? await bundle(resolve(values.baseline)) : undefined;
  const base = baseline ? await run(browser, baseline, "baseline") : undefined;
  const auditOutputs = values.audit ? await bundle(source, true) : undefined;
  const audit = auditOutputs ? await run(browser, auditOutputs, "on", true, true) : undefined;
  const auditDisabled = auditOutputs
    ? await run(browser, auditOutputs, "off", true, true)
    : undefined;
  console.log(
    JSON.stringify({
      engine,
      version: browser.version(),
      on,
      off,
      base,
      candidate,
      baseline: baseline && (await inventory(baseline)),
      audit,
      auditDisabled,
    }),
  );
} finally {
  await browser.close();
}
