// Fresh subprocess workers on the real browser worker bootstrap, across all wasm engines.
// cd web && bun run build && node tests/browser-subprocess.mjs [chromium|webkit]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { playwright, session, ready } from "./playground.mjs";
const source = readFileSync(new URL("../src/subprocess.js", import.meta.url), "utf8");
const s = session("bun-wasm-self-spawn-browser-");
try {
  const url = await s.serve();
  for (const browserName of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"]) {
    const browser = await s.launch(playwright[browserName]);
    const page = await browser.newPage();
    await page.goto(url);
    await ready(page);
    for (const engine of ["quickjs", "jsc", "browser"]) {
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
    }
    await browser.close();
  }
} finally { await s.cleanup(); }
