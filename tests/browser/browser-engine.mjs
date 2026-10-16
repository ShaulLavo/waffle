// Smoke test of the "Browser (native)" engine (?engine=browser) in Chromium desktop and WebKit iPhone.
//   cd web && bun run build && node tests/browser-engine.mjs [chromium|webkit …]
// ENGINE=quickjs|jsc runs the same checks on another engine.
// Needs web/dist/bun-browser.wasm.gz (dist/bun-browser.wasm from scripts/build-bun-browser.sh).
// Starts web/serve.ts and a CORS fixture server on another origin (no public internet); kills both on exit.
import { checkPhoneUI } from "./phone-ui.mjs";
import { firstVisit } from "./first-visit.mjs";
import { playwright, ready, run, session, terminalText, writeFile } from "./playground.mjs";
import { readFileSync, readdirSync } from "node:fs";

const { chromium, webkit, devices } = playwright;
const s = session("bun-wasm-web-engine-");
const HOME = "/home/user";
const engine = process.env.ENGINE ?? "browser";
const engineName = { quickjs: "QuickJS", jsc: "JavaScriptCore", browser: "Browser (native)" }[engine];

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     ${detail.replace(/\n/g, "\n     ")}`}`);
  if (!ok) failures.push(name);
}

/** Runs `command`, then checks its exit code and that every `want` string appears in its output. */
async function expectRun(page, label, command, code, want = [], not = []) {
  const r = await run(page, command);
  const missing = want.filter((w) => !r.output.includes(w));
  const unwanted = not.filter((w) => r.output.includes(w));
  check(`${label}: exit ${code}`, r.code === code, `exit ${r.code}\n${r.output}`);
  if (want.length || not.length) check(`${label}: output`, !missing.length && !unwanted.length, `missing ${JSON.stringify(missing)}, unwanted ${JSON.stringify(unwanted)} in\n${r.output}`);
  return r;
}

async function runBrowser(name, type, options, appUrl, fixtureBase) {
  const browser = await s.launch(type);
  const context = await browser.newContext(options);
  const visit = await firstVisit(context, `${appUrl}?engine=${engine}`);
  try {
    await checkPage(name, await context.newPage(), visit, fixtureBase);
  } finally {
    await browser.close();
    await visit.close();
  }
}

async function checkPage(name, page, visit, fixtureBase) {
  const errors = [];
  // WebKit reports the deliberate CORS failure (/nocors) as a page error as well as rejecting.
  page.on("pageerror", (e) => /\/nocors due to access control checks/.test(String(e)) || errors.push(String(e)));
  await page.goto(visit.url);
  const status = await ready(page);
  check(`${name}: status names the engine`, status.startsWith(`bun.wasm ready · ${engineName} ·`), status);
  check(`${name}: dropdown shows the engine`, (await page.inputValue("#engine")) === engine);
  if (!status.includes("ready")) return;

  await expectRun(page, `${name}: bun --version (native side)`, "bun --version", 0, [], ["error"]);
  await expectRun(page, `${name}: hello world (index.ts)`, "bun run index.ts", 0, ["Hello, world.", "Hello, Bun!", "cwd: /home/user"]);
  await visit.check(page, engine === "browser");
  check(`${name}: fresh visit waits for activation and serves worker bootstrap`, true);

  await writeFile(page, `${HOME}/lib/greet.ts`, `export interface Who { name: string }\nexport const greet = ({ name }: Who): string => \`hi \${name}\`;\nexport default 42;\n`);
  await writeFile(page, `${HOME}/app.ts`, `import answer, { greet, type Who } from "./lib/greet";\nconst who: Who = { name: "ts" };\nconsole.log(greet(who), answer satisfies number);\n`);
  await expectRun(page, `${name}: TS file importing another file`, "bun run app.ts", 0, ["hi ts 42"]);

  const callerFixture = new URL("../../tests/fixtures/caller-source-origin/", import.meta.url);
  for (const file of readdirSync(callerFixture).filter((file) => /\.[cm]?js$/.test(file))) {
    await writeFile(page, `${HOME}/caller-origin/${file}`, readFileSync(new URL(encodeURIComponent(file), callerFixture), "utf8"));
  }
  const callerOutput = readFileSync(new URL("expected.txt", callerFixture), "utf8").trim().split("\n")
    .map((line) => engine === "browser" && name === "webkit" && line === "cjs true" ? "cjs unavailable" : line);
  await expectRun(page, `${name}: caller source origin across modules and callbacks`, "bun run caller-origin/index.js", 0, callerOutput);

  const evalFixture = new URL("../../tests/fixtures/caller-source-origin-eval/", import.meta.url);
  for (const file of readdirSync(evalFixture).filter((file) => /\.[cm]?js$/.test(file))) {
    await writeFile(page, `${HOME}/caller-eval/${file}`, readFileSync(new URL(file, evalFixture), "utf8"));
  }
  const evalOutput = readFileSync(new URL("expected.txt", evalFixture), "utf8").trim().split("\n");
  await expectRun(page, `${name}: opaque eval caller origins`, "bun run caller-eval/index.js", 0, evalOutput);

  const taggedFixture = new URL("../../tests/fixtures/caller-source-origin-source-url/", import.meta.url);
  for (const file of ["index.js", "helper.mjs"]) {
    await writeFile(page, `${HOME}/caller-tagged/${file}`, readFileSync(new URL(file, taggedFixture), "utf8"));
  }
  const taggedOutput = readFileSync(new URL("expected.txt", taggedFixture), "utf8").trim().split("\n");
  await expectRun(page, `${name}: eval sourceURL and sourceMappingURL origins`, "bun run caller-tagged/index.js", 0, taggedOutput);

  // An import cycle with a hoisted function called before its module evaluated (the browser engine
  // needs the service worker's named module URLs for this).
  await writeFile(page, `${HOME}/cycle/a.ts`, `import { b } from "./b";\nexport function a(): string { return "a"; }\nexport let count = 0;\nexport function bump() { count++; }\nconsole.log("a sees", b());\n`);
  await writeFile(page, `${HOME}/cycle/b.ts`, `import { a } from "./a";\nexport function b(): string { return "b+" + a(); }\nconsole.log("b first:", a());\n`);
  await writeFile(page, `${HOME}/cycle/main.ts`, `import { bump, count } from "./a";\nbump();\nconsole.log("live count:", count);\n`);
  await expectRun(page, `${name}: import cycle`, "bun run cycle/main.ts", 0, ["b first: a", "a sees b+a", "live count: 1"]);

  await writeFile(page, `${HOME}/bytes.ts`, `import { readFileSync, writeFileSync } from "node:fs";\nconst bytes = new Uint8Array([1, 2, 3, 4]);\nwriteFileSync("view.bin", bytes.subarray(2));\nconsole.log("view bytes:", Array.from(readFileSync("view.bin")).join(","));\n`);
  await expectRun(page, `${name}: native APIs honor typed array byte offsets`, "bun run bytes.ts", 0, ["view bytes: 3,4"]);

  await writeFile(page, `${HOME}/throws.ts`, `console.log("before");\nthrow new Error("kaboom");\n`);
  await expectRun(page, `${name}: uncaught error`, "bun run throws.ts", 1, ["before", "kaboom"]);

  await writeFile(page, `${HOME}/rejects.ts`, `setTimeout(() => Promise.reject(new TypeError("late rejection")), 10);\n`);
  await expectRun(page, `${name}: unhandled rejection`, "bun run rejects.ts", 1, ["late rejection"]);

  await writeFile(page, `${HOME}/exit3.ts`, `console.log("exiting");\nsetTimeout(() => console.log("never"), 50);\nprocess.exit(3);\nconsole.log("after exit");\n`);
  await expectRun(page, `${name}: process.exit(3)`, "bun run exit3.ts", 3, ["exiting"], ["after exit", "never"]);

  await writeFile(page, `${HOME}/exit-later.ts`, `setTimeout(() => process.exit(4), 20);\n`);
  await expectRun(page, `${name}: process.exit(4) from a timer`, "bun run exit-later.ts", 4);

  await writeFile(
    page,
    `${HOME}/net.ts`,
    `const base = ${JSON.stringify(fixtureBase)};
console.log("json:", JSON.stringify(await (await fetch(base + "/json")).json()));
const echo = await fetch(base + "/echo", { method: "POST", headers: { "x-test": "abc" }, body: "posted" });
console.log("echo:", echo.status, JSON.stringify(await echo.json()));
try {
  await fetch(base + "/nocors");
  console.log("cors: no error");
} catch (err) {
  console.log("cors:", err instanceof TypeError);
}
`,
  );
  await expectRun(page, `${name}: fetch to a CORS server`, "bun run net.ts", 0, ['json: {"ok":true,"list":[1,2,3]}', 'echo: 200 {"method":"POST","test":"abc","body":"posted"}', "cors: true"]);

  // The terminal does not feed running programs: stdin is at end of input.
  await writeFile(
    page,
    `${HOME}/ask.ts`,
    `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const lines: string[] = [];
rl.on("line", (line) => lines.push(line));
rl.on("close", () => console.log("readline closed:", JSON.stringify(lines)));
`,
  );
  await expectRun(page, `${name}: readline sees end of input`, "bun run ask.ts", 0, ["readline closed: []"]);

  await writeFile(page, `${HOME}/shutdown.test.ts`, `import { test, afterAll } from "bun:test";
test("live interval", () => { setInterval(() => {}, 1000); });
afterAll(async () => { await Bun.sleep(5); console.log("cleanup finished"); });
`);
  await expectRun(page, `${name}: test exits with live handles after cleanup`, "bun test ./shutdown.test.ts", 0, ["cleanup finished", "1 pass", "0 fail"]);
  await writeFile(page, `${HOME}/rejection.test.ts`, `import { test, afterAll } from "bun:test";
test("live interval", () => { setInterval(() => {}, 1000); });
afterAll(async () => {
  await Bun.sleep(5);
  queueMicrotask(() => Promise.reject(new Error("shutdown rejection")));
});
`);
  await expectRun(page, `${name}: test reports pending rejections on shutdown`, "bun test ./rejection.test.ts", 1, ["shutdown rejection", "Unhandled error"]);

  // Ctrl-C ends a program that would run forever.
  await writeFile(page, `${HOME}/forever.ts`, `setInterval(() => {}, 1000);\nconsole.log("RUNNING");\n`);
  const pending = page.evaluate(() => globalThis.playground.shell.submit("bun run forever.ts").then(() => globalThis.playground.shell.lastExit));
  const t0 = Date.now();
  while (!/RUNNING/.test(await terminalText(page)) && Date.now() - t0 < 30000) await page.waitForTimeout(100);
  await page.click(".xterm");
  await page.keyboard.press("Control+C");
  check(`${name}: Ctrl-C exits 130`, (await pending) === 130);
  await expectRun(page, `${name}: runs again after Ctrl-C`, "bun run app.ts", 0, ["hi ts 42"]);

  await checkPhoneUI(page, "playground", name === "chromium");
  check(`${name}: phone layout and terminal copy`, true);

  check(`${name}: no page errors`, errors.length === 0, errors.join("\n"));
}

try {
  const fixtureBase = await s.fixture();
  // A different origin from the page: localhost vs 127.0.0.1.
  const appUrl = (await s.serve()).replace("127.0.0.1", "localhost");
  const browsers = { chromium: [chromium, { viewport: { width: 1200, height: 900 } }], webkit: [webkit, devices["iPhone 15"]] };
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(browsers);
  for (const name of wanted) {
    const [type, options] = browsers[name];
    console.log(`== ${name}`);
    await runBrowser(name, type, options, appUrl, fixtureBase);
  }
} catch (err) {
  console.error(err);
  failures.push(String(err));
} finally {
  await s.cleanup();
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
