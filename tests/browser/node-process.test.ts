import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const root = resolve(import.meta.dirname, "../..");

async function run(command: string[], env = process.env) {
  const child = Bun.spawn(command, { cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 90000 });
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, error: code ? stderr : "" }).toEqual({ code: 0, error: "" });
    return stdout;
  } finally { child.kill(); }
}

for (const artifact of ["bun.wasm", "bun-jsc.wasm", "bun-browser.wasm"]) {
  test.skipIf(!existsSync(resolve(root, "dist", artifact)))(`Node process slots and local registry fetch compose for ${artifact}`, async () => {
    const code = `const {Worker}=require('node:worker_threads'); const w=new Worker("require('node:worker_threads').parentPort.postMessage(42)",{eval:true}); w.on('message', value => console.log('worker', value));`;
    const output = await run(["node", "--no-warnings", "web/scripts/node-host.mjs", "--wasm", `dist/${artifact}`, "--", "-e", code]);
    expect(output).toContain("worker 42");
    const installed = await run(["node", "tests/install/run.mjs"], {
      ...process.env, INSTALL_ENGINE: "browser", BUN_WASM: `dist/${artifact}`, INSTALL_CASES: "aliases",
    });
    expect(installed).toContain("1 passed, 0 failed");
  }, 120000);
}
