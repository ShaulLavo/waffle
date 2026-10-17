// Real fresh bun-browser.wasm workers, including synchronous transport while this thread blocks.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { SubprocessHost, MAX_CHILDREN } from "../src/subprocess.ts";
import { launchNodeExecutable } from "../scripts/node-spawn.ts";

const module = await WebAssembly.compile(readFileSync(process.env.BUN_WASM_TEST_BROWSER_WASM || new URL("../../dist/bun-browser.wasm", import.meta.url)));
const scratch = mkdtempSync(join(process.env.BUN_WASM_TEST_TMP ?? tmpdir(), "bun-wasm-self-spawn-browser-"));
const inherited = [];
const host = new SubprocessHost({
  output: (fd, bytes) => inherited.push([fd, new TextDecoder().decode(bytes)]),
  launch(meta, transport, onError) {
    return launchNodeExecutable(meta, transport, () => {
      const worker = new Worker(new URL("../scripts/node-host.mjs", import.meta.url), {
        workerData: { bunwasmChild: true, module, preopens: { "/": scratch }, meta, transport, withNet: false },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
      worker.on("error", onError);
      return worker;
    });
  },
});
const encode = (text) => new TextEncoder().encode(text);
function spawn(source, options = {}) {
  return host.spawn(JSON.stringify({ argv: ["bun", "-e", source], cwd: "/", env: { CHILD_VALUE: "fresh" }, ...options }));
}
function collect(id) {
  const deadline = Date.now() + 15000;
  const outputs = [[], []];
  const pipes = [host.pipe(id, 1), host.pipe(id, 2)];
  let code;
  do {
    for (const [index, pipe] of pipes.entries()) {
      for (;;) {
        const value = host.read(pipe, 65536);
        if (typeof value === "number") break;
        outputs[index].push(Buffer.from(value));
      }
    }
    code = host.wait(id);
    if (Date.now() > deadline) throw new Error(`child ${id} timed out`);
    if (code === -2) host.poll(4);
  } while (code === -2);
  // Exit publishes EOF after all output writes, so one final read gets the tail.
  for (const [index, pipe] of pipes.entries()) {
    for (;;) {
      const value = host.read(pipe, 65536);
      if (typeof value === "number") break;
      outputs[index].push(Buffer.from(value));
    }
  }
  host.close(id);
  return { code, stdout: Buffer.concat(outputs[0]).toString(), stderr: Buffer.concat(outputs[1]).toString() };
}
try {
  const first = spawn('console.log(process.env.CHILD_VALUE, process.cwd(), process.argv.at(-1)); console.error("err"); process.exit(7)', { argv: ["bun", "-e", 'console.log(process.env.CHILD_VALUE, process.cwd(), process.argv.at(-1)); console.error("err"); process.exit(7)', "argument"] });
  assert.deepEqual(collect(first), { code: 7, stdout: "fresh / argument\n", stderr: "err\n" });
  mkdirSync(`${scratch}/nested`);
  writeFileSync(`${scratch}/nested/value.txt`, "cwd contents");
  const cwd = spawn('console.log(process.cwd(), require("node:fs").readFileSync("value.txt","utf8"))', { cwd: "/nested" });
  assert.deepEqual(collect(cwd), { code: 0, stdout: "/nested cwd contents\n", stderr: "" });
  const input = spawn('console.log(require("node:fs").readFileSync(0,"utf8"))');
  assert.equal(host.write(host.pipe(input, 0), encode("input text")), 10);
  host.close(host.pipe(input, 0));
  assert.deepEqual(collect(input), { code: 0, stdout: "input text\n", stderr: "" });
  const files = spawn('require("node:fs").writeFileSync("/shared.txt", "shared")');
  assert.equal(collect(files).code, 0);
  assert.equal(readFileSync(`${scratch}/shared.txt`, "utf8"), "shared");
  const large = spawn('process.stdout.write("x".repeat(1200000))');
  assert.equal(collect(large).stdout.length, 1200000);
  const inherit = spawn('console.log("inherited"); console.error("ignored")', { stdout: "inherit", stderr: "ignore" });
  assert.equal(collect(inherit).code, 0);
  assert.deepEqual(inherited, [[1, "inherited\n"]]);
  const infinite = spawn("while(true){}");
  assert.equal(host.kill(infinite, 9), 0);
  assert.equal(collect(infinite).code, 137);
  const ids = Array.from({ length: MAX_CHILDREN }, () => spawn("while(true){}"));
  assert.ok(ids.every((id) => id > 0));
  assert.equal(spawn("1"), -1);
  for (const id of ids) { host.kill(id, 9); assert.equal(collect(id).code, 137); }
  const missing = host.spawn(JSON.stringify({ argv: ["/bin/sh", "-c", "true"] }));
  assert.ok(missing > 1);
  assert.equal(collect(missing).code, 127);
  console.log("9 subprocess worker checks passed");
} finally {
  host.dispose();
  rmSync(scratch, { recursive: true, force: true });
}
