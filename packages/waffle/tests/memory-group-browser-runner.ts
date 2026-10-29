import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { buildFixture, verifiedFixture } from "../scripts/build-memory-group-fixture.ts";

// Chromium acceptance for memory groups: relocated PIE member images through Waffle's real
// runtime, broker, bootstrap and link loader. The fixture is built once by the libc producer:
// MEMORY_GROUP_FIXTURE_DIR names its verified artifact. Without it, WASI_SDK_PATH builds one
// into this run's scratch. PROCESS_SCRATCH_ROOT selects the scratch parent.
// MEMORY_GROUP_PORT picks the loopback port; 0 lets the OS choose.
const fixtureDirectory = process.env.MEMORY_GROUP_FIXTURE_DIR;
if (!fixtureDirectory && !process.env.WASI_SDK_PATH)
  throw new Error(
    "set MEMORY_GROUP_FIXTURE_DIR to the built fixture, or WASI_SDK_PATH to build it",
  );
const scratchRoot = process.env.PROCESS_SCRATCH_ROOT;
if (!scratchRoot) throw new Error("PROCESS_SCRATCH_ROOT must name a scratch directory");
const port = Number(process.env.MEMORY_GROUP_PORT ?? 0);
const engines = process.argv.slice(2);
if (engines.some((engine) => engine !== "chromium"))
  throw new Error("the memory group runner covers Chromium");

let scratch: string | undefined;
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

async function bundle(entry: string): Promise<Blob> {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, entry)],
    target: "browser",
  });
  if (!build.success) throw new AggregateError(build.logs, `bundle ${entry} failed`);
  return build.outputs[0]!;
}

async function cleanup(): Promise<void> {
  const errors: unknown[] = [];
  await browser?.close().catch((error) => errors.push(error));
  try {
    server?.stop(true);
  } catch (error) {
    errors.push(error);
  }
  if (scratch)
    await rm(scratch, { recursive: true, force: true }).catch((error) => errors.push(error));
  if (errors.length) throw new AggregateError(errors, "memory group runner cleanup failed");
}
const onSignal = () => void cleanup().finally(() => process.exit(1));
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  scratch = await mkdtemp(join(scratchRoot, "wgroup-"));
  let built = fixtureDirectory;
  if (!built) {
    built = join(scratch, "fixture");
    buildFixture(built);
  }
  const member = new Uint8Array(verifiedFixture(built));
  const [page, worker, fsWorker] = await Promise.all([
    bundle("memory-group-browser.ts"),
    bundle("fixtures/memory-group-worker.ts"),
    bundle("../browser/fs-worker.ts"),
  ]);
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cache-Control": "no-store",
  };
  const script = { ...headers, "Content-Type": "text/javascript" };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/memory-group-browser.js") return new Response(page, { headers: script });
      if (path === "/memory-group-worker.js") return new Response(worker, { headers: script });
      if (path === "/fs-worker.js") return new Response(fsWorker, { headers: script });
      if (path === "/memory-group-member.wasm")
        return new Response(member, {
          headers: { ...headers, "Content-Type": "application/wasm" },
        });
      if (path === "/")
        return new Response("<!doctype html><title>Memory groups</title>", {
          headers: { ...headers, "Content-Type": "text/html" },
        });
      return new Response("not found", { status: 404, headers });
    },
  });
  browser = await chromium.launch();
  const context = await browser.newContext();
  const tab = await context.newPage();
  tab.on("console", (message) => {
    if (message.type() === "error") console.error(`[page] ${message.text()}`);
  });
  await tab.goto(`http://127.0.0.1:${server.port}/`);
  const report = await tab.evaluate(async () => {
    const tests = (await import(
      "/memory-group-browser.js" as string
    )) as typeof import("./memory-group-browser.js");
    return tests.memoryGroupBrowser();
  });
  if (
    typeof report.disposal !== "string" ||
    !report.disposal.includes("memory group members") ||
    !report.disposal.includes("A live page runtime already owns this page")
  )
    throw new Error(`disposal released the page with unsettled group debt: ${report.disposal}`);
  console.log(JSON.stringify({ memoryGroups: report }, null, 1));
  await context.close();
} finally {
  await cleanup();
}
