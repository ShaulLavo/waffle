import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { WasiGuestVerification } from "../../../tools/program-build-tools.ts";
import {
  buildGrep,
  familyRecipe,
  filesystemAdapter,
  packageRoot,
  releaseDirectory,
  targetDirectory,
  workspaceRoot,
  type Execute,
} from "./build-grep.ts";

interface Call {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

test("grep uses the cooperative family route and exact admission prefix", () => {
  const calls: Call[] = [];
  const execute: Execute = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
  };
  const checks: { path: string; options: WasiGuestVerification }[] = [];
  buildGrep({
    execute,
    environment(recipe, target) {
      assert.deepEqual(recipe, familyRecipe);
      assert.equal(recipe.root, workspaceRoot);
      assert.equal(recipe.waffle, resolve(workspaceRoot, "packages/waffle"));
      assert.equal(target, targetDirectory);
      return { CARGO_ENCODED_RUSTFLAGS: "fixture-flags" };
    },
    verifier(path, options = {}) {
      checks.push({ path, options });
    },
  });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.command, "cargo");
  assert.equal(call.cwd, workspaceRoot);
  assert.deepEqual(call.args, [
    "build",
    "--locked",
    "--release",
    "--target",
    "wasm32-wasip1",
    "--manifest-path",
    resolve(packageRoot, "Cargo.toml"),
    "-j2",
    "-p",
    "waffle-grep",
    "--bin",
    "grep",
    "--features",
    "cooperative-wasi",
  ]);
  assert.equal(call.env.CARGO_ENCODED_RUSTFLAGS, "fixture-flags");
  assert.deepEqual(checks, [
    { path: resolve(releaseDirectory, "grep.wasm"), options: { filesystemAdapter } },
  ]);
  assert.equal(filesystemAdapter, "waffle_program_support::runtime::wasi");
});

test("frozen grep fixtures, provenance and license texts retain their receipt hashes", () => {
  const receipt: unknown = JSON.parse(
    readFileSync(resolve(packageRoot, "provenance/relocation.json"), "utf8"),
  );
  assert.ok(receipt && typeof receipt === "object" && "entries" in receipt);
  assert.ok(Array.isArray(receipt.entries));
  let checked = 0;
  for (const entry of receipt.entries) {
    assert.ok(entry && typeof entry === "object" && "newPath" in entry);
    if (!("sha256" in entry)) continue;
    assert.equal(typeof entry.newPath, "string");
    assert.equal(typeof entry.sha256, "string");
    const bytes = readFileSync(resolve(workspaceRoot, entry.newPath));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, entry.newPath);
    checked++;
  }
  assert.equal(checked, 4);
});
