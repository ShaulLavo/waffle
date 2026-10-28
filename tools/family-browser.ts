import { chromium } from "playwright";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { basePackages } from "waffle-base";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, ".build/family-browser");
await mkdir(output, { recursive: true });
const assets = new Map(
  basePackages.flatMap((family) =>
    family.programs.map((program) => {
      assert.ok(program.wasm);
      return [program.path.split("/").at(-1) + ".wasm", program.wasm] as const;
    }),
  ),
);
const bundle = await Bun.build({
  entrypoints: [
    resolve(root, "tools/family-browser-app.ts"),
    resolve(root, "packages/waffle/browser/fs-worker.ts"),
    resolve(root, "packages/waffle/browser/preview1-worker.ts"),
  ],
  outdir: output,
  target: "browser",
  naming: "[name].js",
});
assert.ok(bundle.success, String(bundle.logs));
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/")
      return new Response('<!doctype html><body><script type="module" src="/app.js"></script>', {
        headers: { ...headers, "Content-Type": "text/html" },
      });
    const file = path.startsWith("/dist/") ? assets.get(path.slice(6)) : undefined;
    if (file) return new Response(Bun.file(file), { headers });
    if (["/app.js", "/fs-worker.js", "/preview1-worker.js"].includes(path))
      return new Response(
        Bun.file(resolve(output, path === "/app.js" ? "family-browser-app.js" : path.slice(1))),
        {
          headers: { ...headers, "Content-Type": "text/javascript" },
        },
      );
    return new Response("missing", { status: 404, headers });
  },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(server.url.href);
  await page.waitForSelector('body[data-done="true"]', { timeout: 60_000 });
  const result: unknown = JSON.parse(await page.locator("body").innerText());
  console.log(
    JSON.stringify({
      engine: "Chromium",
      result,
      disposed: await page.locator("body").getAttribute("data-disposed"),
      errors,
    }),
  );
  assert.ok(result && typeof result === "object" && "ok" in result && result.ok === true);
  assert.equal(await page.locator("body").getAttribute("data-disposed"), "true");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.stop(true);
  await rm(output, { recursive: true, force: true });
}
