import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, firefox, webkit } from "playwright";
import { compileCommandGuests } from "../../packages/waffle/tests/fixtures/command-guests.ts";

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
  plugins: [
    {
      name: "coreutils workspace package",
      setup(build) {
        build.onResolve({ filter: /^@waffle-os\/coreutils$/ }, () => ({
          path: resolve(root, "packages/coreutils/src/index.ts"),
        }));
      },
    },
  ],
});
assert.ok(bundle.success, String(bundle.logs));
const guests = await compileCommandGuests();
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
    const guest = path.startsWith("/fixtures/") && guests.get(path.slice("/fixtures/".length));
    if (guest) return new Response(Uint8Array.from(guest), { headers });
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
      assert.ok(
        result && typeof result === "object" && "ok" in result && result.ok && "line" in result,
      );
      assert.equal(result.line, "hello from cat\n");
      const expectedStarts = errors.filter((error) =>
        /runtime: process controller failed (ExecutableNotFound|ExecutableNotRunnable|ExecutableFormatError)/.test(
          error,
        ),
      );
      assert.equal(expectedStarts.length, 7);
      assert.deepEqual(
        errors.filter((error) => !expectedStarts.includes(error)),
        [],
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.stop(true);
}
