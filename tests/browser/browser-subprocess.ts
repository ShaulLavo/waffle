// Fresh subprocess workers on the real browser worker bootstrap, across all wasm engines.
// cd web && bun run build && bun tests/browser-subprocess.ts [chromium|webkit]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { playwright, session, ready, writeFile, run } from "./playground.mjs";
const closedOutput = readFileSync(new URL("../../tests/fixtures/pipe-closed-child/index.ts", import.meta.url), "utf8");
const orderedOutput = readFileSync(new URL("../../tests/fixtures/pipe-write-order/index.ts", import.meta.url), "utf8");
const orderedChild = readFileSync(new URL("../../tests/fixtures/pipe-write-order/child.ts", import.meta.url), "utf8");
const stdinRace = readFileSync(new URL("../../tests/fixtures/pipe-stdin-race/index.ts", import.meta.url), "utf8");
const apiProgram = `
import { spawnSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const cmd = code => [process.execPath, "-e", code];
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
console.log("api exec", execSync("bun -e 'console.log(42)'", { encoding: "utf8" }).trim());
const timeout = spawnSync("bun", ["-e", "while(true){}"], { timeout: 100 });
console.log("api timeout", timeout.signal, timeout.error.code);
console.log("api cwd", Bun.spawnSync(cmd("0"), { cwd: "/missing-child-cwd" }).error.code);
`;
const apiExpected = ["api nodefsstdin 0 stdin", "api sync 0 fresh err", "api input 0 1200000", "api files 0 child shared", "api nested 0 0 99", "api exec 42", "api cycle 0 ab", "api timeout SIGTERM ETIMEDOUT", "api cwd ENOENT", "api live child", "api ack 0"];
process.env.BUN_WASM_TEST_PORT ??= "4183";
const s = session("bun-wasm-self-spawn-browser-");
const deadline = setTimeout(() => { console.error("subprocess browser gate timed out"); void s.cleanup().finally(() => process.exit(1)); }, 240_000);
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
    }
    await browser.close();
  }
} finally { clearTimeout(deadline); await s.cleanup(); }
