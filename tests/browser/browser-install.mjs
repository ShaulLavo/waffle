// cd web && bun run build && node tests/browser-install.mjs [chromium|webkit ...]
// ENGINES=browser,quickjs,jsc selects runtimes. Registry metadata and tarballs are local.
import assert from "node:assert/strict";
import { createRegistry } from "../../tests/install/registry.mjs";
import { playwright, ready, run, session, writeFile } from "./playground.mjs";

const task = session("bun-wasm-browser-install-");
let registry;
const failures = [];

async function command(page, text) {
  const result = await run(page, text);
  assert.equal(result.code, 0, `${text} exited ${result.code}\n${result.output}`);
  return result.output;
}

async function checkBrowser(browserName, runtime, url) {
  const type = playwright[browserName];
  assert.ok(type, `unknown browser ${browserName}`);
  const browser = await task.launch(type);
  const options = browserName === "webkit" ? playwright.devices["iPhone 15"] : { viewport: { width: 1200, height: 900 } };
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const external = [];
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    const host = url.protocol === "blob:" ? new URL(url.pathname).hostname : url.hostname;
    if (["127.0.0.1", "localhost"].includes(host)) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  try {
    await page.goto(`${url}?engine=${runtime}`);
    assert.match(await ready(page), /ready/);
    await writeFile(page, "/home/user/package.json", '{"name":"browser-install-fixture"}\n');
    await writeFile(page, "/home/user/bunfig.toml", `[install]\nregistry = ${JSON.stringify(registry.base)}\n`);
    const installed = await command(page, "bun add is-odd");
    assert.match(installed, /2 packages installed/);
    await writeFile(page, "/home/user/check-install.ts", 'import odd from "is-odd"; console.log("installed import:", odd(3), odd(4));\n');
    assert.match(await command(page, "bun run check-install.ts"), /installed import: true false/);
    assert.match(await command(page, "bun pm ls"), /is-odd@3\.0\.1/);
    await command(page, "bun add -D --exact @fixture/scoped@1.0.0");
    await writeFile(page, "/home/user/check-dev.ts", 'import scoped from "@fixture/scoped"; console.log("scoped import:", scoped);\n');
    assert.match(await command(page, "bun run check-dev.ts"), /scoped import: @fixture\/scoped@1\.0\.0/);
    await command(page, "rm -r node_modules .bun");
    assert.ok(await page.evaluate(async () => (await caches.open("bun-wasm-install-v1")).keys().then(keys => keys.length)) >= 3);
    registry.setOffline(true);
    try {
      await command(page, "bun i");
      assert.match(await command(page, "bun run check-install.ts"), /installed import: true false/);
    } finally { registry.setOffline(false); }
    await command(page, "bun remove is-odd");
    await writeFile(page, "/home/user/check-remove.ts", 'import fs from "node:fs"; const p = JSON.parse(fs.readFileSync("package.json", "utf8")); console.log("removed:", !p.dependencies?.["is-odd"], !fs.existsSync("node_modules/is-odd"));\n');
    assert.match(await command(page, "bun run check-remove.ts"), /removed: true true/);
    assert.deepEqual(external, [], "test attempted external network requests");
    console.log(`ok ${browserName}/${runtime}: add, import, scoped dev dependency, pm ls, cached i, remove`);
  } finally {
    registry.setOffline(false);
    await browser.close();
  }
}

try {
  registry = await createRegistry();
  const url = await task.serve();
  const browsers = process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"];
  const runtimes = (process.env.ENGINES ?? "browser,quickjs,jsc").split(",");
  for (const browser of browsers) {
    for (const runtime of runtimes) {
      try { await checkBrowser(browser, runtime, url); }
      catch (error) { failures.push(`${browser}/${runtime}`); console.error(`FAIL ${browser}/${runtime}\n${error.stack}`); }
    }
  }
  console.log(`${browsers.length * runtimes.length - failures.length} passed, ${failures.length} failed; ${registry.requests.length} local registry requests`);
} finally {
  await registry?.close();
  await task.cleanup();
}
process.exitCode = failures.length ? 1 : 0;
