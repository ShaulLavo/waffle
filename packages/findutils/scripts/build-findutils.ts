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
import { verifyXargsSource } from "./xargs-source.ts";

export const packageRoot = resolve(import.meta.dirname, "..");
export const workspaceRoot = resolve(packageRoot, "../..");
export const targetDirectory = ".build/findutils";
export const releaseDirectory = resolve(workspaceRoot, targetDirectory, wasiTarget, "release");
export const familyRecipe = {
  root: workspaceRoot,
  waffle: resolve(workspaceRoot, "packages/waffle"),
} satisfies WasiBuildRecipe;
export const programNames = ["find", "xargs"] as const;

export type Execute = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
) => unknown;
export type BuildEnvironment = (recipe: WasiBuildRecipe, target: string) => NodeJS.ProcessEnv;

export interface FindutilsBuildOptions {
  readonly programs?: readonly (typeof programNames)[number][];
  readonly execute?: Execute;
  readonly environment?: BuildEnvironment;
  readonly verifier?: typeof verifyWasiGuest;
}

export function buildFindutils(options: FindutilsBuildOptions = {}) {
  verifyXargsSource(packageRoot);
  const programs = options.programs ?? programNames;
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
      "waffle-findutils-source",
    ].concat(programs.flatMap((name) => ["--bin", name])),
    {
      cwd: workspaceRoot,
      env: environment(familyRecipe, targetDirectory),
      stdio: "inherit",
    },
  );
  for (const name of programs) verifier(resolve(releaseDirectory, `${name}.wasm`));
}

export function stageFindutils() {
  for (const name of programNames) {
    for (const directory of ["dist", "public/programs"]) {
      mkdirSync(resolve(packageRoot, directory), { recursive: true });
      copyFileSync(
        resolve(releaseDirectory, `${name}.wasm`),
        resolve(packageRoot, directory, `${name}.wasm`),
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildFindutils();
  stageFindutils();
}
