import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** The consumer's existing loader strips types; it never resolves missing .js files to .ts. */
export async function verifyPackedSearchHooks(consumer: string): Promise<void> {
  const loader = resolve(consumer, "search-strip.mjs");
  const entry = resolve(consumer, "search-hooks.mjs");
  await writeFile(
    loader,
    `
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
    return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), {
      mode: "strip", sourceUrl: url,
    }), shortCircuit: true };
  },
});
`,
  );
  await writeFile(
    entry,
    `
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fastGrep } from "waffle-grep";
import { fastRipgrep } from "waffle-ripgrep";
const require = createRequire(import.meta.url);
const runtime = realpathSync(require.resolve("waffle"));
for (const name of ["waffle-grep", "waffle-ripgrep"])
  assert.equal(realpathSync(require.resolve("waffle", { paths: [dirname(require.resolve(name))] })), runtime);
const workers = { search: "/search.js", shard: "/shard.js" };
let launched = 0;
for (const [factory, argv] of [
  [fastGrep, ["grep", "-racF", "needle", "."]],
  [fastRipgrep, ["rg", "--color", "never", "--no-ignore", "--hidden", "--text", "-cF", "needle", "."]],
]) {
  const program = factory(workers).programs[0];
  const context = { module: await WebAssembly.compile(readFileSync(program.wasm)),
    request: { argv, env: { PWD: "/", LC_ALL: "C" }, cwd: "/" } };
  await program.launch(context, { launchWorker(received, options) {
    assert.equal(received, context);
    assert.equal(options.request.module, context.module);
    assert.equal(options.request.args, argv);
    assert.equal(options.request.env, context.request.env);
    launched++;
    return { terminate() {} };
  } }, () => { throw Error("unexpected fallback"); });
}
assert.equal(launched, 2);
console.log(JSON.stringify({ packedNodeSearchHooks: launched, physicalRuntime: runtime }));
`,
  );
  execFileSync("node", ["--import", loader, entry], { cwd: consumer, stdio: "inherit" });
}
