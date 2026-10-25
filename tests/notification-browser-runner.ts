import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import {
  closeBrowserResources,
  type BrowserResourceOwner,
} from "./process-recycling-browser-runner-control.js";

const browsers = new Set<BrowserResourceOwner>();
const contexts = new Set<BrowserResourceOwner>();
let server: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
let cleaning: Promise<void> | undefined;
function cleanup(): Promise<void> {
  return (cleaning ??= (async () => {
    const errors = await closeBrowserResources(contexts, browsers);
    server?.stop(true);
    if (scratch && browsers.size === 0) await rm(scratch, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "notification browser cleanup");
  })());
}
const stop = () => {
  void cleanup().finally(() => process.exit(1));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const deadline = setTimeout(stop, 60000);
try {
  scratch = await mkdtemp("/work/tmp/wnotify-");
  console.log(
    JSON.stringify({
      resources: "notification-browser",
      scratch,
      browsers: 1,
      port: "ephemeral-loopback",
    }),
  );
  const entries = new Map([
    ["/mixed.js", "./notification-mixed-cases.ts"],
    ["/lifetime.js", "./notification-lifetime-cases.ts"],
    ["/guest.js", "./fixtures/notification-mixed-worker.ts"],
    ["/runtime.js", "./fixtures/notification-runtime-worker.ts"],
    ["/stalled.js", "./fixtures/notification-stalled-worker.ts"],
    ["/reject.js", "./fixtures/notification-reject-worker.ts"],
    ["/helper.js", "../browser/notification-worker.ts"],
  ]);
  const scripts = new Map<string, Blob>();
  for (const [path, entry] of entries) {
    const built = await Bun.build({
      entrypoints: [new URL(entry, import.meta.url).pathname],
      target: "browser",
    });
    if (!built.success) throw new AggregateError(built.logs, `bundle ${entry}`);
    scripts.set(path, built.outputs[0]!);
  }
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      return new Response(
        path === "/" ? "<!doctype html><title>Notification proof</title>" : scripts.get(path),
        {
          headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Content-Type": path === "/" ? "text/html" : "text/javascript",
          },
        },
      );
    },
  });
  const creation = chromium.launch({ headless: true, env: { ...process.env, TMPDIR: scratch } });
  browsers.add({ creation, stopped: false });
  const browser = await creation;
  const contextCreation = browser.newContext();
  contexts.add({ creation: contextCreation, stopped: false });
  const page = await (await contextCreation).newPage();
  page.on("pageerror", (error) => console.error(error));
  await page.goto(server.url.href);
  const result = await page.evaluate(async () => {
    const mixedPath = "/mixed.js",
      lifetimePath = "/lifetime.js";
    const mixed: typeof import("./notification-mixed-cases.js") = await import(mixedPath);
    const lifetime: typeof import("./notification-lifetime-cases.js") = await import(lifetimePath);
    const url = (path: string) => new URL(path, location.href).href;
    return {
      mixed: await mixed.mixedNotificationCases(url("/guest.js"), url("/helper.js")),
      terminated: await lifetime.brokerNotificationCase(
        url("/runtime.js"),
        url("/helper.js"),
        false,
      ),
      revoked: await lifetime.brokerNotificationCase(url("/runtime.js"), url("/helper.js"), true),
      startupCancel: await lifetime.bootstrapNotificationCase(
        url("/runtime.js"),
        url("/stalled.js"),
        "arm",
      ),
      releaseFailure: await lifetime.scopeDisposalFailureCase(url("/stalled.js"), false),
      sendFailure: await lifetime.scopeDisposalFailureCase(url("/stalled.js"), true),
      relayStopFailure: await lifetime.brokerNotificationCase(
        url("/runtime.js"),
        url("/helper.js"),
        false,
        true,
      ),
      relayArmFailure: await lifetime.bootstrapNotificationCase(
        url("/runtime.js"),
        url("/reject.js"),
        "relay",
      ),
      startupReject: await lifetime.bootstrapNotificationCase(
        url("/runtime.js"),
        url("/helper.js"),
        "reject",
      ),
    };
  });
  console.log(JSON.stringify({ engine: "chromium", result }));
} finally {
  clearTimeout(deadline);
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  await cleanup();
}
