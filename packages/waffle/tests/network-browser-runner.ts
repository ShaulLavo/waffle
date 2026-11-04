import { preview1ListenerModule } from "./preview1-listener-module.js";
import { resolve } from "node:path";
import { runNetworkRelayBrowser } from "./network-relay-browser-runner.js";
import { networkBrowserCases } from "./network-browser.js";
import { installNetworkServiceWorker } from "./network-browser-service-worker.js";
import { runIsolatedPages } from "./isolated-page-runner.js";

export async function runNetworkBrowser(names: readonly string[] = ["chromium"]): Promise<void> {
  const listener = await preview1ListenerModule();
  await runIsolatedPages({
    label: "network-browser",
    // The served bundles; importing them keeps their entry points reachable for knip.
    entries: [networkBrowserCases.name, installNetworkServiceWorker.name],
    scratchRoot: resolve(
      process.env.NETWORK_SCRATCH_ROOT ?? process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp",
    ),
    scratchPrefix: "wnet-",
    port: Number(process.env.NETWORK_TEST_PORT ?? 43827),
    sources: {
      "/tests.js": "network-browser.ts",
      "/network-worker.js": "network-browser-worker.ts",
      "/network-sw.js": "network-browser-service-worker.ts",
      "/listener-preview1-worker.js": "../browser/preview1-worker.ts",
      "/network-fs.js": "../browser/fs-worker.ts",
    },
    route(path, headers) {
      if (path === "/preview1-listener.wasm")
        return new Response(listener, {
          headers: { ...headers, "Content-Type": "application/wasm" },
        });
      if (path.endsWith("/network.wasm"))
        return new Response(Bun.file(new URL("../browser/net/network.wasm", import.meta.url)), {
          headers: { ...headers, "Content-Type": "application/wasm" },
        });
    },
    names,
    evaluate: (page) =>
      page.evaluate(async () => {
        const path = "/tests.js";
        const fixture: typeof import("./network-browser.js") = await import(path);
        return fixture.networkBrowserCases();
      }),
  });
  await runNetworkRelayBrowser(names);
}

if (import.meta.main)
  await runNetworkBrowser(process.argv.length > 2 ? process.argv.slice(2) : undefined);
