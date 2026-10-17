// Browser durability gate and corpus diagnostic. No Rust/WASM build or package payload is used.
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { browserBuildConfig } from "../../scripts/browser-build";

let scratch: string | undefined, server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined, launch: Promise<Browser> | undefined;
let cleanupPromise: Promise<void> | undefined;
const previousTmp = process.env.TMPDIR;
function cleanup(): Promise<void> {
  return cleanupPromise ??= (async () => {
    try { await (browser ?? await launch?.catch(() => undefined))?.close(); }
    finally {
      server?.stop(true); if (scratch) await rm(scratch, { recursive: true, force: true });
      if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const smoke = process.env.PERSIST_SMOKE === "1";
const storage = process.env.PERSIST_STORAGE === "opfs" ? "opfs" as const : "indexeddb" as const;
const deadline = setTimeout(() => { console.error("persistence gate timed out"); void cleanup().finally(() => process.exit(1)); }, smoke ? 90_000 : 900_000);
const pageOnly = process.argv.includes("--page-only");
const storageOnly = process.argv.includes("--storage-only");
const engines = process.argv.slice(2).filter(value => !value.startsWith("--"));
const report: { method: string; platform: string; arch: string; storage: string; browsers: any[]; error?: string } = {
  method: "Headless real-browser selected-storage durability, page termination, exclusive-writer and lazy-data gates. Original spike 3 corpus geometry: 10,000 package-sized files plus three 8 MiB files; synthetic deterministic contents, no upstream code/content. One corpus sample per engine, timings diagnostic not performance thresholds. Browser profiles, workers, server and build scratch owned by this process.",
  platform: process.platform, arch: process.arch, storage, browsers: [],
};
async function ready(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server!.port}/`);
  await page.waitForFunction(() => (globalThis as any).persistenceHarness);
  return page;
}
async function call(page: Page, method: string, ...args: unknown[]): Promise<any> {
  return page.evaluate(({ method, args }) => (globalThis as any).persistenceHarness[method](...args), { method, args });
}
async function direct(page: Page, command: string, args?: unknown): Promise<any> { return call(page, "direct", command, args); }
try {
  scratch = await mkdtemp(resolve(import.meta.dir, "../node_modules/.persistence-browser-"));
  process.env.TMPDIR = scratch;
  const out = join(scratch, "dist"), main = join(scratch, "main.ts");
  await Bun.write(main, `import ${JSON.stringify(resolve(import.meta.dir, "persistence-browser-main.ts"))};`);
  const entries = [main, resolve(import.meta.dir, "../src/fs-worker.ts")].concat(pageOnly ? [] : [resolve(import.meta.dir, "persistence-browser-worker.ts")]);
  const built = await Bun.build(browserBuildConfig(entries, out));
  assert.ok(built.success, built.logs.map(String).join("\n"));
  await Bun.write(join(out, "index.html"), '<!doctype html><script type="module" src="./main.js"></script>');
  server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PERSISTENCE_PORT ?? 43183), async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/favicon.ico") return new Response(null, { status: 204 });
    const file = resolve(out, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(out + sep) || !await Bun.file(file).exists()) return new Response(null, { status: 404 });
    return new Response(Bun.file(file), { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } });
  } });
  for (const name of engines.length ? engines : smoke || process.env.CI ? ["chromium"] : ["chromium", "firefox", "webkit"]) {
    const type = { chromium, firefox, webkit }[name];
    assert.ok(type, `unknown browser ${name}`);
    launch = type.launch({ headless: true, downloadsPath: join(scratch, "downloads"), tracesDir: join(scratch, "traces") });
    browser = await launch;
    const context = await browser.newContext();
    const errors: string[] = [];
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    const page = await ready(context);
    const prefix = `bunwasm-step3c-${storage}-${name}-${crypto.randomUUID()}`;
    const databases = [prefix];
    const row: any = { browser: name, version: browser.version(), reload: false, checks: [] };
    report.browsers.push(row);
    try {
      if (!pageOnly) {
        row.storageTests = await direct(page, "storageTests", { storage, filter: process.env.PERSIST_STORAGE_FILTER });
        assert.ok(row.storageTests.length > 0, "selected storage contract suite must execute cases");
        if (storage === "indexeddb" && !process.env.PERSIST_STORAGE_FILTER) assert.equal(row.storageTests.length, 13);
      }
      if (!storageOnly) {
      // This test is deliberately available before backend integration: the old memory-only
      // worker completes flush but loses every byte and inode as soon as this page reloads.
      await call(page, "open", prefix, true, storage);
      await call(page, "mkdir", "/tree");
      await call(page, "write", "/tree/original.bin", [0, 255, 1, 0, 128]);
      await call(page, "write", "/deleted.bin", [9, 8, 7]);
      await call(page, "move", "/tree/original.bin", "/renamed.bin");
      await call(page, "remove", "/deleted.bin");
      await call(page, "flush");
      const before = await call(page, "snapshot");
      assert.equal(before.length, 1);
      await page.reload();
      await page.waitForFunction(() => (globalThis as any).persistenceHarness);
      await call(page, "open", prefix, true, storage);
      assert.deepEqual(await call(page, "snapshot"), before, "immediate reload after durable flush must preserve bytes, inode, mtime, rename and unlink");
      row.reload = true; row.checks.push("durable-page-reload-bytes-inode-mtime-rename-unlink");
      if (!pageOnly) {
      const contender = await ready(context);
      await assert.rejects(call(contender, "open", prefix, true, storage), /writer|lock|occupied|already|in use/i, "second page must refuse an occupied writer");
      await call(page, "destroy");
      await call(contender, "open", prefix, true, storage);
      assert.deepEqual(await call(contender, "snapshot"), before, "writer may reopen after the first page releases ownership");
      await call(contender, "destroy"); await contender.close();
      row.checks.push("second-tab-writer-refused-then-open-after-owner-close");

      // Close after a real partial OPFS write, or at the IndexedDB transaction boundary.
      // A committed new generation and an aborted old generation are both correct; partial
      // namespace/data or an empty recovered tree are never accepted.
      row.interrupted = [];
      for (const boundary of storage === "opfs" ? ["payload", "snapshot"] : ["transaction", "transaction", "transaction"]) {
        const db = `${prefix}-interrupt-${row.interrupted.length}`; databases.push(db);
        const victim = await ready(context);
        await direct(victim, "open", { name: db, storage });
        const old = await direct(victim, "seedInterrupted");
        await victim.evaluate(boundary => { void (globalThis as any).persistenceHarness.direct("interruptCommit", boundary).catch(() => {}); }, boundary);
        await victim.waitForFunction(() => (globalThis as any).persistenceHarness.state.commitStarted);
        if (storage === "opfs") assert.deepEqual(await victim.evaluate(() => {
          const state = (globalThis as any).persistenceHarness.state;
          return { boundary: state.boundary, partialWrite: state.partialWrite };
        }), { boundary, partialWrite: true });
        await victim.close();
        const reader = await ready(context);
        await direct(reader, "open", { name: db, storage });
        const recovered = await direct(reader, "inspectInterrupted");
        assert.ok(recovered.state === "old" || recovered.state === "new", `interrupted commit recovered partial/empty data: ${JSON.stringify(recovered)}`);
        if (recovered.state === "old") assert.deepEqual(recovered.metadata, old.metadata);
        row.interrupted.push({ boundary, ...recovered });
        await call(reader, "destroy"); await reader.close();
      }
      row.checks.push(storage === "opfs" ? "page-close-partial-native-payload-and-snapshot-writes-old-or-new" : "page-close-midcommit-old-or-new-never-empty");

      if (!smoke) {
      const db = `${prefix}-corpus`; databases.push(db);
      const bench = await ready(context);
      await direct(bench, "open", { name: db, storage });
      row.corpus = await direct(bench, "createCorpus");
      assert.equal(row.corpus.files, 10_003);
      if (storage === "opfs") {
        assert.equal(row.corpus.persistPayloadFlushes, 0, "background checkpoints must not fsync payloads");
        assert.equal(row.corpus.durableFile.nativePayloadFlushes, 1, "explicit file flush must fsync exactly that payload");
      }
      await call(bench, "destroy");
      // A new document/worker eliminates any memory cache and measures index-only startup.
      await bench.reload(); await bench.waitForFunction(() => (globalThis as any).persistenceHarness);
      row.indexReload = await direct(bench, "open", { name: db, storage });
      assert.equal(row.indexReload.reads, 0, "opening the durable index must not read payloads");
      assert.equal(row.indexReload.nativePayloadRequests, 0, "index open must not issue native payload get/getAll/cursor requests");
      row.metadataOnly = await direct(bench, "metadataCorpus");
      assert.equal(row.metadataOnly.files, 10_003);
      assert.equal(row.metadataOnly.reads, 0, "stat/list metadata must not force payload reads");
      assert.equal(row.metadataOnly.nativePayloadRequests, 0);
      row.firstData = await direct(bench, "firstData");
      assert.equal(row.firstData.reads, 1, "the first file access must load exactly its payload");
      assert.equal(row.firstData.nativePayloadRequests, 1);
      if (storage === "opfs") {
        row.cacheChurn = await direct(bench, "cacheChurn");
        assert.ok(row.cacheChurn.distinctFiles > 253);
        assert.ok(row.cacheChurn.additionalOpenedHandles > 253, "cache churn must reach native storage, not only the runtime byte cache");
        assert.ok(row.cacheChurn.peakHandles <= 65, "native handles must stay bounded including metadata writes");
      }
      row.fullRead = await direct(bench, "readCorpus");
      assert.equal(row.fullRead.files, 10_003);
      assert.equal(row.fullRead.bytes, row.corpus.bytes);
      assert.equal(row.fullRead.bad, 0, "every corpus byte must survive persistence and lazy reload");
      if (storage === "opfs") assert.ok(row.fullRead.peakHandles <= 65);
      row.checks.push("10003-files-persist-index-only-reload-first-payload-full-read");
      if (storage === "opfs" && process.env.PERSIST_RAW_CORPUS === "1") {
        row.rawCorpus = await direct(bench, "rawCorpus");
        assert.equal(row.rawCorpus.files, row.corpus.files); assert.equal(row.rawCorpus.bytes, row.corpus.bytes);
        assert.equal(row.rawCorpus.payloadFlushes, 0); assert.equal(row.rawCorpus.snapshotFlushes, 1);
        assert.equal(row.rawCorpus.cleanup.activeHandles, 0);
      }
      await call(bench, "destroy"); await bench.close();
      console.log(`${name} ${browser.version()}: corpus background-checkpoint=${row.corpus.persistMs.toFixed(1)}ms durable-one-file=${row.corpus.durableFile.flushMs.toFixed(1)}ms index=${row.indexReload.ms.toFixed(1)}ms first=${row.firstData.ms.toFixed(1)}ms full=${row.fullRead.ms.toFixed(1)}ms`);
      }
      assert.deepEqual(errors, []);
      console.log(`${name} ${browser.version()}: storage and persistence gates passed`);
      }
      }
    } finally {
      await call(page, "destroy").catch(() => {});
      await context.close();
      // The disposable context owns every database, including pages killed during commit.
      row.cleanup = { contextClosed: true, databaseNames: databases };
    }
    await browser.close(); browser = undefined; launch = undefined;
  }
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); throw error; }
finally {
  if (process.env.PERSISTENCE_OUTPUT) await Bun.write(process.env.PERSISTENCE_OUTPUT, JSON.stringify(report, null, 2) + "\n");
  clearTimeout(deadline); await cleanup();
}
