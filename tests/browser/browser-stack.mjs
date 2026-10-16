// Stack overflow in browser workers: the stack-overflow fixtures on every engine, in Chromium and
// WebKit. `--measure` also runs tests/stack-depth.js: every recursion path at full depth must throw
// rather than trap, and the main paths get a capacity search. `--cold` measures in a fresh browser
// context per attempt, so the wasm runs in its engine's first tier (docs/stack-limits.md).
//   node tests/browser-stack.mjs [--measure [--cold]] [chromium] [webkit]
//   ENGINES=quickjs node tests/browser-stack.mjs --measure webkit
import { readFileSync } from 'node:fs';
import { firstVisit } from './first-visit.mjs';
import { playwright, ready, run, session, writeFile } from './playground.mjs';

const s = session('bun-wasm-web-stack-');
const engines = (process.env.ENGINES ?? 'quickjs,jsc,browser').split(',');
const args = process.argv.slice(2);
const measure = args.includes('--measure');
const cold = args.includes('--cold');
const browsers = args.filter((name) => !name.startsWith('--'));
if (!browsers.length) browsers.push('chromium', 'webkit');
const probe = readFileSync(new URL('../../tests/stack-depth.js', import.meta.url), 'utf8');
const modes = ['plain', 'getter', 'proxy', 'json', 'jsonplain', 'jsonparse', 'reviver', 'parse', 'block', 'arrow', 'unary',
  'power', 'ternary', 'statement', 'regexpnc', 'lookahead', 'proxychain', 'isarray', 'bound', 'join', 'flat', 'tostring',
  'async', 'promise', 'console'];
const searched = new Set(['plain', 'getter', 'proxy', 'json', 'parse', 'promise']);

async function fixtures(page, label) {
  for (const name of ['stack-overflow', 'stack-overflow-console']) {
    const base = new URL(`../../tests/fixtures/${name}/`, import.meta.url);
    await writeFile(page, `/home/user/${name}.js`, readFileSync(new URL('index.js', base), 'utf8'));
    const expected = readFileSync(new URL('expected.txt', base), 'utf8').trim();
    const result = await run(page, `bun run ${name}.js`);
    if (result.code !== 0 || result.output.trim() !== expected) {
      throw new Error(`${label} ${name}: exit ${result.code}\n${result.output}`);
    }
    console.log(`ok ${label} ${name}`);
  }
}

/** "completed", "caught:<error name>" or "trap" for one probe run. */
async function outcome(page, mode, n) {
  await writeFile(page, '/home/user/depth.js', probe);
  const r = await run(page, `bun run depth.js ${mode} ${n}`, 180000);
  if (r.code === 0 && /^completed /m.test(r.output) && r.output.includes('continued')) return 'completed';
  const caught = /^caught \w+ (\w+)/m.exec(r.output);
  return r.code === 0 && caught && r.output.includes('continued') ? `caught:${caught[1]}` : 'trap';
}

async function depth(attempt, label) {
  let trapped = false;
  for (const mode of modes) {
    // Each bind prefixes the name with "bound ", so deeper chains run out of memory first.
    let high = mode === 'bound' ? 2000 : 200000;
    const row = { host: label, mode, at_max: await attempt(mode, high) };
    if (searched.has(mode) && row.at_max !== 'completed') {
      let low = 0;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if ((await attempt(mode, middle)) === 'completed') low = middle;
        else high = middle;
      }
      Object.assign(row, { capacity: low, beyond: await attempt(mode, low + 1) });
    }
    console.log(JSON.stringify(row));
    trapped ||= row.at_max === 'trap' || row.beyond === 'trap';
  }
  return trapped;
}

async function openPage(browser, name, url, engine) {
  const context = await browser.newContext(name === 'webkit' ? playwright.devices['iPhone 13'] : {});
  const visit = await firstVisit(context, `${url}?engine=${engine}`);
  const page = await context.newPage();
  await page.goto(visit.url);
  await ready(page);
  return { page, close: async () => { await visit.close(); await context.close(); } };
}

async function checkEngine(browser, name, url, engine) {
  const label = `${name}/${engine}`;
  const opened = await openPage(browser, name, url, engine);
  try {
    if (measure) {
      const fresh = async (mode, n) => {
        const once = await openPage(browser, name, url, engine);
        try { return await outcome(once.page, mode, n); } finally { await once.close(); }
      };
      const trapped = await depth(cold ? fresh : (mode, n) => outcome(opened.page, mode, n), label);
      if (trapped) console.log(`trap ${label} (see rows above)`);
    }
    await fixtures(opened.page, label);
  } finally { await opened.close(); }
}

try {
  const url = await s.serve();
  for (const name of browsers) {
    const browser = await s.launch(playwright[name]);
    try {
      for (const engine of engines) await checkEngine(browser, name, url, engine);
    } finally { await browser.close(); }
  }
} finally { await s.cleanup(); }
