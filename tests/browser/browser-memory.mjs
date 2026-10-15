import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { playwright, ready, run, session, writeFile } from "./playground.mjs";

const s = session("bun-wasm-browser-memory-");
const source = readFileSync(new URL("../src/memory-views.js", import.meta.url), "utf8");
const guest = readFileSync(new URL("../../tests/fixtures/memory-grow/index.js", import.meta.url), "utf8");
const expected = readFileSync(new URL("../../tests/fixtures/memory-grow/expected.txt", import.meta.url), "utf8").trim();

async function checkViews(page) {
  const results = await page.evaluate(async (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const { memoryViews } = await import(url);
    URL.revokeObjectURL(url);
    const results = [];
    for (const fallback of [false, true]) results.push(check(fallback));
    return results;

    function check(fallback) {
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
      if (fallback) Object.defineProperty(memory, "toResizableBuffer", { value: undefined });
      const views = memoryViews(memory);
      const bytes = views.bytes();
      const view = views.view();
      bytes[42] = 123;
      const copy = bytes.slice(40, 44);
      memory.grow(1);
      views.view().setUint32(65544, 0x12345678, true);
      memory.grow(0);
      return { fallback, persistent: typeof memory.toResizableBuffer === "function",
        sameBytes: views.bytes() === bytes, sameView: views.view() === view,
        length: views.bytes().length, before: views.bytes()[42], after: views.view().getUint32(65544, true),
        copy: Array.from(copy) };
    }
  }, source);
  for (const result of results) {
    assert.equal(result.sameBytes, result.persistent);
    assert.equal(result.sameView, result.persistent);
    assert.equal(result.length, 131072);
    assert.equal(result.before, 123);
    assert.equal(result.after, 0x12345678);
    assert.deepEqual(result.copy, [0, 0, 123, 0]);
  }
  return results;
}

async function checkBrowser(name, base) {
  const browser = await s.launch(playwright[name]);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(base);
    console.log(name, JSON.stringify(await checkViews(page)));
    for (const engine of ["quickjs", "jsc", "browser"]) await checkGuest(page, base, name, engine);
  } finally {
    await browser.close();
  }
}

async function checkGuest(page, base, name, engine) {
  await page.goto(`${base}?engine=${engine}`);
  assert.match(await ready(page), /ready/);
  await writeFile(page, "/home/user/grow.js", guest);
  const result = await run(page, "bun run grow.js", 120000);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.trim(), expected);
  console.log(`ok ${name}/${engine} guest allocation and host calls across growth`);
}

try {
  const base = await s.serve();
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"]) await checkBrowser(name, base);
} finally {
  await s.cleanup();
}
