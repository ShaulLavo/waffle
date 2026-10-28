import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  verifyWasiGuest,
  wasiBuildEnvironment,
  wasiTarget,
  type WasiBuildRecipe,
} from "../../../tools/program-build-tools.ts";
import { familyRecipe, packageRoot, releaseDirectory, targetDirectory } from "./build-config.ts";
import { ripgrepNotices } from "./rg-notices.ts";
import { patchRipgrepSource } from "./rg-source.ts";

const revision = "6892bc2b7efe5909cbbeec8f757ed2c4c76b1d30";
const archiveSha256 = "bc5a3bc1c3d58a192a3c4731c6f2aa159e74b007ce6200d7f6ef05d8fb4e000e";
const source = resolve(packageRoot, ".sources/ripgrep");
const patch = resolve(packageRoot, "patches/ripgrep-wasi.patch");
const receipt = resolve(source, ".bash-web-recipe");
const guest = resolve(releaseDirectory, "rg.wasm");

export type Execute = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
) => unknown;
export type BuildEnvironment = (recipe: WasiBuildRecipe, target: string) => NodeJS.ProcessEnv;

export interface RipgrepBuildOptions {
  readonly execute?: Execute;
  readonly environment?: BuildEnvironment;
  readonly verifier?: typeof verifyWasiGuest;
  readonly prepare?: () => Promise<void>;
}

async function recipeIdentity() {
  return createHash("sha256")
    .update(revision)
    .update(await readFile(patch))
    .update(await readFile(new URL("./rg-source.ts", import.meta.url)))
    .digest("hex");
}

export async function prepareRipgrepSource() {
  const identity = await recipeIdentity();
  if ((await readFile(receipt, "utf8").catch(() => "")) === identity) return;
  const response = await fetch(`https://codeload.github.com/BurntSushi/ripgrep/tar.gz/${revision}`);
  if (!response.ok) throw new Error(`ripgrep source download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), archiveSha256);
  const archive = resolve(packageRoot, ".build/ripgrep.tar.gz");
  await mkdir(resolve(packageRoot, ".build"), { recursive: true });
  await writeFile(archive, bytes);
  try {
    await rm(source, { recursive: true, force: true });
    await mkdir(source, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", source]);
    patchRipgrepSource(source, patch);
    await writeFile(receipt, identity);
  } finally {
    await rm(archive, { force: true });
  }
}

export async function buildRipgrep(options: RipgrepBuildOptions = {}) {
  const prepare = options.prepare ?? prepareRipgrepSource;
  const execute = options.execute ?? execFileSync;
  const environment = options.environment ?? wasiBuildEnvironment;
  const verifier = options.verifier ?? verifyWasiGuest;
  await prepare();
  execute(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--target",
      wasiTarget,
      "--bin",
      "rg",
      "--no-default-features",
      "-j2",
    ],
    {
      cwd: source,
      env: {
        ...environment(familyRecipe, targetDirectory),
        CARGO_PROFILE_RELEASE_DEBUG: "0",
        CARGO_PROFILE_RELEASE_STRIP: "debuginfo",
        GIT_CEILING_DIRECTORIES: resolve(packageRoot, ".sources"),
      },
      stdio: "inherit",
    },
  );
  verifier(guest);
}

export async function stageRipgrep() {
  for (const directory of ["dist", "public/programs"]) {
    await mkdir(resolve(packageRoot, directory), { recursive: true });
    await copyFile(guest, resolve(packageRoot, directory, "rg.wasm"));
  }
  const notices = await ripgrepNotices(source, process.env);
  for (const directory of ["dist", "public/programs"])
    await writeFile(resolve(packageRoot, directory, "rg.NOTICES.txt"), notices);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildRipgrep();
  await stageRipgrep();
}
