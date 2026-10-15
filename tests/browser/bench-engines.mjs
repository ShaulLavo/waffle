// Compares the playground's engines (QuickJS, JavaScriptCore-in-wasm, Browser (native)) in a real
// browser: wasm transfer size, page load to "ready", `console.log(1)` from Run click to exit (cold
// first run and warm runs), tests/bench/micro.js per section, and which seeded examples pass.
//   cd web && bun run build && node tests/bench-engines.mjs [chromium|webkit]
// ENGINES=quickjs,browser picks engines; RUNS (default 3) is the number of warm/micro runs (median).
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clickRun, playwright, ready, run, session, web, writeFile } from "./playground.mjs";

const browserName = process.argv[2] ?? "chromium";
const engines = (process.env.ENGINES ?? "quickjs,jsc,browser").split(",");
const runs = Number(process.env.RUNS ?? 3);
const wasmFile = { quickjs: "bun.wasm", jsc: "bun-jsc.wasm", browser: "bun-browser.wasm" };
const micro = readFileSync(join(web, "../tests/bench/micro.js"), "utf8");
const s = session("bun-wasm-web-engine-bench-");

// Seeded examples (src/examples.ts) and a few runtime features, with a marker of success.
const examples = [
  ["index.ts", "bun run index.ts", /cwd: \/home\/user/],
  ["files.ts", "bun run files.ts", /json: \{/],
  ["node-fs.ts", "bun run node-fs.ts", /out\/file-3\.txt file-3 /],
  ["timers.ts", "bun run timers.ts", /slept with Bun\.sleep/],
  ["jsx.tsx", "bun run jsx.tsx", /ship it<\/li>/],
  ["math.ts", "bun run math.ts", /fib\(20\) = 6765/],
  ["bun test", "bun test", /5 pass\s+0 fail/],
  ["db.ts", "bun run db.ts", /open todo/],
  ["bun build", "bun build math.ts --outdir out --minify && cat out/math.js", /export\{\w+ as fib/],
  ["bun -e", "bun -e 'console.log({ sum: [1,2,3].reduce((a,b)=>a+b) }, typeof Bun.version)'", /sum: 6[\s\S]*string/],
  ["Bun.sleepSync", "bun -e 'const t = performance.now(); Bun.sleepSync(100); console.log(\"slept\", performance.now() - t >= 95)'", /slept true/],
];

const median = (xs) => {
  const sorted = xs.toSorted((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};
const fmt = (ms) => (ms === undefined || ms === null ? "-" : `${Math.round(ms)}`);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function measure(type, engine, appUrl) {
  const out = { engine, sections: {} };
  try {
    out.gz = statSync(join(web, "dist", `${wasmFile[engine]}.gz`)).size;
  } catch {
    out.gz = null;
  }
  const browser = await s.launch(type);
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  const t0 = Date.now();
  await page.goto(`${appUrl}?engine=${engine}`);
  const status = await ready(page);
  out.ready = Date.now() - t0;
  out.status = status;
  if (!status.includes("ready")) {
    await browser.close();
    return out;
  }

  await writeFile(page, "/home/user/one.js", "console.log(1);\n");
  const cold = await clickRun(page, "/home/user/one.js");
  out.cold = cold.code === 0 ? cold.ms : null;
  const warm = [];
  for (let i = 0; i < runs; i++) {
    const r = await clickRun(page, "/home/user/one.js");
    if (r.code === 0) warm.push(r.ms);
  }
  out.warm = warm.length ? median(warm) : null;

  await writeFile(page, "/home/user/micro.js", micro);
  const sections = {};
  const totals = [];
  for (let i = 0; i < runs; i++) {
    const r = await run(page, "bun run micro.js", 300000);
    if (r.code !== 0) {
      out.microError = r.output.slice(-300);
      break;
    }
    totals.push(r.ms);
    for (const m of r.output.matchAll(/^(\w+)\s+(\d+) ms/gm)) (sections[m[1]] ??= []).push(Number(m[2]));
  }
  for (const [name, times] of Object.entries(sections)) out.sections[name] = median(times);
  out.microTotal = totals.length ? median(totals) : null;

  out.examples = {};
  for (const [name, command, marker] of examples) {
    const r = await run(page, command, 60000);
    out.examples[name] = r.code === 0 && marker.test(r.output) ? "pass" : `FAIL (exit ${r.code}): ${r.output.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 160)}`;
  }
  await browser.close();
  return out;
}

const results = [];
try {
  const appUrl = await s.serve();
  const type = playwright[browserName];
  for (const engine of engines) {
    console.error(`measuring ${engine} in ${browserName}…`);
    results.push(await measure(type, engine, appUrl));
  }
} finally {
  await s.cleanup();
}

const sectionNames = Array.from(new Set(results.flatMap((r) => Object.keys(r.sections))));
const header = ["engine", "wasm .gz", "page→ready ms", "console.log(1) cold ms", `warm ms (median of ${runs})`].concat(
  sectionNames.map((n) => `micro ${n} ms`),
  ["micro total ms (wall)"],
);
const rows = results.map((r) =>
  [r.engine, r.gz === null ? "missing" : mb(r.gz), fmt(r.ready), fmt(r.cold), fmt(r.warm)].concat(
    sectionNames.map((n) => fmt(r.sections[n])),
    [fmt(r.microTotal)],
  ),
);
console.log(`\n${browserName}, ${new Date().toISOString()}\n`);
console.log(`| ${header.join(" | ")} |`);
console.log(`| ${header.map(() => "---").join(" | ")} |`);
for (const row of rows) console.log(`| ${row.join(" | ")} |`);

console.log(`\nExamples (${browserName})\n`);
console.log(`| example | ${results.map((r) => r.engine).join(" | ")} |`);
console.log(`| --- | ${results.map(() => "---").join(" | ")} |`);
for (const [name] of examples) console.log(`| ${name} | ${results.map((r) => r.examples?.[name] ?? "-").join(" | ")} |`);
for (const r of results) {
  if (!r.status?.includes("ready")) console.log(`\n${r.engine}: ${r.status}`);
  if (r.microError) console.log(`\n${r.engine}: micro.js failed: ${r.microError}`);
}
