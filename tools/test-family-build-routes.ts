import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { WasiGuestVerification } from "./program-build-tools.ts";
import {
  familyRecipe as ripgrepRecipe,
  packageRoot as ripgrepRoot,
  targetDirectory as ripgrepTarget,
  targetRoot as ripgrepTargetRoot,
  workspaceRoot,
} from "../packages/ripgrep/scripts/build-config.ts";
import { buildRipgrep, type Execute } from "../packages/ripgrep/scripts/build-rg.ts";
import {
  familyRecipe as sedRecipe,
  packageRoot as sedRoot,
  releaseDirectory as sedRelease,
  targetDirectory as sedTarget,
} from "../packages/sed/scripts/build-config.ts";
import { buildSed } from "../packages/sed/scripts/build-sed.ts";

interface Call {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function capture() {
  const calls: Call[] = [];
  const execute: Execute = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
  };
  return { calls, execute };
}

function onlyCall(calls: Call[]) {
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  return call;
}

test("sed uses its own Cargo route and the singular patched-sysroot recipe", () => {
  const { calls, execute } = capture();
  const checks: { path: string; options: WasiGuestVerification }[] = [];
  buildSed({
    execute,
    locales: ({ env, program }) => ({
      ...env,
      CARGO_TARGET_DIR: resolve(workspaceRoot, sedTarget),
      WAFFLE_PROGRAM_LOCALE_INPUTS: program,
    }),
    environment(recipe, target) {
      assert.deepEqual(recipe, sedRecipe);
      assert.equal(recipe.root, workspaceRoot);
      assert.equal(recipe.waffle, resolve(workspaceRoot, "packages/waffle"));
      assert.equal(target, sedTarget);
      return { CARGO_ENCODED_RUSTFLAGS: "fixture-flags" };
    },
    verifier(path, options = {}) {
      checks.push({ path, options });
    },
  });
  const call = onlyCall(calls);
  assert.equal(call.command, "flock");
  assert.equal(call.cwd, workspaceRoot);
  assert.deepEqual(call.args.slice(5), [
    "build",
    "--locked",
    "--release",
    "--target",
    "wasm32-wasip1",
    "--manifest-path",
    resolve(sedRoot, "Cargo.toml"),
    "-j2",
    "-p",
    "shell-sed",
    "--bin",
    "sed",
  ]);
  assert.equal(call.env.CARGO_ENCODED_RUSTFLAGS, "fixture-flags");
  assert.deepEqual(checks, [{ path: resolve(sedRelease, "sed.wasm"), options: {} }]);
});

test("ripgrep retains its pinned Cargo flags, release settings and final verification", async () => {
  const { calls, execute } = capture();
  const checks: { path: string; options: WasiGuestVerification }[] = [];
  let prepared = 0;
  await buildRipgrep({
    execute,
    async prepare() {
      prepared++;
    },
    environment(recipe, target) {
      assert.deepEqual(recipe, ripgrepRecipe);
      assert.equal(recipe.root, workspaceRoot);
      assert.equal(recipe.waffle, resolve(workspaceRoot, "packages/waffle"));
      assert.equal(target, ripgrepTarget);
      return { CARGO_ENCODED_RUSTFLAGS: "fixture-flags" };
    },
    verifier(path, options = {}) {
      checks.push({ path, options });
    },
  });
  assert.equal(prepared, 1);
  const call = onlyCall(calls);
  assert.equal(call.command, "cargo");
  assert.equal(call.cwd, resolve(ripgrepRoot, ".sources/ripgrep"));
  assert.deepEqual(call.args, [
    "build",
    "--locked",
    "--release",
    "--target",
    "wasm32-wasip1",
    "--bin",
    "rg",
    "--no-default-features",
    "-j2",
  ]);
  assert.equal(call.env.CARGO_ENCODED_RUSTFLAGS, "fixture-flags");
  assert.equal(call.env.CARGO_PROFILE_RELEASE_DEBUG, "0");
  assert.equal(call.env.CARGO_PROFILE_RELEASE_STRIP, "debuginfo");
  assert.equal(call.env.GIT_CEILING_DIRECTORIES, resolve(ripgrepRoot, ".sources"));
  assert.deepEqual(checks, [
    { path: resolve(ripgrepTargetRoot, "wasm32-wasip1/release/rg.wasm"), options: {} },
  ]);
});
