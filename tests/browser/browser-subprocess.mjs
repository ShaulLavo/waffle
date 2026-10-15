// Fresh subprocess workers on the real browser worker bootstrap, across all wasm engines.
// cd web && bun run build && node tests/browser-subprocess.mjs [chromium|webkit]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { playwright, session, ready, writeFile, run } from "./playground.mjs";
const source = readFileSync(new URL("../src/subprocess.js", import.meta.url), "utf8");
const apiProgram = `
import { spawnSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
const cmd = code => [process.execPath, "-e", code];
const sync = Bun.spawnSync(cmd("console.log(process.env.VALUE); console.error('err')"), { env: { VALUE: "fresh" } });
console.log("api sync", sync.exitCode, sync.stdout.toString().trim(), sync.stderr.toString().trim());
const input = Bun.spawn(cmd("console.log((await Bun.stdin.text()).length)"), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
input.stdin.end(new Uint8Array(1200000));
const inputText = new Response(input.stdout).text();
console.log("api input", await input.exited, (await inputText).trim());
mkdirSync("child-cwd", { recursive: true });
const files = Bun.spawn(cmd("await Bun.write('child.txt','shared'); console.log('child')"), { cwd: "child-cwd", stdout: "pipe", stderr: "pipe" });
const fileText = new Response(files.stdout).text();
console.log("api files", await files.exited, (await fileText).trim(), readFileSync("child-cwd/child.txt", "utf8"));
const nested = Bun.spawnSync(cmd("const p=Bun.spawnSync(['bun','-e','console.log(99)']); console.log(p.exitCode,p.stdout.toString().trim())"));
console.log("api nested", nested.exitCode, nested.stdout.toString().trim());
const cycle = Bun.spawnSync([process.execPath, "run", "cycle/a.js"]);
console.log("api cycle", cycle.exitCode, cycle.stdout.toString().trim());
console.log("api exec", execSync("bun -e 'console.log(42)'", { encoding: "utf8" }).trim());
const timeout = spawnSync("bun", ["-e", "while(true){}"], { timeout: 100 });
console.log("api timeout", timeout.signal, timeout.error.code);
console.log("api cwd", Bun.spawnSync(cmd("0"), { cwd: "/missing-child-cwd" }).error.code);
`;
const apiExpected = ["api sync 0 fresh err", "api input 0 1200000", "api files 0 child shared", "api nested 0 0 99", "api exec 42", "api cycle 0 ab", "api timeout SIGTERM ETIMEDOUT", "api cwd ENOENT"];
const s = session("bun-wasm-self-spawn-browser-");
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
      const result = await page.evaluate(async ({ source, engine }) => {
        const { SubprocessHost } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
        const wasm = engine === "quickjs" ? "bun.wasm" : `bun-${engine}.wasm`;
        const compressed = await fetch(`/${wasm}.gz`);
        const bytes = await new Response(compressed.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
        const module = await WebAssembly.compile(bytes);
        let snapshot;
        const host = new SubprocessHost({
          sync: (value) => { snapshot = value; },
          output: () => {},
          launch(meta, transport, onError) {
            const worker = new Worker("/__bunwasm/worker.js", { type: "module" });
            worker.onerror = onError;
            worker.postMessage({ engine, module, root: { kind: "dir", children: new Map(), mtime: 0, ino: 1 }, args: meta.argv, env: meta.env, net: null, trace: false, moduleCache: null, child: transport });
            return worker;
          },
        });
        try {
          const id = host.spawn(JSON.stringify({ argv: ["bun", "-e", 'console.log(process.env.VALUE); console.log(require("node:fs").readFileSync(0,"utf8")); require("node:fs").writeFileSync("/child.txt","from child"); console.error("stderr"); process.exit(7)'], env: { VALUE: "fresh", PWD: "/" }, cwd: "/" }));
          host.write(host.pipe(id, 0), new TextEncoder().encode("stdin"));
          host.close(host.pipe(id, 0));
          const deadline = Date.now() + 20000;
          const output = ["", ""];
          let code;
          do {
            code = host.wait(id);
            for (const fd of [1, 2]) {
              for (;;) {
                const bytes = host.read(host.pipe(id, fd));
                if (typeof bytes === "number") break;
                output[fd - 1] += new TextDecoder().decode(bytes);
              }
            }
            if (Date.now() > deadline) throw new Error(`child timed out: ${output}`);
            if (code === -2) await new Promise((resolve) => setTimeout(resolve, 4));
          } while (code === -2);
          return { code, output, snapshot };
        } finally { host.dispose(); }
      }, { source, engine });
      assert.deepEqual(result.output, ["fresh\nstdin\n", "stderr\n"], `${browserName} ${engine}`);
      assert.equal(result.code, 7);
      assert.match(result.snapshot, /child.txt/);
      console.log(`ok ${browserName} ${engine}: argv/env/stdin/stdout/stderr/exit/filesystem`);
      await writeFile(page, "/home/user/cycle/a.js", 'import { b } from "./b.js"; export function a() { return "a"; } console.log(b());');
      await writeFile(page, "/home/user/cycle/b.js", 'import { a } from "./a.js"; export function b() { return a() + "b"; }');
      await writeFile(page, "/home/user/subprocess-api.js", apiProgram);
      const api = await run(page, "bun run subprocess-api.js");
      assert.equal(api.code, 0, api.output);
      for (const line of apiExpected) assert.ok(api.output.includes(line), `missing ${line} in ${api.output}`);
      console.log(`ok ${browserName} ${engine}: Bun/Node subprocess APIs, nested workers, large stdin, cwd, files, timeout`);
    }
    await browser.close();
  }
} finally { await s.cleanup(); }
