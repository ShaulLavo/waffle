// Optional real desktop Safari diagnostic. Requires existing remote-automation permission;
// never changes Safari settings or touches the owner's normal browser windows/profile.
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { browserBuildConfig } from "../../scripts/browser-build";

assert.equal(process.platform, "darwin", "Run this optional gate on the Mac fleet host");
let scratch: string | undefined, server: ReturnType<typeof Bun.serve> | undefined;
let driver: ReturnType<typeof Bun.spawn> | undefined, session: string | undefined;
const databases: string[] = [];
let cleaning: Promise<void> | undefined;
const storage = process.env.PERSIST_STORAGE === "opfs" ? "opfs" as const : "indexeddb" as const;
const smoke = process.env.PERSIST_SMOKE === "1";
let stopping = false;
const driverPort = Number(process.env.SAFARI_DRIVER_PORT ?? 43184);
const origin = `http://127.0.0.1:${driverPort}`;
const report: Record<string, any> = { browser: "Safari", platform: process.platform, arch: process.arch, storage,
  method: "Existing Safari WebDriver permission, task-owned automation session and driver. Same bundled storage/corpus worker as the three-engine gate. Storage contracts, page reload and exclusive writer, partial native payload/snapshot write termination, bounded handle cache, native payload-read counters and all-byte corpus validation. Fresh automation context; no normal owner profiles." };
async function request(path: string, method = "GET", body?: unknown): Promise<any> {
  const response = await fetch(origin + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(stopping ? 5_000 : 130_000) });
  const value: any = await response.json();
  if (!response.ok || (value.value?.error && value.value?.ok === undefined)) throw new Error(`Safari WebDriver ${path}: ${value.value?.message ?? response.status}`);
  return value.value;
}
async function evaluate(script: string, args: unknown[] = []): Promise<any> {
  const result = await request(`/session/${session}/execute/async`, "POST", {
    script: `const done = arguments[arguments.length - 1]; Promise.resolve().then(async () => { ${script} }).then(value => done({ok:true,value}), error => done({ok:false,error:String(error) + (error?.stack ? "\\n" + error.stack : "")}));`, args,
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function call(command: string, args?: unknown): Promise<any> {
  return evaluate("return globalThis.persistenceHarness.direct(arguments[0], arguments[1]);", [command, args ?? null]);
}
async function harness(method: string, ...args: unknown[]): Promise<any> {
  return evaluate("return globalThis.persistenceHarness[arguments[0]](...arguments[1]);", [method, args]);
}
async function navigate(): Promise<void> {
  await request(`/session/${session}/url`, "POST", { url: `http://127.0.0.1:${server!.port}/` });
  await ready();
}
async function switchWindow(handle: string): Promise<void> { await request(`/session/${session}/window`, "POST", { handle }); }
async function newWindow(): Promise<string> {
  const opened = await request(`/session/${session}/window/new`, "POST", { type: "tab" });
  await switchWindow(opened.handle); await navigate(); return opened.handle;
}
async function ready(): Promise<void> {
  await evaluate("const limit=Date.now()+15000; while(!globalThis.persistenceHarness){if(Date.now()>limit)throw Error('fixture did not load');await new Promise(r=>setTimeout(r,25));} return true;");
}
function cleanup(): Promise<void> {
  stopping = true;
  return cleaning ??= (async () => {
    if (session) {
      try {
        await evaluate("await globalThis.persistenceHarness?.destroy(); return true;");
        for (const database of databases) await harness("deleteDatabase", database, storage);
        await harness("destroy");
      } catch (error) { report.databaseCleanupError = String(error); }
      await request(`/session/${session}`, "DELETE").catch(error => { report.sessionCleanupError = String(error); });
      session = undefined;
    }
    if (driver) { driver.kill(); await driver.exited; driver = undefined; }
    server?.stop(true);
    if (scratch) await rm(scratch, { recursive: true, force: true });
    report.cleanup = { driverStopped: true, listenerClosed: true, buildScratchRemoved: true, databaseDeleted: !report.databaseCleanupError };
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("Safari persistence gate exceeded deadline"); void cleanup().finally(() => process.exit(1)); }, smoke ? 120_000 : 900_000);
try {
  scratch = await mkdtemp(resolve(import.meta.dir, "../node_modules/.persistence-safari-"));
  const out = join(scratch, "dist"), main = join(scratch, "main.ts");
  await Bun.write(main, `import ${JSON.stringify(resolve(import.meta.dir, "persistence-browser-main.ts"))};`);
  const built = await Bun.build(browserBuildConfig([main, resolve(import.meta.dir, "../src/fs-worker.ts"), resolve(import.meta.dir, "persistence-browser-worker.ts")], out));
  assert.ok(built.success, built.logs.map(String).join("\n"));
  await Bun.write(join(out, "index.html"), '<!doctype html><script type="module" src="./main.js"></script>');
  server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PERSISTENCE_PORT ?? 43183), async fetch(request) {
    const path = new URL(request.url).pathname, file = resolve(out, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(out + sep) || !await Bun.file(file).exists()) return new Response(null, { status: 404 });
    return new Response(Bun.file(file), { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } });
  } });
  // Do not send a session request to an existing owner's or another lane's WebDriver.
  const probe = await fetch(`${origin}/status`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
  assert.ok(!probe, `Safari driver port ${driverPort} is already occupied`);
  driver = Bun.spawn(["/usr/bin/safaridriver", "--port", String(driverPort)], { stdout: "ignore", stderr: "ignore" });
  for (let attempts = 0; ; attempts++) {
    try { await request("/status"); break; }
    catch (error) { if (attempts === 30) throw error; await Bun.sleep(100); }
  }
  const opened = await request("/session", "POST", { capabilities: { alwaysMatch: { browserName: "safari" } } });
  session = opened.sessionId; report.version = opened.capabilities.browserVersion;
  await request(`/session/${session}/timeouts`, "POST", { script: 120_000, pageLoad: 30_000, implicit: 0 });
  await navigate();
  const owner = await request(`/session/${session}/window`);
  report.storageTests = await call("storageTests", { storage, filter: process.env.PERSIST_STORAGE_FILTER });
  assert.ok(report.storageTests.length > 0);
  if (storage === "indexeddb" && !process.env.PERSIST_STORAGE_FILTER) assert.equal(report.storageTests.length, 13);
  const database = `bunwasm-step3c-${storage}-safari-${crypto.randomUUID()}`; databases.push(database);
  await harness("open", database, true, storage);
  await harness("mkdir", "/tree");
  await harness("write", "/tree/original.bin", [0, 255, 1, 0, 128]);
  await harness("write", "/deleted.bin", [9, 8, 7]);
  await harness("move", "/tree/original.bin", "/renamed.bin");
  await harness("remove", "/deleted.bin");
  await harness("flush");
  const before = await harness("snapshot"); assert.equal(before.length, 1);
  await request(`/session/${session}/refresh`, "POST", {}); await ready();
  await harness("open", database, true, storage);
  assert.deepEqual(await harness("snapshot"), before); report.reload = true;
  const contender = await newWindow();
  await assert.rejects(harness("open", database, true, storage), /writer|lock|occupied|already|in use/i);
  await switchWindow(owner); await harness("destroy");
  await switchWindow(contender); await harness("open", database, true, storage);
  assert.deepEqual(await harness("snapshot"), before);
  await harness("destroy"); await request(`/session/${session}/window`, "DELETE"); await switchWindow(owner);
  report.writerGate = true;
  report.interrupted = [];
  for (const boundary of storage === "opfs" ? ["payload", "snapshot"] : ["transaction", "transaction", "transaction"]) {
    const name = `${database}-interrupt-${report.interrupted.length}`; databases.push(name);
    await newWindow(); await call("open", { name, storage });
    const old = await call("seedInterrupted");
    await evaluate("void globalThis.persistenceHarness.direct('interruptCommit', arguments[0]).catch(() => {}); return true;", [boundary]);
    const event = await evaluate("const limit=Date.now()+30000; while(!globalThis.persistenceHarness.state.commitStarted){if(Date.now()>limit)throw Error('write boundary not reached'); await new Promise(r=>setTimeout(r,10));} const s=globalThis.persistenceHarness.state; return {boundary:s.boundary,partialWrite:s.partialWrite};");
    if (storage === "opfs") assert.deepEqual(event, { boundary, partialWrite: true });
    await request(`/session/${session}/window`, "DELETE"); await switchWindow(owner);
    // A fresh document and worker recover the crash; no prior backend/cache is reused.
    await request(`/session/${session}/refresh`, "POST", {}); await ready();
    await call("open", { name, storage });
    const recovered = await call("inspectInterrupted");
    assert.ok(recovered.state === "old" || recovered.state === "new", JSON.stringify(recovered));
    if (recovered.state === "old") assert.deepEqual(recovered.metadata, old.metadata);
    report.interrupted.push({ boundary, ...recovered }); await harness("destroy");
  }
  if (!smoke) {
    const name = `${database}-corpus`; databases.push(name);
    await call("open", { name, storage }); report.corpus = await call("createCorpus");
    assert.equal(report.corpus.files, 10_003);
    if (storage === "opfs") {
      assert.equal(report.corpus.persistPayloadFlushes, 0);
      assert.equal(report.corpus.durableFile.nativePayloadFlushes, 1);
    }
    await harness("destroy");
    await request(`/session/${session}/refresh`, "POST", {}); await ready();
    report.indexReload = await call("open", { name, storage });
    assert.equal(report.indexReload.reads, 0); assert.equal(report.indexReload.nativePayloadRequests, 0);
    report.metadataOnly = await call("metadataCorpus"); assert.equal(report.metadataOnly.files, 10_003);
    assert.equal(report.metadataOnly.reads, 0); assert.equal(report.metadataOnly.nativePayloadRequests, 0);
    report.firstData = await call("firstData"); assert.equal(report.firstData.reads, 1); assert.equal(report.firstData.nativePayloadRequests, 1);
    if (storage === "opfs") {
      report.cacheChurn = await call("cacheChurn"); assert.ok(report.cacheChurn.distinctFiles > 253);
      assert.ok(report.cacheChurn.additionalOpenedHandles > 253);
      assert.ok(report.cacheChurn.peakHandles <= 65);
    }
    report.fullRead = await call("readCorpus"); assert.equal(report.fullRead.files, 10_003);
    assert.equal(report.fullRead.bytes, report.corpus.bytes); assert.equal(report.fullRead.bad, 0);
    if (storage === "opfs") assert.ok(report.fullRead.peakHandles <= 65);
    if (storage === "opfs" && process.env.PERSIST_RAW_CORPUS === "1") {
      report.rawCorpus = await call("rawCorpus");
      assert.equal(report.rawCorpus.files, report.corpus.files); assert.equal(report.rawCorpus.bytes, report.corpus.bytes);
      assert.equal(report.rawCorpus.payloadFlushes, 0); assert.equal(report.rawCorpus.snapshotFlushes, 1);
      assert.equal(report.rawCorpus.cleanup.activeHandles, 0);
    }
  }
  report.ok = true;
  console.log(`Safari ${report.version}: ${storage} storage, reload, writer, crash gates${smoke ? "" : " and 10,003-file corpus"} passed`);
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); throw error; }
finally {
  clearTimeout(deadline); await cleanup();
  if (process.env.PERSISTENCE_OUTPUT) await Bun.write(process.env.PERSISTENCE_OUTPUT, JSON.stringify(report, null, 2) + "\n");
}
