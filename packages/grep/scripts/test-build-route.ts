import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { WasiGuestVerification } from "../../../tools/program-build-tools.ts";
import {
  buildGrep,
  familyRecipe,
  packageRoot,
  patchPath,
  readSourceLock,
  releaseDirectory,
  sourceFiles,
  workspaceRoot,
  type Execute,
} from "./build-grep.ts";

interface Call {
  command: string;
  args: readonly string[];
  cwd: string;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("grep builds pinned FreeBSD grep against the shared patched WASI sysroot", async (context) => {
  const lock = readSourceLock();
  const calls: Call[] = [];
  const execute: Execute = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return Buffer.alloc(0);
  };
  const checks: { path: string; options: WasiGuestVerification }[] = [];
  const scratchRoot =
    process.env.GREP_SCRATCH_ROOT ?? process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? tmpdir();
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(resolve(scratchRoot, "waffle-grep-route-"));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));

  await buildGrep({
    sourceDir: scratch,
    execute,
    sysrootCommand(recipe) {
      assert.deepEqual(recipe, familyRecipe);
      return ["flock", ["build.lock", "prepare"]];
    },
    buildConfig(recipe) {
      assert.deepEqual(recipe, familyRecipe);
      return {
        sdk: "/fake/wasi-sdk",
        builder: "/fake/build-wasi-libc.sh",
        directory: "/fake/.build/wasi-libc/id",
        sysroot: "/fake/.build/wasi-libc/id/sysroot",
        linker: "/fake/wasi-sdk/bin/clang",
        rustflags: [],
        identity: "fake-identity",
      };
    },
    verifier(path, options = {}) {
      checks.push({ path, options });
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    command: "flock",
    args: ["build.lock", "prepare"],
    cwd: workspaceRoot,
  });
  assert.deepEqual(calls[1], {
    command: "/fake/wasi-sdk/bin/clang",
    args: [
      "--target=wasm32-wasip1",
      "--sysroot=/fake/.build/wasi-libc/id/sysroot",
      "-D_GNU_SOURCE",
      "-Oz",
      `-ffile-prefix-map=${scratch}=freebsd-grep`,
      "-Wl,--max-memory=268435456",
      "-o",
      resolve(releaseDirectory, "grep.wasm"),
    ].concat(sourceFiles),
    cwd: scratch,
  });
  assert.deepEqual(checks, [
    { path: resolve(releaseDirectory, "grep.wasm"), options: { sdk: "/fake/wasi-sdk" } },
  ]);
  assert.equal(lock.upstream.revision, "16a79708d089423ec0c3d32f25e7ca97ae58e97b");
});

test("build recipe, patch, BSD-2-Clause license, and frozen usage fixtures match pins", () => {
  const lock = readSourceLock();
  const recipe: unknown = JSON.parse(
    readFileSync(resolve(packageRoot, "build-recipe.json"), "utf8"),
  );
  assert.ok(
    recipe &&
      typeof recipe === "object" &&
      "upstream" in recipe &&
      recipe.upstream &&
      typeof recipe.upstream === "object" &&
      "revision" in recipe.upstream &&
      "licenseSha256" in recipe.upstream &&
      "patch" in recipe &&
      recipe.patch &&
      typeof recipe.patch === "object" &&
      "sha256" in recipe.patch,
  );
  assert.equal(recipe.upstream.revision, lock.upstream.revision);
  assert.equal(recipe.upstream.licenseSha256, lock.upstream.licenseSha256);
  assert.equal(recipe.patch.sha256, sha256(readFileSync(patchPath)));
  assert.equal(
    sha256(readFileSync(resolve(packageRoot, lock.upstream.licensePath))),
    lock.upstream.licenseSha256,
  );
  const cases: unknown = JSON.parse(
    readFileSync(resolve(packageRoot, "tests/fixtures/grep-usage-cases.json"), "utf8"),
  );
  assert.ok(Array.isArray(cases) && cases.length >= 27);
  assert.match(readFileSync(patchPath, "utf8"), /import_module\("runtime_proc"\)/);
});
