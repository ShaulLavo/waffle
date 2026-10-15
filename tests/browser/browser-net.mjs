// End-to-end networking test of the playground in real browsers (Chromium desktop, WebKit iPhone).
//   cd web && bun run build && [ENGINES=browser,quickjs] [SLOTS=imports] node tests/browser-net.mjs [chromium|webkit …]
// Starts web/serve.ts and a local fixture server on another origin (no public internet), drives
// the terminal through `playground` (main.ts), and kills everything it started on exit.
// PLAYWRIGHT=<path to playwright/index.mjs> overrides the default mise install.
import { spawn } from "node:child_process";
import { mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
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
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    let cwd;
    try { cwd = readlinkSync(`/proc/${child.pid}/cwd`); } catch { continue; }
    if (cwd !== web) throw new Error(`Refusing to kill ${child.pid}: cwd ${cwd} differs from ${web}`);
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGKILL");
    await closed;
  }
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
    if (url.pathname === "/socket" && server.upgrade(req)) return;
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
  websocket: { message(ws, data) { ws.send(data); } },
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
let socketOrigin = "";
const server = Bun.serve({
  port: 3000,
  async fetch(req, srv) {
    if (new URL(req.url).pathname === "/socket") {
      socketOrigin = req.headers.get("origin") || "";
      const protocol = req.headers.get("sec-websocket-protocol");
      if (srv.upgrade(req, protocol ? { headers: { "sec-websocket-protocol": protocol.split(",")[0].trim() } } : {})) return;
    }
    const url = new URL(req.url);
    if (url.pathname === "/socket-origin") return new Response(socketOrigin);
    if (url.pathname === "/changed") return new Response(await Bun.file("/home/user/live.txt").text());
    if (url.pathname === "/api") return Response.json({ hello: "preview", method: req.method, body: await req.text() });
    if (url.pathname === "/app.js") return new Response("document.title = 'app.js loaded';", { headers: { "content-type": "text/javascript" } });
    return new Response("<!doctype html><h1>preview ok " + url.pathname + "</h1><script src='/app.js'></script>", { headers: { "content-type": "text/html" } });
  },
  websocket: { message(ws, data) { ws.send(data); } },
});
console.log("listening on", server.url.href);
console.log("self:", await (await fetch(server.url.href + "api", { method: "POST", body: "me" })).text());
await new Promise((resolve, reject) => {
  const ws = new WebSocket("ws://localhost:3000/socket");
  ws.onerror = reject;
  ws.onopen = () => ws.send("browser websocket");
  ws.onmessage = ({ data }) => { console.log("websocket:", data); ws.close(); };
  ws.onclose = resolve;
});
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

async function boundedEvaluate(page, callback, argument) {
  let timer;
  try {
    return await Promise.race([
      page.evaluate(callback, argument),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Preview check timed out after 15 seconds")), 15000); }),
    ]);
  } finally { clearTimeout(timer); }
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     ${detail}`}`);
  if (!ok) failures.push(name);
}

async function checkHtmlEntry(page, context, appUrl, name) {
  await page.evaluate(() => {
    const fs = globalThis.playground.fs;
    fs.writeFile("/home/user/index.html", '<!doctype html><title>HTML entry</title><link rel="stylesheet" href="./app.css"><h1 id="html-app"></h1><script type="module" src="./app.ts"></script>');
    fs.writeFile("/home/user/app.ts", 'const message: string = "bundled HTML entry"; document.querySelector("#html-app").textContent = message; if (import.meta.hot) { import.meta.hot.accept(); import.meta.hot.on("bun:ws:connect", () => { globalThis.__hmrConnected = true; }); }');
    fs.writeFile("/home/user/app.css", 'body { color: rgb(12, 34, 56); }');
  });
  await page.evaluate(() => void globalThis.playground.shell.submit("bun ./index.html"));
  const output = await waitFor(page, /Started development server:|error:|crashed/);
  check(`${name}: HTML CLI starts a server`, output.includes("Started development server:"), output.slice(-500));
  const preview = await context.newPage();
  const logs = [];
  const ownerLog = (message) => logs.push("owner: " + message.text());
  page.on("console", ownerLog);
  preview.on("console", (message) => logs.push(message.text()));
  preview.on("pageerror", (error) => logs.push(String(error)));
  try {
    const previewUrl = new URL("__preview/3000/", appUrl).href;
    await page.evaluate((url) => {
      const iframe = document.createElement("iframe");
      iframe.id = "hmr-fixture";
      iframe.src = url;
      document.body.append(iframe);
    }, previewUrl);
    await preview.goto(previewUrl);
    await preview.waitForFunction(() => document.querySelector("#html-app")?.textContent === "bundled HTML entry", null, { timeout: 15000 });
    check(`${name}: Bun bundles HTML and TypeScript`, await preview.textContent("#html-app") === "bundled HTML entry");
    check(`${name}: Bun bundles linked CSS`, await preview.evaluate(() => getComputedStyle(document.body).color) === "rgb(12, 34, 56)");
    await page.frameLocator("#hmr-fixture").locator("#html-app").waitFor({ timeout: 15000 });
    const iframe = page.frames().find((frame) => frame.url() === previewUrl);
    if (!iframe) throw new Error("Missing HTML HMR iframe");
    await Promise.all([preview.waitForFunction(() => globalThis.__hmrConnected, null, { timeout: 15000 }), iframe.waitForFunction(() => globalThis.__hmrConnected, null, { timeout: 15000 })]);
    const markers = await Promise.all([preview.evaluate(() => globalThis.__hmrVisit = crypto.randomUUID()), iframe.evaluate(() => globalThis.__hmrVisit = crypto.randomUUID())]);
    await page.evaluate(async () => {
      const helper = globalThis.playground.previews.servers.get(3000);
      const original = new TextDecoder().decode(globalThis.playground.fs.readFile("/home/user/app.ts"));
      const edited = original.replace("bundled HTML entry", "bundled HMR update");
      if (new TextEncoder().encode(original).length !== new TextEncoder().encode(edited).length) throw new Error("HMR fixture edit must preserve the file size");
      await helper.changeFile("/home/user/app.ts", edited);
    });
    await Promise.all([preview.waitForFunction(() => document.querySelector("#html-app")?.textContent === "bundled HMR update", null, { timeout: 15000 }), iframe.waitForFunction(() => document.querySelector("#html-app")?.textContent === "bundled HMR update", null, { timeout: 15000 })]);
    check(`${name}: Bun real HMR updates separate preview tab`, await preview.textContent("#html-app") === "bundled HMR update");
    check(`${name}: Bun real HMR updates iframe`, await iframe.textContent("#html-app") === "bundled HMR update");
    const after = await Promise.all([preview.evaluate(() => globalThis.__hmrVisit), iframe.evaluate(() => globalThis.__hmrVisit)]);
    check(`${name}: Bun real HMR preserves both documents`, after[0] === markers[0] && after[1] === markers[1]);
    await page.evaluate(async () => globalThis.playground.previews.servers.get(3000).changeFile("/home/user/app.css", 'body { color: rgb(98, 76, 54); }'));
    await Promise.all([preview.waitForFunction(() => getComputedStyle(document.body).color === "rgb(98, 76, 54)", null, { timeout: 15000 }), iframe.waitForFunction(() => getComputedStyle(document.body).color === "rgb(98, 76, 54)", null, { timeout: 15000 })]);
    check(`${name}: Bun real HMR updates CSS in both documents`, await preview.evaluate(() => getComputedStyle(document.body).color) === "rgb(98, 76, 54)" && await iframe.evaluate(() => getComputedStyle(document.body).color) === "rgb(98, 76, 54)");
  } catch (error) {
    throw new Error(`${error}\nPreview logs:\n${logs.join("\n")}\nTerminal:\n${await terminalText(page)}`);
  } finally {
    page.off("console", ownerLog);
    await preview.close();
    await page.evaluate(() => document.querySelector("#hmr-fixture")?.remove());
    await page.click(".xterm");
    await page.keyboard.press("Control+c");
    await waitFor(page, /\^C/);
  }
}

async function runEngine(browserName, engine, type, options, appUrl, fixtureBase) {
  const name = `${browserName}/${engine}`;
  const browser = await type.launch();
  browsers.push(browser);
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors = [];
  // WebKit reports the deliberate CORS failure (/nocors) as a page error as well as rejecting.
  page.on("pageerror", (e) => /\/nocors due to access control checks/.test(String(e)) || errors.push(String(e)));
  // SLOTS=imports|table picks how the wasm engines get the host functions (?slots=).
  await page.goto(`${appUrl}?engine=${engine}${process.env.SLOTS ? `&slots=${process.env.SLOTS}` : ""}`);
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.startsWith("bun.wasm ready"), null, { timeout: 60000 });
  check(`${name}: page is cross-origin isolated`, await page.evaluate(() => crossOriginIsolated));

  // fetch
  await page.evaluate((src) => globalThis.playground.fs.writeFile("/home/user/net.ts", src), fetchTest(fixtureBase));
  await page.evaluate(() => globalThis.playground.shell.submit("bun run net.ts"));
  const out = await waitFor(page, /FETCH-DONE|error:|crashed/);
  for (const line of expectedFetch(browserName)) check(`${name}: ${line.split(":")[0]}`, out.includes(line), `expected ${JSON.stringify(line)} in\n${out}`);

  await checkHtmlEntry(page, context, appUrl, name);

  // Bun.serve preview through the service worker
  await page.evaluate((src) => globalThis.playground.fs.writeFile("/home/user/serve.ts", src), serveTest);
  await page.evaluate(() => void globalThis.playground.shell.submit("bun run serve.ts"));
  const served = await waitFor(page, /\[preview\][^\n]*__preview\/3000\/|error:|crashed/);
  check(`${name}: preview link printed`, /\[preview\] http:\/\/[^\s]+\/__preview\/3000\//.test(served), served.slice(-500));
  const self = await waitFor(page, /self: .*|error:/);
  const websocket = await waitFor(page, /websocket: browser websocket|error:|crashed/);
  check(`${name}: guest WebSocket over virtual TCP`, websocket.includes("websocket: browser websocket"), websocket.slice(-500));
  check(`${name}: guest fetches its own server`, self.includes('self: {"hello":"preview","method":"POST","body":"me"}'), self.slice(-500));

  const preview = await context.newPage();
  preview.on("pageerror", (error) => errors.push(`preview: ${String(error)}`));
  const previewUrl = new URL("__preview/3000/some/page?x=1", appUrl).href;
  await preview.goto(previewUrl);
  await preview.waitForFunction(() => document.title === "app.js loaded", null, { timeout: 15000 }).catch(() => {});
  check(`${name}: preview page served`, (await preview.textContent("h1").catch(() => "")) === "preview ok /some/page");
  check(`${name}: root-relative subresource routed to the server`, (await preview.title()) === "app.js loaded");
  const api = await preview.evaluate(async () => (await fetch("/api", { method: "POST", body: "from page" })).json());
  check(`${name}: POST through the preview`, api.hello === "preview" && api.method === "POST" && api.body === "from page", JSON.stringify(api));
  check(`${name}: playground still isolated with the SW`, await page.evaluate(() => crossOriginIsolated));

  await page.evaluate(async () => {
    const helper = globalThis.playground.previews.servers.get(3000);
    await helper.changeFile("/home/user/live.txt", "x".repeat(80000) + "🌍");
  });
  const changed = await preview.evaluate(async () => (await fetch("/changed")).text());
  check(`${name}: file edit crosses blocked worker ring`, changed === "x".repeat(80000) + "🌍");
  await page.evaluate(async () => {
    const helper = globalThis.playground.previews.servers.get(3000);
    await Promise.all([helper.changeFile("/home/user/live.txt", "older"), helper.changeFile("/home/user/live.txt", "")]);
  });
  check(`${name}: file edits stay ordered and support empty files`, await preview.evaluate(async () => (await fetch("/changed")).text()) === "");

  const tunneled = await boundedEvaluate(preview, async () => {
    const socket = new WebSocket(new URL("/socket", location.href).href.replace(/^http/, "ws"), ["bun-hmr"]);
    socket.binaryType = "arraybuffer";
    const received = [];
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = (event) => reject(new Error(event.message || event.error?.message || "WebSocket error")); });
    const echo = (payload) => new Promise((resolve) => {
      socket.onmessage = ({ data }) => { received.push(data); resolve(); };
      socket.send(payload);
    });
    await echo("preview tunnel text");
    await echo(new Uint8Array([0, 1, 2, 253, 254, 255]));
    await echo(new Blob([new Uint8Array(80000).fill(42)]));
    socket.binaryType = "blob";
    await echo(new Uint8Array([7, 8, 9]));
    const close = await new Promise((resolve) => { socket.onclose = ({ code, reason, wasClean }) => resolve({ code, reason, wasClean }); socket.close(3001, "preview done"); });
    return {
      text: received[0], bytes: Array.from(new Uint8Array(received[1])),
      large: received[2].byteLength, blob: received[3] instanceof Blob && Array.from(new Uint8Array(await received[3].arrayBuffer())),
      close, standards: document.compatMode, protocol: socket.protocol, url: socket.url,
    };
  });
  check(`${name}: separate preview tab WebSocket text`, tunneled.text === "preview tunnel text");
  check(`${name}: preview WebSocket binary ArrayBuffer`, tunneled.bytes.join(",") === "0,1,2,253,254,255");
  check(`${name}: preview WebSocket large Blob send`, tunneled.large === 80000);
  check(`${name}: preview WebSocket Blob receive`, tunneled.blob.join(",") === "7,8,9");
  check(`${name}: preview WebSocket close handshake`, tunneled.close.code === 3001 && tunneled.close.reason === "preview done" && tunneled.close.wasClean, JSON.stringify(tunneled.close));
  check(`${name}: preview WebSocket sends browser Origin`, await preview.evaluate(async () => (await fetch("/socket-origin")).text()) === new URL(previewUrl).origin);
  check(`${name}: injected shim preserves doctype`, tunneled.standards === "CSS1Compat");
  check(`${name}: preview WebSocket negotiates Bun HMR protocol`, tunneled.protocol === "bun-hmr");
  check(`${name}: preview WebSocket keeps its visible URL`, tunneled.url === new URL("/socket", previewUrl).href.replace(/^http/, "ws"));

  const invalid = await boundedEvaluate(preview, async () => {
    const socket = new WebSocket(new URL("/bad-socket", location.href).href.replace(/^http/, "ws"));
    let errors = 0;
    socket.onerror = () => errors++;
    const close = await new Promise((resolve) => { socket.onclose = ({ code, wasClean }) => resolve({ code, wasClean }); });
    return { errors, close };
  });
  check(`${name}: preview rejects non-upgrade handshake`, invalid.errors === 1 && invalid.close.code === 1002 && !invalid.close.wasClean);
  const external = await boundedEvaluate(preview, async (url) => {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const reply = await new Promise((resolve) => { socket.onmessage = ({ data }) => resolve(data); socket.send("native external websocket"); });
    await new Promise((resolve) => { socket.onclose = resolve; socket.close(); });
    return { reply, instance: socket instanceof WebSocket };
  }, fixtureBase.replace(/^http/, "ws") + "/socket");
  check(`${name}: external WebSockets retain native networking`, external.reply === "native external websocket" && external.instance);

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
  // The default engine (browser) and one wasm engine: they share the networking host (src/net/).
  const runtimes = (process.env.ENGINES || "browser,quickjs").split(",");
  for (const name of wanted) {
    for (const engine of runtimes) {
      const [type, options] = engines[name];
      console.log(`== ${name} ${engine}`);
      await runEngine(name, engine, type, options, app, fixtureBase);
    }
  }
} catch (err) {
  console.error(err);
  failures.push(String(err));
} finally {
  await cleanup();
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
