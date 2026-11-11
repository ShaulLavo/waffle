import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, firefox, webkit, type Browser } from "playwright";
import { navigateTestPage } from "./browser-navigation.js";

const root = process.env.PROCESS_SCRATCH_ROOT;
if (!root) throw new Error("PROCESS_SCRATCH_ROOT must name an owned data-drive directory");
const engines = { chromium, firefox, webkit };
const requested = process.argv.slice(2);
const names = requested.length ? requested : Object.keys(engines);
const profiles: string[] = [];
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

async function cleanup() {
  const errors: unknown[] = [];
  await browser?.close().catch((error) => errors.push(error));
  try {
    server?.stop(true);
  } catch (error) {
    errors.push(error);
  }
  const removed = await Promise.allSettled(
    profiles.map((path) => rm(path, { recursive: true, force: true })),
  );
  for (const result of removed) if (result.status === "rejected") errors.push(result.reason);
  if (errors.length) throw new AggregateError(errors, "link browser cleanup failed");
}

const onSignal = () => void cleanup().finally(() => process.exit(1));
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

async function bundle(path: string) {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, path)],
    target: "browser",
  });
  if (!result.success || !result.outputs[0])
    throw new AggregateError(result.logs, `bundle ${path}`);
  return result.outputs[0];
}

try {
  const [page, worker, relayWorker, filesystemWorker] = await Promise.all([
    bundle("link-browser.ts"),
    bundle("fixtures/link-initialization-worker.ts"),
    bundle("fixtures/link-relay-worker.ts"),
    bundle("../browser/fs-worker.ts"),
  ]);
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/relay-worker.js" || path === "/fs-worker.js")
        return new Response(path === "/relay-worker.js" ? relayWorker : filesystemWorker, {
          headers: { ...headers, "Content-Type": "text/javascript" },
        });
      if (path === "/worker.js" || path === "/page.js")
        return new Response(path === "/worker.js" ? worker : page, {
          headers: { ...headers, "Content-Type": "text/javascript" },
        });
      return new Response("<!doctype html><title>Shared compiled link plans</title>", { headers });
    },
  });
  for (const name of names) {
    if (name !== "chromium" && name !== "firefox" && name !== "webkit")
      throw new Error(`unknown browser ${name}`);
    const scratch = await mkdtemp(join(root, "link-"));
    profiles.push(scratch);
    browser = await engines[name].launch({
      env: { ...process.env, TMPDIR: process.env.TMPDIR ?? scratch },
    });
    const tab = await browser.newPage();
    await navigateTestPage(tab, `http://127.0.0.1:${server.port}/`);
    const result = await tab.evaluate(async () => {
      const path = "/page.js";
      const page: typeof import("./link-browser.js") = await import(path);
      return page.sharedLinkBrowser();
    });
    console.log(JSON.stringify({ engine: name, ...result }));
    await browser.close();
    browser = undefined;
  }
} finally {
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  await cleanup();
}
