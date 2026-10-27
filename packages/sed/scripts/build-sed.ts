import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  verifyWasiGuest,
  wasiBuildEnvironment,
  wasiTarget,
  type WasiBuildRecipe,
} from "../../../tools/program-build-tools.ts";
import {
  familyRecipe,
  packageRoot,
  releaseDirectory,
  targetDirectory,
  workspaceRoot,
} from "./build-config.ts";
import { verifySedSource } from "./sed-source.ts";

export type Execute = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
) => unknown;
export type BuildEnvironment = (recipe: WasiBuildRecipe, target: string) => NodeJS.ProcessEnv;

export interface SedBuildOptions {
  readonly execute?: Execute;
  readonly environment?: BuildEnvironment;
  readonly verifier?: typeof verifyWasiGuest;
}

export function buildSed(options: SedBuildOptions = {}) {
  verifySedSource(packageRoot);
  const execute = options.execute ?? execFileSync;
  const environment = options.environment ?? wasiBuildEnvironment;
  const verifier = options.verifier ?? verifyWasiGuest;
  execute(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--target",
      wasiTarget,
      "--manifest-path",
      resolve(packageRoot, "Cargo.toml"),
      "-j2",
      "-p",
      "shell-sed",
      "--bin",
      "sed",
    ],
    {
      cwd: workspaceRoot,
      env: environment(familyRecipe, targetDirectory),
      stdio: "inherit",
    },
  );
  verifier(resolve(releaseDirectory, "sed.wasm"));
}

export function stageSed() {
  const guest = resolve(releaseDirectory, "sed.wasm");
  for (const directory of ["dist", "public/programs"]) {
    mkdirSync(resolve(packageRoot, directory), { recursive: true });
    copyFileSync(guest, resolve(packageRoot, directory, "sed.wasm"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildSed();
  stageSed();
}
