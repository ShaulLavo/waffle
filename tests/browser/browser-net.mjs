// End-to-end networking test of the playground in real browsers (Chromium desktop, WebKit iPhone).
//   cd web && bun run build && node tests/browser-net.mjs [chromium|webkit …]
// Starts web/serve.ts and a local fixture server on another origin (no public internet), drives
// the terminal through `playground` (main.ts), and kills everything it started on exit.
// PLAYWRIGHT=<path to playwright/index.mjs> overrides the default mise install.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const web = join(here, "..");
const playwrightPath =
  process.env.PLAYWRIGHT ??
  `${process.env.HOME}/.local/share/mise/installs/npm-playwright/1.63.0/node_modules/.mise/playwright@1.63.0/node_modules/playwright/index.mjs`;
const { chromium, webkit, devices } = await import(playwrightPath);

const scratch = mkdtempSync("/work/tmp/bun-wasm-web-net-");
const children = [];
const browsers = [];
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const b of browsers) await b.close().catch(() => {});
  for (const c of children) c.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void cleanup().then(() => process.exit(130)));

/** Spawns `bun <args>` and resolves with the first stdout line matching `re`. */
function start(args, re, env = {}) {
  const child = spawn("bun", args, { cwd: web, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      const m = re.exec(out);
      if (m) resolve(m);
    });
    child.on("exit", (code) => reject(new Error(`bun ${args.join(" ")} exited ${code}: ${out}`)));
  });
}

// The fixture server: CORS-enabled routes, plus /nocors without CORS headers.
const fixture = join(scratch, "fixture.ts");
writeFileSync(
  fixture,
  `
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
  "access-control-expose-headers": "*",
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/nocors") return new Response("secret");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const reply = (body, init = {}) => {
      const res = body instanceof Response ? body : new Response(body, init);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    };
    switch (url.pathname) {
      case "/text": return reply("hello from the fixture");
      case "/json": return reply(Response.json({ ok: true, list: [1, 2, 3] }));
      case "/bytes": return reply(new Uint8Array([0, 1, 2, 253, 254, 255]));
      case "/big": return reply(new Uint8Array(3 * 1024 * 1024).fill(42));
      case "/status": return reply("teapot", { status: 418, statusText: "I'm a Teapot", headers: { "x-custom": "yes" } });
      case "/echo":
        return reply(Response.json({ method: req.method, path: url.pathname + url.search, test: req.headers.get("x-test"), type: req.headers.get("content-type"), body: await req.text() }), );
      default: return reply("not found", { status: 404 });
    }
  },
});
console.log("port", server.port);
`,
);

const fetchTest = (base) => `
const base = ${JSON.stringify(base)};
const t = await fetch(base + "/text");
console.log("text:", t.status, t.ok, t.headers.get("content-type"), await t.text());
console.log("json:", JSON.stringify(await (await fetch(base + "/json")).json()));
console.log("bytes:", Array.from(new Uint8Array(await (await fetch(base + "/bytes")).arrayBuffer())).join(","));
const echo = await fetch(base + "/echo?q=1", { method: "POST", headers: { "x-test": "abc", "content-type": "text/plain" }, body: "posted body" });
console.log("echo:", echo.status, JSON.stringify(await echo.json()));
const s = await fetch(base + "/status");
console.log("status:", s.status, s.statusText, s.ok, s.headers.get("x-custom"));
const big = await (await fetch(base + "/big")).arrayBuffer();
console.log("big:", big.byteLength, new Uint8Array(big)[big.byteLength - 1]);
try {
  await fetch(base + "/nocors");
  console.log("cors: no error");
} catch (err) {
  console.log("cors:", err instanceof TypeError, err.name + ": " + err.message);
}
console.log("FETCH-DONE");
`;

const serveTest = `
const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api") return Response.json({ hello: "preview", method: req.method, body: await req.text() });
    if (url.pathname === "/app.js") return new Response("document.title = 'app.js loaded';", { headers: { "content-type": "text/javascript" } });
    return new Response("<!doctype html><h1>preview ok " + url.pathname + "</h1><script src='/app.js'></script>", { headers: { "content-type": "text/html" } });
  },
});
console.log("listening on", server.url.href);
console.log("self:", await (await fetch(server.url.href + "api", { method: "POST", body: "me" })).text());
`;

const expectedFetch = (engine) => [
  "text: 200 true text/plain;charset=utf-8 hello from the fixture",
  'json: {"ok":true,"list":[1,2,3]}',
  "bytes: 0,1,2,253,254,255",
  'echo: 200 {"method":"POST","path":"/echo?q=1","test":"abc","type":"text/plain","body":"posted body"}',
  "status: 418 I'm a Teapot false yes",
  "big: 3145728 42",
  engine === "webkit" ? "cors: true TypeError: Load failed" : "cors: true TypeError: Failed to fetch",
];

async function terminalText(page) {
  return page.evaluate(() => {
    const buf = globalThis.playground.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      const text = line?.translateToString(true) ?? "";
      // Soft-wrapped rows continue the previous line.
      if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join("\n");
  });
}

async function waitFor(page, re, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const text = await terminalText(page);
    if (re.test(text)) return text;
    await page.waitForTimeout(200);
  }
  throw new Error(`timeout waiting for ${re}\n${await terminalText(page)}`);
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     ${detail}`}`);
  if (!ok) failures.push(name);
}

async function runEngine(name, type, options, appUrl, fixtureBase) {
  const browser = await type.launch();
  browsers.push(browser);
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors = [];
  // WebKit reports the deliberate CORS failure (/nocors) as a page error as well as rejecting.
  page.on("pageerror", (e) => /\/nocors due to access control checks/.test(String(e)) || errors.push(String(e)));
  await page.goto(appUrl);
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.startsWith("bun.wasm ready"), null, { timeout: 60000 });
  check(`${name}: page is cross-origin isolated`, await page.evaluate(() => crossOriginIsolated));

  // fetch
  await page.evaluate((src) => globalThis.playground.fs.writeFile("/home/user/net.ts", src), fetchTest(fixtureBase));
  await page.evaluate(() => globalThis.playground.shell.submit("bun run net.ts"));
  const out = await waitFor(page, /FETCH-DONE|error:|crashed/);
  for (const line of expectedFetch(name)) check(`${name}: ${line.split(":")[0]}`, out.includes(line), `expected ${JSON.stringify(line)} in\n${out}`);

  // Bun.serve preview through the service worker
  await page.evaluate((src) => globalThis.playground.fs.writeFile("/home/user/serve.ts", src), serveTest);
  await page.evaluate(() => void globalThis.playground.shell.submit("bun run serve.ts"));
  const served = await waitFor(page, /\[preview\][^\n]*__preview\/3000\/|error:|crashed/);
  check(`${name}: preview link printed`, /\[preview\] http:\/\/[^\s]+\/__preview\/3000\//.test(served), served.slice(-500));
  const self = await waitFor(page, /self: .*|error:/);
  check(`${name}: guest fetches its own server`, self.includes('self: {"hello":"preview","method":"POST","body":"me"}'), self.slice(-500));

  const preview = await context.newPage();
  const previewUrl = new URL("__preview/3000/some/page?x=1", appUrl).href;
  await preview.goto(previewUrl);
  await preview.waitForFunction(() => document.title === "app.js loaded", null, { timeout: 15000 }).catch(() => {});
  check(`${name}: preview page served`, (await preview.textContent("h1").catch(() => "")) === "preview ok /some/page");
  check(`${name}: root-relative subresource routed to the server`, (await preview.title()) === "app.js loaded");
  const api = await preview.evaluate(async () => (await fetch("/api", { method: "POST", body: "from page" })).json());
  check(`${name}: POST through the preview`, api.hello === "preview" && api.method === "POST" && api.body === "from page", JSON.stringify(api));
  check(`${name}: playground still isolated with the SW`, await page.evaluate(() => crossOriginIsolated));

  // Ctrl-C stops the server; the preview then reports nothing listening.
  await page.click(".xterm");
  await page.keyboard.press("Control+C");
  await waitFor(page, /\^C/);
  const after = await preview.goto(previewUrl);
  check(`${name}: preview gone after Ctrl-C`, after?.status() === 502, `status ${after?.status()}`);

  check(`${name}: no page errors`, errors.length === 0, errors.join("\n"));
  await browser.close();
}

try {
  const [, fixturePort] = await start([fixture], /port (\d+)/);
  const [, appUrl] = await start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, { PORT: "0" });
  // A different origin from the page: localhost vs 127.0.0.1.
  const app = appUrl.replace("127.0.0.1", "localhost");
  const fixtureBase = `http://127.0.0.1:${fixturePort}`;
  const engines = { chromium: [chromium, { viewport: { width: 1200, height: 900 } }], webkit: [webkit, devices["iPhone 15"]] };
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(engines);
  for (const name of wanted) {
    const [type, options] = engines[name];
    console.log(`== ${name}`);
    await runEngine(name, type, options, app, fixtureBase);
  }
} catch (err) {
  console.error(err);
  failures.push(String(err));
} finally {
  await cleanup();
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
