import { resolve } from "node:path";
import { sha256Hex } from "../interrupt/admitted-store.js";
import {
  appendFixtureNameSection,
  buildFixtureSidecar,
  echoSizedGuestFixture,
  helperGuestModule,
  supervisedTrapGuestModule,
  trapGuestModule,
} from "./fixtures/interrupt-symbols-wasm.js";
import type { BrowserSidecarManifest, BrowserSymbolsReport } from "./interrupt-symbols-browser.js";
import { engines, runIsolatedPages } from "./isolated-page-runner.js";

const utf8 = new TextEncoder();

const sourceA = trapGuestModule(1);
const sourceB = trapGuestModule(2);
const supSource = supervisedTrapGuestModule();
const echoFixture = echoSizedGuestFixture();
const helperNamedBytes = appendFixtureNameSection(helperGuestModule(103), {
  moduleName: "helper_stream_mod",
});

// Compact canonical sidecars matching #608's exact schema. Note: def 4 (trap_div0) is null.
const guestA = await buildFixtureSidecar(sourceA, 2, [
  "_start",
  "outer",
  "inner_trap",
  "call_bridge",
  null,
  "recurse",
]);
const guestB = await buildFixtureSidecar(sourceB, 2, [
  "_start_b",
  "outer_b",
  "inner_trap_b",
  "call_bridge_b",
  "trap_div0_b",
  "recurse_b",
]);
const supervised = await buildFixtureSidecar(supSource, 1, ["sup_start", "sup_inner_trap"]);
const echoSized = await buildFixtureSidecar(
  echoFixture.wasm,
  echoFixture.importedFunctions,
  echoFixture.names,
);
const malformedBytes = new Uint8Array(utf8.encode("{"));
const malformedSha = await sha256Hex(malformedBytes);
const emptyNameBytes = new Uint8Array(
  utf8.encode(
    JSON.stringify({
      version: 1,
      source: { bytes: sourceA.byteLength, sha256: await sha256Hex(sourceA) },
      named: { bytes: sourceA.byteLength + 128, sha256: "f".repeat(64) },
      importedFunctions: 2,
      names: ["_start", "", "inner_trap", "call_bridge", null, "recurse"],
    }),
  ),
);
const emptyNameSha = await sha256Hex(emptyNameBytes);

const manifest: BrowserSidecarManifest = {
  guestA: { url: "/sidecars/guest-a.json", bytes: guestA.bytes.byteLength, sha256: guestA.sha256 },
  guestB: { url: "/sidecars/guest-b.json", bytes: guestB.bytes.byteLength, sha256: guestB.sha256 },
  supervised: {
    url: "/sidecars/supervised.json",
    bytes: supervised.bytes.byteLength,
    sha256: supervised.sha256,
  },
  wrongSource: {
    url: "/sidecars/wrong-source.json",
    bytes: guestB.bytes.byteLength,
    sha256: guestB.sha256,
  },
  malformed: {
    url: "/sidecars/malformed.json",
    bytes: malformedBytes.byteLength,
    sha256: malformedSha,
  },
  emptyName: {
    url: "/sidecars/empty-name.json",
    bytes: emptyNameBytes.byteLength,
    sha256: emptyNameSha,
  },
  missing: {
    url: "/sidecars/missing.json",
    bytes: guestA.bytes.byteLength,
    sha256: guestA.sha256,
  },
  disabledSentinel: {
    url: "/sidecars/disabled-sentinel.json",
    bytes: guestA.bytes.byteLength,
    sha256: guestA.sha256,
  },
  echoSized: {
    url: "/sidecars/echo-sized.json",
    bytes: echoSized.bytes.byteLength,
    sha256: echoSized.sha256,
  },
};

const sidecarPayloads = new Map<string, Uint8Array<ArrayBuffer>>([
  [manifest.guestA.url, guestA.bytes],
  [manifest.guestB.url, guestB.bytes],
  [manifest.supervised.url, supervised.bytes],
  [manifest.wrongSource.url, guestB.bytes],
  [manifest.malformed.url, malformedBytes],
  [manifest.emptyName.url, emptyNameBytes],
  [manifest.disabledSentinel.url, guestA.bytes],
  [manifest.echoSized.url, echoSized.bytes],
]);

let disabledSentinelHits = 0;

await runIsolatedPages({
  label: "interrupt-symbols-browser",
  scratchRoot: resolve(process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp"),
  scratchPrefix: "wsym-",
  port: 0,
  sources: {
    "/tests.js": "interrupt-symbols-browser.ts",
    "/worker.js": "fixtures/interrupt-symbols-worker.ts",
  },
  route(path, headers) {
    if (path === "/helper-named.wasm") {
      return new Response(helperNamedBytes, {
        headers: { ...headers, "Content-Type": "application/wasm" },
      });
    }
    if (path === manifest.disabledSentinel.url) disabledSentinelHits++;
    const payload = sidecarPayloads.get(path);
    if (!payload) return undefined;
    return new Response(payload, {
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": String(payload.byteLength),
      },
    });
  },
  names: process.argv.length > 2 ? process.argv.slice(2) : Object.keys(engines),
  async evaluate(page): Promise<BrowserSymbolsReport> {
    const beforeHits = disabledSentinelHits;
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    const report = await page.evaluate(async (sidecars) => {
      const path = "/tests.js";
      const mod: typeof import("./interrupt-symbols-browser.js") = await import(path);
      return mod.runInterruptSymbolsBrowser(sidecars);
    }, manifest);
    if (pageErrors.length) throw new Error(`pageerror: ${pageErrors.join("; ")}`);
    if (disabledSentinelHits !== beforeHits) {
      throw new Error(
        `disabled diagnostics requested sentinel sidecar ${disabledSentinelHits - beforeHits} times`,
      );
    }
    return report;
  },
});
