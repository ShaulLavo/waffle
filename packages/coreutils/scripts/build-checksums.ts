import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  stageProgram,
  wasiBuildConfiguration,
  wasiCargoEnvironment,
  wasiTarget,
} from "../../../tools/program-build-tools.ts";
import { programReleaseEnvironment } from "../../../tools/program-optimize.ts";

export const checksumNames = [
  "b2sum",
  "cksum",
  "md5sum",
  "sha1sum",
  "sha224sum",
  "sha256sum",
  "sha384sum",
  "sha512sum",
  "sum",
] as const;

export type ChecksumName = (typeof checksumNames)[number];

const packageRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(packageRoot, "../..");
const manifest = resolve(packageRoot, "crates/checksums/Cargo.toml");
const targetDirectory = ".build/coreutils-checksums";
const releaseDirectory = resolve(workspaceRoot, targetDirectory, wasiTarget, "release");
const outputDirectory = resolve(workspaceRoot, targetDirectory, "dist");

export function buildChecksums() {
  const recipe = {
    root: workspaceRoot,
    waffle: resolve(workspaceRoot, "packages/waffle"),
  };
  const config = wasiBuildConfiguration(recipe);
  assert.equal(
    readFileSync(resolve(config.directory, "recipe.sha256"), "utf8"),
    config.identity,
    "Checksums require the existing verified patched-libc artifact, not a new common producer",
  );
  const environment = {
    ...wasiCargoEnvironment(recipe, targetDirectory),
    ...programReleaseEnvironment,
  };
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--target",
      wasiTarget,
      "--manifest-path",
      manifest,
      "--bins",
      "-j2",
    ],
    { cwd: workspaceRoot, env: environment, stdio: "inherit", timeout: 600_000 },
  );
  mkdirSync(outputDirectory, { recursive: true });
  for (const name of checksumNames) {
    const source = resolve(releaseDirectory, `${name}.wasm`);
    const destination = resolve(outputDirectory, `${name}.wasm`);
    stageProgram(source, destination);
  }
  return { outputDirectory, names: checksumNames };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) buildChecksums();
