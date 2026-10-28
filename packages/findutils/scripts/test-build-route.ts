import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { WasiGuestVerification } from "../../../tools/program-build-tools.ts";
import {
  buildFindutils,
  familyRecipe,
  packageRoot,
  programNames,
  releaseDirectory,
  targetDirectory,
  workspaceRoot,
  type Execute,
} from "./build-findutils.ts";

interface Call {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

test("find and xargs share one ordinary WASI route with exact bins and verification", () => {
  const calls: Call[] = [];
  const execute: Execute = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
  };
  const checks: { path: string; options: WasiGuestVerification }[] = [];
  buildFindutils({
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
    "waffle-findutils-source",
    "--bin",
    "find",
    "--bin",
    "xargs",
  ]);
  assert.equal(call.env.CARGO_ENCODED_RUSTFLAGS, "fixture-flags");
  assert.deepEqual(
    checks,
    programNames.map((name) => ({ path: resolve(releaseDirectory, `${name}.wasm`), options: {} })),
  );
});

test("xargs-only qualification does not rebuild the unchanged find guest", () => {
  const calls: (readonly string[])[] = [];
  const checks: string[] = [];
  buildFindutils({
    programs: ["xargs"],
    execute(_command, args) {
      calls.push(args.slice());
    },
    environment: () => ({}),
    verifier: (path) => {
      checks.push(path);
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.slice(-2), ["--bin", "xargs"]);
  assert.equal(calls[0]?.includes("find"), false);
  assert.deepEqual(checks, [resolve(releaseDirectory, "xargs.wasm")]);
});
