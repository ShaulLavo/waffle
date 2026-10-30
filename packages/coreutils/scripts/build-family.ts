import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  stageProgram,
  verifyWasiGuest,
  wasiBuildEnvironment,
  wasiTarget,
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
  singleProgramBuilds,
} from "../../../tools/program-locales/prepare.ts";
import { usesProgramCatalogs } from "../../../tools/program-locales/selection.ts";
import { verificationOptions } from "./programs.ts";

type Execute = typeof execFileSync;
type Environment = typeof wasiBuildEnvironment;
type Verify = typeof verifyWasiGuest;

export interface BuildOptions {
  execute?: Execute;
  environment?: Environment;
  rustflags?: readonly string[];
  localeProgram?: string;
  locales?: typeof prepareProgramLocales;
}

export function buildFamilyPackages(args: readonly string[], options: BuildOptions = {}) {
  const execute = options.execute ?? execFileSync;
  const environment = options.environment ?? wasiBuildEnvironment;
  const env = environment(familyRecipe, targetDirectory);
  const flags = env.CARGO_ENCODED_RUSTFLAGS;
  if (!flags) throw new Error("The WASI build must supply encoded Rust flags");
  const encoded = [flags].concat(options.rustflags ?? []);
  const buildArgs = [
    "build",
    "--locked",
    "--release",
    "--target",
    wasiTarget,
    "--manifest-path",
    resolve(packageRoot, "Cargo.toml"),
    "-j2",
  ].concat(args);
  const flagsEnv = { ...env, CARGO_ENCODED_RUSTFLAGS: encoded.join("\x1f") };
  const program = options.localeProgram;
  const buildEnv = program
    ? (options.locales ?? prepareProgramLocales)({
        root: workspaceRoot,
        program,
        env: flagsEnv,
      })
    : flagsEnv;
  const invocation: [string, string[]] = program
    ? programLocaleCargoCommand(
        buildEnv,
        resolve(workspaceRoot, targetDirectory),
        program,
        buildArgs,
      )
    : ["cargo", buildArgs];
  const [command, commandArgs] = invocation;
  execute(command, commandArgs, { cwd: workspaceRoot, env: buildEnv, stdio: "inherit" });
}

export interface ProgramBuildOptions extends BuildOptions {
  verifier?: Verify;
}

export function buildFamilyPrograms(
  args: readonly string[],
  names: readonly string[],
  options: ProgramBuildOptions = {},
) {
  for (const build of singleProgramBuilds(args, names)) {
    buildFamilyPackages(build.args, {
      ...options,
      localeProgram: usesProgramCatalogs(build.program) ? build.program : undefined,
    });
  }
  const verifier = options.verifier ?? verifyWasiGuest;
  for (const name of names) {
    verifier(resolve(releaseDirectory, `${name}.wasm`), verificationOptions(name));
  }
}

export function stageFamilyPrograms(names: readonly string[]) {
  for (const name of names) {
    for (const directory of ["dist", "public/programs"]) {
      mkdirSync(resolve(packageRoot, directory), { recursive: true });
      stageProgram(
        resolve(releaseDirectory, `${name}.wasm`),
        resolve(packageRoot, directory, `${name}.wasm`),
      );
    }
  }
}
