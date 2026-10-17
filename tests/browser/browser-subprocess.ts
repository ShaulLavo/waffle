// Fresh subprocess workers on the real browser worker bootstrap, across all wasm engines.
// cd web && bun run build && bun tests/browser-subprocess.ts [chromium|webkit]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { playwright, session, ready, writeFile, run } from "./playground.mjs";
import { checkWorkers } from "./browser-workers.ts";
const closedOutput = readFileSync(new URL("../../tests/fixtures/pipe-closed-child/index.ts", import.meta.url), "utf8");
const orderedOutput = readFileSync(new URL("../../tests/fixtures/pipe-write-order/index.ts", import.meta.url), "utf8");
const orderedChild = readFileSync(new URL("../../tests/fixtures/pipe-write-order/child.ts", import.meta.url), "utf8");
const stdinRace = readFileSync(new URL("../../tests/fixtures/pipe-stdin-race/index.ts", import.meta.url), "utf8");
const executableAliases = ["bun", "/bun", "/usr/local/bin/bun", "node", "/node", "/usr/local/bin/node"];
const apiProgram = `
import { spawnSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const cmd = code => [process.execPath, "-e", code];
for (const alias of ${JSON.stringify(executableAliases)}) {
  const child = Bun.spawnSync([alias, "-e", "console.log('alias-ready')"]);
  console.log("api alias", alias, child.exitCode, JSON.stringify(child.signalCode), JSON.stringify(child.error ?? null), child.stdout.toString().trim());
}
const missing = Bun.spawnSync(["bun-wasm-command-does-not-exist"]);
console.log("api unknown", missing.exitCode, JSON.stringify(missing.signalCode), JSON.stringify(missing.error ?? null), missing.success);
const sync = Bun.spawnSync(cmd("console.log(process.env.VALUE); console.error('err')"), { env: { VALUE: "fresh" } });
console.log("api sync", sync.exitCode, sync.stdout.toString().trim(), sync.stderr.toString().trim());
const input = Bun.spawn(cmd("console.log((await Bun.stdin.text()).length)"), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
input.stdin.end(new Uint8Array(1200000));
const inputText = new Response(input.stdout).text();
console.log("api input", await input.exited, (await inputText).trim());
const nodefs = Bun.spawn(cmd('console.log(require("node:fs").readFileSync(0,"utf8"))'), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
nodefs.stdin.end("stdin");
const nodefsText = new Response(nodefs.stdout).text();
console.log("api nodefsstdin", await nodefs.exited, (await nodefsText).trim());
mkdirSync("child-cwd", { recursive: true });
const files = Bun.spawn(cmd("await Bun.write('child.txt','shared'); console.log('child')"), { cwd: "child-cwd", stdout: "pipe", stderr: "pipe" });
const fileText = new Response(files.stdout).text();
console.log("api files", await files.exited, (await fileText).trim(), readFileSync("child-cwd/child.txt", "utf8"));
const live = Bun.spawn(cmd("require('node:fs').writeFileSync('live.txt','child'); console.log('written'); while(!require('node:fs').existsSync('ack.txt')) await Bun.sleep(5); console.log(require('node:fs').readFileSync('ack.txt','utf8'));"), { stdout: "pipe", stderr: "pipe" });
await live.stdout.getReader().read();
console.log("api live", readFileSync("live.txt", "utf8"));
writeFileSync("ack.txt", "parent");
console.log("api ack", await live.exited);
const nested = Bun.spawnSync(cmd("const p=Bun.spawnSync(['bun','-e','console.log(99)']); console.log(p.exitCode,p.stdout.toString().trim())"));
console.log("api nested", nested.exitCode, nested.stdout.toString().trim());
const cycle = Bun.spawnSync([process.execPath, "run", "cycle/a.js"]);
console.log("api cycle", cycle.exitCode, cycle.stdout.toString().trim());
if (cycle.exitCode !== 0) console.error("api cycle error", cycle.stderr.toString().trim());
console.log("api exec", execSync("bun -e 'console.log(42)'", { encoding: "utf8" }).trim());
const timeout = spawnSync("bun", ["-e", "while(true){}"], { timeout: 100, killSignal: "SIGKILL" });
console.log("api timeout", timeout.signal, timeout.error.code);
for (const code of [23, 143]) {
  // Keep the guest event loop live: a blocking stdin read cannot pump its signal handler.
  const child = Bun.spawn(cmd('process.on("SIGTERM", () => { console.log("term-handled"); process.exit(' + code + '); }); setInterval(() => {}, 1000); console.log("term-ready");'), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  try {
    const first = await reader.read();
    if (first.done || new TextDecoder().decode(first.value).trim() !== "term-ready") throw new Error("TERM child was not ready");
    child.kill("SIGTERM");
    // Retain stdout readiness before closing stdin, without requiring EOF to dispatch TERM.
    child.stdin.end();
    const handled = await reader.read();
    if (handled.done || new TextDecoder().decode(handled.value).trim() !== "term-handled") throw new Error("TERM handler did not acknowledge delivery");
    const exited = await child.exited;
    // The readiness read disturbed stdout; drain its existing reader, not a new Response body.
    while (!(await reader.read()).done) { /* Drain through EOF. */ }
    console.log("api term", code, exited, child.exitCode, JSON.stringify(child.signalCode), child.killed);
  } finally {
    reader.releaseLock();
  }
}
// No listener: a synchronous timeout must apply TERM's default, even before guest activation.
// Handled timeout testing would need a readiness channel before the timeout clock starts.
const timed = Bun.spawnSync(cmd("setInterval(() => {}, 1000)"), { timeout: 1, killSignal: "SIGTERM" });
console.log("api term timeout default", timed.exitCode, JSON.stringify(timed.signalCode), timed.exitedDueToTimeout, timed.success, JSON.stringify(timed.error ?? null));
for (const [signal, number] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGPIPE", 13]]) {
  for (const mode of ["default", "handled", "removed"]) {
    const ignored = signal === "SIGPIPE" && mode === "default";
    const code = 'const handler = () => process.exit(0); ' +
      (mode === "default" ? '' : 'process.on(' + JSON.stringify(signal) + ', handler); ') +
      (mode === "removed" ? 'process.removeListener(' + JSON.stringify(signal) + ', handler); ' : '') +
      'console.log("signal-ready"); ' +
      (ignored ? 'await Bun.stdin.text(); process.exit(17);' : 'setInterval(() => {}, 1000);');
    const child = Bun.spawn(cmd(code), { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL" });
    const reader = child.stdout.getReader();
    try {
      const first = await reader.read();
      if (first.done || new TextDecoder().decode(first.value).trim() !== "signal-ready") throw new Error("signal child was not ready");
      child.kill(signal);
      // Parent-side signal classification is synchronous. Only release the ignored child
      // after delivery, so an early ordinary exit cannot make this check pass accidentally.
      if (ignored) child.stdin.end();
      const exited = await child.exited;
      while (!(await reader.read()).done) { /* Drain the readiness reader through EOF. */ }
      const stderr = await new Response(child.stderr).text();
      if (stderr) throw new Error(stderr);
      console.log("api signal", mode, signal, exited, child.exitCode, JSON.stringify(child.signalCode));
      if (exited !== (ignored ? 17 : mode === "handled" ? 0 : 128 + number)) throw new Error("incorrect signal status");
      if (child.exitedDueToTimeout) throw new Error("signal child timed out");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      reader.releaseLock();
    }
  }
}
console.log("api cwd", Bun.spawnSync(cmd("0"), { cwd: "/missing-child-cwd" }).error.code);
`;
const apiExpected = [
  "api nodefsstdin 0 stdin", "api sync 0 fresh err", "api input 0 1200000", "api files 0 child shared",
  "api nested 0 0 99", "api exec 42", "api cycle 0 ab", "api timeout SIGKILL ETIMEDOUT", "api cwd ENOENT",
  "api live child", "api ack 0", "api unknown 127 null null false",
  "api term 23 23 23 null true", "api term 143 143 143 null true",
  'api term timeout default null "SIGTERM" true false null',
].concat(executableAliases.map(alias => `api alias ${alias} 0 null null alias-ready`), [["SIGINT", 130], ["SIGTERM", 143], ["SIGPIPE", 141]].flatMap(([signal, status]) => [
  signal === "SIGPIPE" ? "api signal default SIGPIPE 17 17 null" : `api signal default ${signal} ${status} null "${signal}"`,
  `api signal handled ${signal} 0 0 null`,
  `api signal removed ${signal} ${status} null "${signal}"`,
]));
const s = session("bun-wasm-self-spawn-browser-");
const deadline = setTimeout(() => { console.error("subprocess browser gate timed out"); void s.cleanup().finally(() => process.exit(1)); }, 900_000);
try {
  const url = await s.serve();
  for (const browserName of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"]) {
    const browser = await s.launch(playwright[browserName]);
    const page = await browser.newPage();
    await page.goto(url);
    await ready(page);
    for (const engine of ["quickjs", "jsc", "browser"]) {
      await page.goto(`${url}?engine=${engine}`);
      await ready(page);
      await writeFile(page, "/home/user/cycle/a.js", 'import { b } from "./b.js"; export function a() { return "a"; } console.log(b());');
      await writeFile(page, "/home/user/cycle/b.js", 'import { a } from "./a.js"; export function b() { return a() + "b"; }');
      await writeFile(page, "/home/user/subprocess-api.js", apiProgram);
      const api = await run(page, "bun run subprocess-api.js");
      assert.equal(api.code, 0, api.output);
      for (const line of apiExpected) assert.ok(api.output.includes(line), `missing ${line} in ${api.output}`);
      console.log(`ok ${browserName} ${engine}: Bun/Node subprocess APIs, nested workers, large stdin, cwd, files, timeout`);
      await writeFile(page, "/home/user/closed-output.ts", closedOutput);
      const closed = await run(page, "bun run closed-output.ts");
      assert.equal(closed.code, 0, closed.output);
      for (const stream of ["stdout", "stderr"]) {
        assert.ok(closed.output.includes(`closed child ${stream} false 1`), closed.output);
        assert.ok(closed.output.includes(`closed child ${stream} true 42`), closed.output);
        assert.ok(closed.output.includes(`closed inherited child ${stream} 42`), closed.output);
      }
      console.log(`ok ${browserName} ${engine}: closed child stdout/stderr reports EPIPE and exits`);
      await writeFile(page, "/child.ts", orderedChild);
      for (const [name, source] of [["pipe-write-order.ts", orderedOutput], ["pipe-stdin-race.ts", stdinRace]]) {
        await writeFile(page, `/home/user/${name}`, source);
        const checked = await run(page, `bun run ${name}`);
        assert.equal(checked.code, 0, checked.output);
        console.log(`ok ${browserName} ${engine}: ${name}`);
      }
      await checkWorkers(page, `${browserName} ${engine}`);
    }
    await browser.close();
  }
} finally { clearTimeout(deadline); await s.cleanup(); }
