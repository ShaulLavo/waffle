import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, firefox, webkit } from "playwright";

const engines = { chromium, firefox, webkit };
const root = resolve(import.meta.dirname, "../..");
const asset = process.env.COMMAND_CAT_WASM ?? resolve(root, "packages/coreutils/dist/cat.wasm");
assert.ok(existsSync(asset), "Set COMMAND_CAT_WASM to an existing packaged cat.wasm");
const bundle = await Bun.build({
  entrypoints: [
    resolve(import.meta.dirname, "page.ts"),
    resolve(root, "packages/waffle/browser/fs-worker.ts"),
    resolve(root, "packages/waffle/browser/preview1-worker.ts"),
  ],
  target: "browser",
  naming: "[name].js",
});
assert.ok(bundle.success, String(bundle.logs));
const outputs = new Map(bundle.outputs.map((file) => [file.path.replace(/^\./, ""), file]));
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/")
      return new Response(
        '<!doctype html><meta charset="utf-8"><body><script type="module" src="/page.js"></script>',
        {
          headers: { ...headers, "Content-Type": "text/html" },
        },
      );
    if (path === "/dist/cat.wasm") return new Response(Bun.file(asset), { headers });
    const output = outputs.get(path);
    if (output)
      return new Response(output, { headers: { ...headers, "Content-Type": "text/javascript" } });
    return new Response("missing", { status: 404, headers });
  },
});
try {
  for (const name of process.argv.slice(2)) {
    assert.ok(name === "chromium" || name === "firefox" || name === "webkit");
    const browser = await engines[name].launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (line) => {
        if (line.type() === "error") errors.push(line.text());
      });
      await page.goto(server.url.href);
      await page.waitForSelector('body[data-done="true"]', { timeout: 60_000 });
      const result: unknown = JSON.parse(await page.locator("body").innerText());
      console.log(JSON.stringify({ name, result, errors }));
      assert.deepEqual(result, { ok: true, line: "hello from cat\n" });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.stop(true);
}
