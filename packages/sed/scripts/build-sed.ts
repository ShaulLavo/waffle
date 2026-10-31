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
  familyRecipe,
  packageRoot,
  releaseDirectory,
  targetDirectory,
  workspaceRoot,
} from "./build-config.ts";
import {
  prepareProgramLocales,
  programLocaleCargoCommand,
} from "../../../tools/program-locales/prepare.ts";
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
  readonly locales?: typeof prepareProgramLocales;
}

export function buildSed(options: SedBuildOptions = {}) {
  verifySedSource(packageRoot);
  const execute = options.execute ?? execFileSync;
  const environment = options.environment ?? wasiBuildEnvironment;
  const verifier = options.verifier ?? verifyWasiGuest;
  const env = (options.locales ?? prepareProgramLocales)({
    root: workspaceRoot,
    program: "sed",
    manifest: resolve(packageRoot, "Cargo.toml"),
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
    "shell-sed",
    "--bin",
    "sed",
  ];
  const [command, args] = programLocaleCargoCommand(
    env,
    resolve(workspaceRoot, targetDirectory),
    "sed",
    buildArgs,
  );
  execute(command, args, { cwd: workspaceRoot, env, stdio: "inherit" });
  verifier(resolve(releaseDirectory, "sed.wasm"));
}

export function stageSed() {
  const guest = resolve(releaseDirectory, "sed.wasm");
  const destinations = ["dist", "public/programs"].map((directory) =>
    resolve(packageRoot, directory, "sed.wasm"),
  );
  for (const path of destinations) mkdirSync(resolve(path, ".."), { recursive: true });
  stageProgram(guest, destinations);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildSed();
  stageSed();
}
