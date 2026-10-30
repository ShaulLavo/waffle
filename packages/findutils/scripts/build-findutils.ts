import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  stageProgram,
  verifyWasiGuest,
  wasiBuildEnvironment,
  wasiTarget,
  type WasiBuildRecipe,
} from "../../../tools/program-build-tools.ts";
import {
  prepareProgramLocales,
  programLocaleCargoCommand,
} from "../../../tools/program-locales/prepare.ts";
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
  readonly locales?: typeof prepareProgramLocales;
}

export function buildFindutils(options: FindutilsBuildOptions = {}) {
  verifyXargsSource(packageRoot);
  const programs = options.programs ?? programNames;
  const execute = options.execute ?? execFileSync;
  const environment = options.environment ?? wasiBuildEnvironment;
  const verifier = options.verifier ?? verifyWasiGuest;
  for (const name of programs) {
    const env = (options.locales ?? prepareProgramLocales)({
      root: workspaceRoot,
      program: name,
      env: environment(familyRecipe, targetDirectory),
    });
    const buildArgs = [
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
      "--bin",
      name,
    ];
    const [command, args] = programLocaleCargoCommand(
      env,
      resolve(workspaceRoot, targetDirectory),
      name,
      buildArgs,
    );
    execute(command, args, { cwd: workspaceRoot, env, stdio: "inherit" });
  }
  for (const name of programs) verifier(resolve(releaseDirectory, `${name}.wasm`));
}

export function stageFindutils() {
  for (const name of programNames) {
    for (const directory of ["dist", "public/programs"]) {
      mkdirSync(resolve(packageRoot, directory), { recursive: true });
      stageProgram(
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
