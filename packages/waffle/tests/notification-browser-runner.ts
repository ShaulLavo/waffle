import { notificationSources } from "./notification-command.js";
import { navigateTestPage } from "./browser-navigation.js";
import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeBrowserResources,
  type BrowserResourceOwner,
} from "./process-recycling-browser-runner-control.js";

if (process.argv[2] === "ios-safari") {
  const { notificationNative } = await import("./page-runner/notification-native.js");
  process.exit(await notificationNative(process.argv.slice(3)));
}
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
  scratch = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "wnotify-"));
  console.log(
    JSON.stringify({
      resources: "notification-browser",
      scratch,
      browsers: 1,
      port: "ephemeral-loopback",
    }),
  );
  const entries = new Map(Object.entries(notificationSources));
  const scripts = new Map<string, Blob>();
  for (const [path, entry] of entries) {
    const built = await Bun.build({
      entrypoints: [fileURLToPath(new URL(entry, import.meta.url))],
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
  await navigateTestPage(page, server.url.href);
  const result = await page.evaluate(async () => {
    const commandPath = "/notification.js";
    const command: typeof import("./notification-command.js") = await import(commandPath);
    return command.notificationCommand();
  });
  console.log(JSON.stringify({ engine: "chromium", result }));
} finally {
  clearTimeout(deadline);
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  await cleanup();
}
