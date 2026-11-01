import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  stageProgram,
  verifyWasiGuest,
  wasiBuildConfiguration,
  wasiBuildEnvironment,
  wasiTarget,
} from "../../../tools/program-build-tools.ts";
import { programReleaseEnvironment } from "../../../tools/program-optimize.ts";

const workspace = resolve(import.meta.dirname, "../../..");
const dfManifest = resolve(workspace, "packages/coreutils/crates/df/Cargo.toml");

export function dfBuildEnvironment() {
  const root = process.env.DF_BUILD_ROOT;
  assert.ok(root, "Set DF_BUILD_ROOT to an owned directory on a verified data drive");
  const recipe = {
    root,
    waffle: resolve(workspace, "packages/waffle"),
    env: { ...process.env, ...programReleaseEnvironment },
  };
  return {
    env: wasiBuildEnvironment(recipe, "target"),
    configuration: wasiBuildConfiguration(recipe),
  };
}

/** A capability probe, not catalog admission. Upstream currently rejects WASI. */
export function buildDf() {
  const { env } = dfBuildEnvironment();
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "--offline",
      "--release",
      "--target",
      wasiTarget,
      "--manifest-path",
      dfManifest,
      "--bin",
      "df",
      "-j2",
    ],
    { cwd: workspace, env, stdio: "inherit", timeout: 900_000, killSignal: "SIGTERM" },
  );
  assert.ok(env.CARGO_TARGET_DIR);
  const source = resolve(env.CARGO_TARGET_DIR, wasiTarget, "release/df.wasm");
  verifyWasiGuest(source);
  const output = resolve(env.CARGO_TARGET_DIR, "../staged");
  mkdirSync(output, { recursive: true });
  stageProgram(source, [resolve(output, "df.wasm")]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) buildDf();
