import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { selectCatalogs, usesProgramCatalogs } from "../../../tools/program-locales/selection.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { WasiBuildRecipe, WasiGuestVerification } from "../../../tools/program-build-tools.ts";
import { writeCoreutilsArtifacts, stageCoreutilsArtifacts } from "./artifacts.ts";
import { familyRecipe, packageRoot, workspaceRoot } from "./build-config.ts";
import { buildFamilyPrograms } from "./build-family.ts";
import { buildWc } from "./build-wc.ts";
import type { prepareProgramLocales } from "../../../tools/program-locales/prepare.ts";
import { coreutilsNames, coreutilsPackageNames } from "./programs.ts";

function environment(recipe: WasiBuildRecipe, target: string) {
  assert.deepEqual(recipe, familyRecipe);
  assert.equal(recipe.root, workspaceRoot);
  assert.equal(recipe.waffle, resolve(workspaceRoot, "packages/waffle"));
  assert.equal(target, ".build/coreutils");
  return { CARGO_ENCODED_RUSTFLAGS: "fixture-flags" };
}

function locales(options: Parameters<typeof prepareProgramLocales>[0]) {
  return {
    ...options.env,
    CARGO_TARGET_DIR: resolve(workspaceRoot, ".build/coreutils"),
    WAFFLE_PROGRAM_LOCALE_INPUTS: options.program,
  };
}

function capture() {
  const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const execute = (
    command: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv },
  ) => {
    calls.push({ command, args, env: options.env });
    return Buffer.alloc(0);
  };
  return { calls, execute: execute as typeof execFileSync };
}

function verifier(calls: { path: string; options: WasiGuestVerification }[]) {
  return (path: string, options: WasiGuestVerification = {}) => {
    calls.push({ path, options });
  };
}

test("coreutils Cargo route uses the singular recipe and verifies every bin", () => {
  const { calls, execute } = capture();
  const checks: { path: string; options: WasiGuestVerification }[] = [];
  buildFamilyPrograms(
    ["-p", "waffle-coreutils", "--bins", "--features", "cooperative-wasi"],
    coreutilsPackageNames,
    { execute, environment, locales, verifier: verifier(checks) },
  );
  assert.equal(calls.length, coreutilsPackageNames.length);
  assert.equal(calls[0].command, "flock");
  assert.equal(calls[0].env.WAFFLE_PROGRAM_LOCALE_INPUTS, coreutilsPackageNames[0]);
  assert.deepEqual(calls[0].args.slice(5, 13), [
    "build",
    "--locked",
    "--release",
    "--target",
    "wasm32-wasip1",
    "--manifest-path",
    resolve(packageRoot, "Cargo.toml"),
    "-j2",
  ]);
  assert.equal(calls[0].env.CARGO_ENCODED_RUSTFLAGS, "fixture-flags");
  assert.equal(checks.length, 15);
  assert.deepEqual(
    calls.map((call) => call.env.WAFFLE_PROGRAM_LOCALE_INPUTS),
    coreutilsPackageNames.map((name) => (usesProgramCatalogs(name) ? name : undefined)),
  );
  assert.ok(calls.every((call) => !call.args.includes("--bins")));
  for (const check of checks) {
    const cooperative = /\/(?:cat|mkdir|seq|tail)\.wasm$/.test(check.path);
    assert.equal(
      check.options.filesystemAdapter,
      cooperative ? "waffle_program_support::runtime::wasi" : undefined,
    );
  }
});

test("wc retains the scalar target feature and one final guest verification", () => {
  const { calls, execute } = capture();
  const checks: { path: string; options: WasiGuestVerification }[] = [];
  buildWc({ execute, environment, locales, verifier: verifier(checks) });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].env.CARGO_ENCODED_RUSTFLAGS,
    "fixture-flags\x1f-C\x1ftarget-feature=-simd128",
  );
  assert.deepEqual(calls[0].args.slice(-4), ["-p", "waffle-wc", "--bin", "wc"]);
  assert.equal(checks.length, 1);
  assert.match(checks[0].path, /\/wc\.wasm$/);
});

test("artifact receipts preserve names, source identity, verification and staging", () => {
  const parent = resolve(packageRoot, ".build");
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(resolve(parent, "build-route-test-"));
  try {
    const release = resolve(scratch, "release");
    const output = resolve(scratch, "artifacts");
    const staged = resolve(scratch, "staged");
    mkdirSync(release, { recursive: true });
    for (const name of coreutilsNames) {
      writeFileSync(resolve(release, `${name}.wasm`), name);
      if (!usesProgramCatalogs(name)) continue;
      const sha256 = createHash("sha256").update(name).digest("hex");
      const version = ["head", "sort", "uniq"].includes(name) ? "0.12.0" : "0.13.0";
      writeFileSync(
        resolve(release, `${name}.wasm.locales.json`),
        JSON.stringify({
          program: name,
          originalGuest: { sha256 },
          generated: [{ version, keys: selectCatalogs(name, version), sha256 }],
        }),
      );
    }
    const checks: { path: string; options: WasiGuestVerification }[] = [];
    writeCoreutilsArtifacts(workspaceRoot, release, output, verifier(checks));
    assert.equal(checks.length, 20);
    const lines = readFileSync(resolve(output, "source-sha256.txt"), "utf8").split("\n");
    assert.equal(lines.length, 22);
    assert.match(lines[0], /^source [a-f0-9]{40}$/);
    assert.deepEqual(
      lines.slice(1, -1).map((line) => line.split("  ")[1]),
      coreutilsNames.map((name) => `${name}.wasm`),
    );
    stageCoreutilsArtifacts(workspaceRoot, output, staged, verifier(checks));
    for (const name of coreutilsNames) {
      assert.equal(readFileSync(resolve(staged, `${name}.wasm`), "utf8"), name);
    }
    writeFileSync(resolve(output, "cat.wasm"), "changed");
    assert.throws(() => stageCoreutilsArtifacts(workspaceRoot, output, staged, verifier(checks)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("echo has a separate ordinary WASI route with no old coreutils feature union", async () => {
  const { buildEcho } = await import("./build-echo.ts");
  const { calls, execute } = capture();
  const checks: { path: string; options: WasiGuestVerification }[] = [];
  buildEcho({ execute, environment, locales, verifier: verifier(checks) });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(-4), ["-p", "waffle-echo", "--bin", "echo"]);
  assert.equal(calls[0].args.includes("cooperative-wasi"), false);
  assert.equal(checks.length, 1);
  assert.match(checks[0].path, /\/echo\.wasm$/);
});
