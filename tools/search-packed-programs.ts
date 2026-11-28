import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** The consumer's existing loader strips types; it never resolves missing .js files to .ts. */
export async function verifyPackedSearchPrograms(consumer: string): Promise<void> {
  const loader = resolve(consumer, "search-strip.mjs");
  const entry = resolve(consumer, "search-programs.mjs");
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
import { grep } from "@waffle-os/grep";
import { ripgrep } from "@waffle-os/ripgrep";
const require = createRequire(import.meta.url);
const runtime = realpathSync(require.resolve("@waffle-os/runtime"));
for (const name of ["@waffle-os/grep", "@waffle-os/ripgrep"])
  assert.equal(realpathSync(require.resolve("@waffle-os/runtime", { paths: [dirname(require.resolve(name))] })), runtime);
for (const { programs } of [grep, ripgrep]) {
  assert.equal(programs.length, 1);
  const [program] = programs;
  assert.equal(program.launch, undefined);
  const module = await WebAssembly.compile(readFileSync(program.wasm));
  assert.ok(WebAssembly.Module.exports(module).some(({ name }) => name === "_start"));
}
console.log(JSON.stringify({ packedNodeSearchPrograms: [grep.name, ripgrep.name], physicalRuntime: runtime }));
`,
  );
  execFileSync("node", ["--import", loader, entry], { cwd: consumer, stdio: "inherit" });
}
