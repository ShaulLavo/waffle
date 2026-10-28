import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

const consumer = `
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".ts"))
      return nextLoad(url, context);
    return {
      format: "module",
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "strip", sourceUrl: url }),
      shortCircuit: true,
    };
  },
});
const entry = realpathSync(new URL(import.meta.resolve("waffle-git/program")));
assert.equal(entry, resolve("node_modules/waffle-git/src/program.ts"));
const { GitProgramConflictError, installGitProgram, GIT_CLI_URL } = await import("waffle-git/program");
const error = new GitProgramConflictError("/usr/bin/git");
assert.ok(error instanceof Error);
assert.equal(error.name, "GitProgramConflictError");
assert.equal(error.code, "GIT_PROGRAM_CONFLICT");
assert.equal(error.path, "/usr/bin/git");
assert.equal(error.message, "Cannot install git: a different filesystem entry already exists at /usr/bin/git");
assert.equal(typeof installGitProgram, "function");
assert.equal(GIT_CLI_URL.pathname, resolve("node_modules/waffle-git/dist/git-cli.js"));
`;

test("installed Git program export imports with Node's strip-only TypeScript loader", async (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "waffle-git-program-strip-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const gitRoot = resolve(import.meta.dirname, "..");
  const runtimeRoot = resolve(gitRoot, "../waffle");
  const git = resolve(root, "node_modules/waffle-git");
  const runtime = resolve(root, "node_modules/waffle");
  mkdirSync(git, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  cpSync(resolve(gitRoot, "src"), resolve(git, "src"), { recursive: true });
  cpSync(resolve(gitRoot, "package.json"), resolve(git, "package.json"));
  cpSync(resolve(runtimeRoot, "package.json"), resolve(runtime, "package.json"));
  writeFileSync(resolve(root, "package.json"), '{"private":true,"type":"module"}');
  writeFileSync(resolve(root, "consumer.mjs"), consumer);
  // Only Waffle's filesystem imports are prepared; Git's installed source stays TypeScript.
  const built = await Bun.build({
    entrypoints: [resolve(runtimeRoot, "fs/client.ts"), resolve(runtimeRoot, "fs/protocol.ts")],
    root: runtimeRoot,
    outdir: resolve(runtime, "dist"),
    naming: "[dir]/[name].js",
    target: "node",
  });
  assert.ok(built.success, String(built.logs));
  assert.deepEqual(
    readFileSync(resolve(git, "src/program.ts")),
    readFileSync(resolve(gitRoot, "src/program.ts")),
  );
  execFileSync("node", ["consumer.mjs"], { cwd: root, stdio: "pipe", timeout: 30_000 });
});
