import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
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
import { verificationOptions } from "./programs.ts";

type Execute = typeof execFileSync;
type Environment = typeof wasiBuildEnvironment;
type Verify = typeof verifyWasiGuest;

export interface BuildOptions {
  execute?: Execute;
  environment?: Environment;
  rustflags?: readonly string[];
}

export function buildFamilyPackages(args: readonly string[], options: BuildOptions = {}) {
  const execute = options.execute ?? execFileSync;
  const environment = options.environment ?? wasiBuildEnvironment;
  const env = environment(familyRecipe, targetDirectory);
  const flags = env.CARGO_ENCODED_RUSTFLAGS;
  if (!flags) throw new Error("The WASI build must supply encoded Rust flags");
  const encoded = [flags].concat(options.rustflags ?? []);
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
    ].concat(args),
    {
      cwd: workspaceRoot,
      env: { ...env, CARGO_ENCODED_RUSTFLAGS: encoded.join("\x1f") },
      stdio: "inherit",
    },
  );
}

export interface ProgramBuildOptions extends BuildOptions {
  verifier?: Verify;
}

export function buildFamilyPrograms(
  args: readonly string[],
  names: readonly string[],
  options: ProgramBuildOptions = {},
) {
  buildFamilyPackages(args, options);
  const verifier = options.verifier ?? verifyWasiGuest;
  for (const name of names) {
    verifier(resolve(releaseDirectory, `${name}.wasm`), verificationOptions(name));
  }
}

export function stageFamilyPrograms(names: readonly string[]) {
  for (const name of names) {
    for (const directory of ["dist", "public/programs"]) {
      mkdirSync(resolve(packageRoot, directory), { recursive: true });
      copyFileSync(
        resolve(releaseDirectory, `${name}.wasm`),
        resolve(packageRoot, directory, `${name}.wasm`),
      );
    }
  }
}
