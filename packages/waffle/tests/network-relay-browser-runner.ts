import assert from "node:assert/strict";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { relaySocketModules } from "./network-relay-modules.js";
import { createRelayBrowserFixture } from "./network-relay-fixture.js";
import { networkRelayBrowserCases } from "./network-relay-browser.js";
import { runIsolatedPages, exitAfterBrowserCleanup } from "./isolated-page-runner.js";

export async function runNetworkRelayBrowser(
  names: readonly string[] = ["chromium"],
): Promise<void> {
  const scratchRoot = resolve(
    process.env.NETWORK_SCRATCH_ROOT ?? process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp",
  );
  await mkdir(scratchRoot, { recursive: true });
  assert.ok(
    Buffer.byteLength(await realpath(scratchRoot)) <= 36,
    "NETWORK_SCRATCH_ROOT must be physically short for browser Unix sockets",
  );
  const modules = await relaySocketModules();
  const failures: unknown[] = [];
  for (const name of names) {
    try {
      await engine(name, scratchRoot, modules);
    } catch (error) {
      failures.push(new Error(`${name} relay matrix failed`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, "Network relay browser matrix failed");
}
async function engine(
  name: string,
  scratchRoot: string,
  modules: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
): Promise<void> {
  const fixture = createRelayBrowserFixture();
  const stop = () => {
    void exitAfterBrowserCleanup("network-relay-fixture", fixture.close);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const port = Number(process.env.NETWORK_RELAY_TEST_PORT ?? 43828);
    const config = await fixture.start(`http://127.0.0.1:${port}`, name !== "webkit");
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await runIsolatedPages({
      label: "network-relay-browser",
      entries: [networkRelayBrowserCases.name],
      scratchRoot,
      scratchPrefix: "wnr-",
      port,
      names: [name],
      dispose: fixture.close,
      sources: {
        "/relay-tests.js": "network-relay-browser.ts",
        "/relay-helper-worker.js": "network-relay-worker.ts",
        "/relay-preview1-worker.js": "../browser/preview1-worker.ts",
        "/relay-fs.js": "../browser/fs-worker.ts",
      },
      route(path, headers) {
        if (path === "/relay-config") return Response.json(config, { headers });
        if (path === "/relay-idle") return fixture.idle();
        const module = modules.get(path);
        if (module)
          return new Response(module, {
            headers: { ...headers, "Content-Type": "application/wasm" },
          });
        if (path.endsWith("/network.wasm"))
          return new Response(Bun.file(new URL("../browser/net/network.wasm", import.meta.url)), {
            headers: { ...headers, "Content-Type": "application/wasm" },
          });
      },
      async evaluate(page) {
        page.on("console", (message) =>
          console.log(JSON.stringify({ engine: name, browserConsole: message.text() })),
        );
        const results = await page.evaluate(async () => {
          const path = "/relay-tests.js";
          const entry: typeof import("./network-relay-browser.js") = await import(path);
          return entry.networkRelayBrowserCases();
        });
        fixture.verify(results.map((result) => result.carrier));
        if (name !== "webkit")
          assert.equal(
            results[0]?.carrier,
            "webtransport",
            `${name}'s real complete WebTransport probe failed`,
          );
        console.log(
          JSON.stringify({
            browser: name,
            version: page.context().browser()?.version(),
            webtransport:
              name === "webkit" ? "not claimed by Playwright WebKit" : results[0]?.probe,
            results,
          }),
        );
        return results;
      },
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await fixture.close();
  }
}
if (import.meta.main)
  await runNetworkRelayBrowser(process.argv.length > 2 ? process.argv.slice(2) : undefined);
