import { resolve } from "node:path";
import { networkBrowserCases } from "./network-browser.js";
import { installNetworkServiceWorker } from "./network-browser-service-worker.js";
import { runIsolatedPages } from "./isolated-page-runner.js";

export async function runNetworkBrowser(names: readonly string[] = ["chromium"]): Promise<void> {
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
      "/network-fs.js": "../browser/fs-worker.ts",
    },
    route: (path, headers) =>
      path.endsWith("/network.wasm")
        ? new Response(Bun.file(new URL("../browser/net/network.wasm", import.meta.url)), {
            headers: { ...headers, "Content-Type": "application/wasm" },
          })
        : undefined,
    names,
    evaluate: (page) =>
      page.evaluate(async () => {
        const path = "/tests.js";
        const fixture: typeof import("./network-browser.js") = await import(path);
        return fixture.networkBrowserCases();
      }),
  });
}

if (import.meta.main)
  await runNetworkBrowser(process.argv.length > 2 ? process.argv.slice(2) : undefined);
