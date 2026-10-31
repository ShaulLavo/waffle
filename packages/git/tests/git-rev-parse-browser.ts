import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { chromium, type Browser } from "@playwright/test";
import { BUN_WASM_ASSET } from "../node_modules/bun-wasm/src/guest-asset.generated.ts";

const root = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(
  join(process.env.GIT_SCRATCH ?? "/work/tmp", "waffle-rev-parse-browser-"),
);
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
const cleanup = async () => {
  await browser?.close();
  server?.stop(true);
  await rm(scratch, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void cleanup().finally(() => process.exit(1)));
try {
  const network = join(root, "node_modules/waffle/browser/net/network.wasm");
  assert.ok(
    await Bun.file(network).exists(),
    "prepare Waffle's real network asset before the browser smoke",
  );
  assert.ok(BUN_WASM_ASSET, "published Bun guest metadata missing");
  const response = await fetch(BUN_WASM_ASSET.url, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `published Bun guest: HTTP ${response.status}`);
  const downloaded = new Uint8Array(await response.arrayBuffer());
  const bytes =
    downloaded[0] === 0x1f && downloaded[1] === 0x8b ? gunzipSync(downloaded) : downloaded;
  assert.equal(bytes.length, BUN_WASM_ASSET.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), BUN_WASM_ASSET.sha256);
  await writeFile(join(scratch, "bun.wasm"), bytes);
  const built = await Bun.build({
    entrypoints: ["rev-parse", "fs-worker", "worker"].map((name) =>
      join(root, "tests/browser", `${name}.ts`),
    ),
    outdir: scratch,
    target: "browser",
    format: "esm",
    splitting: true,
  });
  assert.ok(built.success, built.logs.map(String).join("\n"));
  await writeFile(
    join(scratch, "index.html"),
    '<!doctype html><body><script type="module" src="/rev-parse.js"></script>',
  );
  const assets: Record<string, string> = {
    "/git-cli.js": join(root, "dist/git-cli.js"),
    "/dist/git-cli.js": join(root, "dist/git-cli.js"),
    "/network.wasm": network,
  };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const headers = {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cache-Control": "no-store",
      };
      const pathname = new URL(request.url).pathname;
      const path =
        assets[pathname] ?? resolve(scratch, `.${pathname === "/" ? "/index.html" : pathname}`);
      if (!assets[pathname] && !path.startsWith(scratch + sep))
        return new Response(null, { status: 403, headers });
      const file = Bun.file(path);
      if (!(await file.exists())) console.error(JSON.stringify({ missing: pathname }));
      return (await file.exists())
        ? new Response(file, { headers })
        : new Response(null, { status: 404, headers });
    },
  });
  browser = await chromium.launch({ headless: true });
  const tab = await browser.newPage();
  const errors: string[] = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.goto(`http://127.0.0.1:${server.port}/`);
  await tab.waitForFunction(() => Reflect.has(globalThis, "gitRevParseSmoke"));
  const result = await tab.evaluate(() => Reflect.get(globalThis, "gitRevParseSmoke")());
  console.log(
    JSON.stringify({ browser: browser.version(), asset: BUN_WASM_ASSET, result, errors }, null, 2),
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(errors, []);
  assert.equal(await tab.locator("body").getAttribute("data-disposed"), "true");
} finally {
  await cleanup();
  assert.equal(await Bun.file(join(scratch, "bun.wasm")).exists(), false);
  console.log(
    JSON.stringify({
      cleanup: { scratch, scratchRemoved: true, browserClosed: true, listenerStopped: true },
    }),
  );
}
