import { resolve } from "node:path";
import type { PreparationContext } from "waffle/testing/page-runner";
import { preview1ListenerModule } from "./preview1-listener-module.js";
import { relaySocketModules } from "./network-relay-modules.js";
import { sentinelAssets } from "./network-sentinel-assets.js";
import { verifyNetwork } from "../tooling/build-network.js";

type Assets = Record<string, Blob | string>;
const networkSources = {
  "/page.js": "network-page.ts",
  "/network-worker.js": "network-browser-worker.ts",
  "/network-sw.js": "network-browser-service-worker.ts",
  "/listener-preview1-worker.js": "../browser/preview1-worker.ts",
  "/network-fs.js": "../browser/fs-worker.ts",
};
const relaySources = {
  "/page.js": "network-relay-page.ts",
  "/relay-helper-worker.js": "network-relay-worker.ts",
  "/relay-preview1-worker.js": "../browser/preview1-worker.ts",
  "/relay-fs.js": "../browser/fs-worker.ts",
};
async function bundle(source: string, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, source)],
    target: "browser",
  });
  signal.throwIfAborted();
  if (!build.success || !build.outputs[0])
    throw new AggregateError(build.logs, `Network bundle failed: ${source}`);
  return build.outputs[0];
}
async function sources(entries: Record<string, string>, signal: AbortSignal): Promise<Assets> {
  const assets: Assets = { ...sentinelAssets };
  for (const [path, source] of Object.entries(entries)) assets[path] = await bundle(source, signal);
  return assets;
}
/** One normal input graph per command, prepared only inside the host's tracked assets operation. */
export function networkInputs() {
  let wasm: Promise<Blob> | undefined;
  let network: Promise<Assets> | undefined;
  let relay: Promise<Assets> | undefined;
  async function networkWasm(signal: AbortSignal): Promise<Blob> {
    signal.throwIfAborted();
    await verifyNetwork(resolve(import.meta.dir, ".."));
    signal.throwIfAborted();
    const bytes = await Bun.file(
      new URL("../browser/net/network.wasm", import.meta.url),
    ).arrayBuffer();
    signal.throwIfAborted();
    return new Blob([bytes], { type: "application/wasm" });
  }
  async function prepareNetwork({ signal }: PreparationContext): Promise<Assets> {
    signal.throwIfAborted();
    const listener = await preview1ListenerModule();
    signal.throwIfAborted();
    const assets = await sources(networkSources, signal);
    assets["/preview1-listener.wasm"] = new Blob([listener], { type: "application/wasm" });
    assets["/network.wasm"] = await (wasm ??= networkWasm(signal));
    signal.throwIfAborted();
    return assets;
  }
  async function prepareRelay({ signal }: PreparationContext): Promise<Assets> {
    signal.throwIfAborted();
    const modules = await relaySocketModules();
    signal.throwIfAborted();
    const assets = await sources(relaySources, signal);
    for (const [path, module] of modules)
      assets[path] = new Blob([module], { type: "application/wasm" });
    assets["/network.wasm"] = await (wasm ??= networkWasm(signal));
    signal.throwIfAborted();
    return assets;
  }
  return {
    network: (context: PreparationContext) => (network ??= prepareNetwork(context)),
    relay: (context: PreparationContext) => (relay ??= prepareRelay(context)),
  };
}
export type NetworkInputs = ReturnType<typeof networkInputs>;
