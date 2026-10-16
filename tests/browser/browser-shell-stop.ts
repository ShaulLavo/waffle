import assert from "node:assert/strict";
import type { Page } from "playwright";
import { playwright, ready, run, session, writeFile } from "./playground.mjs";
import { stopShell } from "./stop-shell.ts";

const s = session("bun-wasm-shell-stop-");
const failures: string[] = [];

async function check(page: Page, base: string, browser: string, engine: string): Promise<void> {
  await page.goto(`${base}?engine=${engine}`);
  assert.match(await ready(page), /ready/);
  await writeFile(page, "/home/user/forever.ts", 'setInterval(() => {}, 1000); console.log("STOP_READY");');
  const done = page.evaluate(() => {
    const shell = Reflect.get(globalThis, "playground").shell;
    return shell.submit("bun run forever.ts").then(() => shell.lastExit);
  });
  await page.waitForFunction(() => {
    const buffer = Reflect.get(globalThis, "playground").term.buffer.active;
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true)).join("\n").includes("STOP_READY");
  });
  await page.evaluate(() => {
    const host = Reflect.get(Reflect.get(globalThis, "playground").shell, "host");
    const kill = host.kill.bind(host);
    host.kill = () => setTimeout(kill, 1000);
  });
  await stopShell(page);
  const idle = await page.evaluate(() => !Reflect.get(globalThis, "playground").shell.running);
  const name = `${browser}/${engine}`;
  if (!idle) failures.push(name);
  assert.equal(await done, 130);
  const result = await run(page, 'bun -e "console.log(42)"');
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.trim(), "42");
  console.log(`${idle ? "ok" : "FAIL"} ${name} stop waits for delayed shutdown before the next command`);
}

try {
  const base = await s.serve();
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"]) {
    const browser = await s.launch(playwright[name]);
    const page = await browser.newPage();
    for (const engine of ["quickjs", "jsc", "browser"]) await check(page, base, name, engine);
    await browser.close();
  }
  assert.deepEqual(failures, []);
} finally { await s.cleanup(); }
