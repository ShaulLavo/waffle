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

export const packageRoot = resolve(import.meta.dirname, "..");
export const workspaceRoot = resolve(packageRoot, "../..");
export const targetDirectory = ".build/grep";
export const releaseDirectory = resolve(workspaceRoot, targetDirectory, wasiTarget, "release");
export const familyRecipe = {
  root: workspaceRoot,
  waffle: resolve(workspaceRoot, "packages/waffle"),
} satisfies WasiBuildRecipe;
export const filesystemAdapter = "waffle_program_support::runtime::wasi";

export type Execute = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
) => unknown;
export type BuildEnvironment = (recipe: WasiBuildRecipe, target: string) => NodeJS.ProcessEnv;

export interface GrepBuildOptions {
  readonly execute?: Execute;
  readonly environment?: BuildEnvironment;
  readonly verifier?: typeof verifyWasiGuest;
}

export function buildGrep(options: GrepBuildOptions = {}) {
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
      "waffle-grep",
      "--bin",
      "grep",
      "--features",
      "cooperative-wasi",
    ],
    {
      cwd: workspaceRoot,
      env: environment(familyRecipe, targetDirectory),
      stdio: "inherit",
    },
  );
  verifier(resolve(releaseDirectory, "grep.wasm"), { filesystemAdapter });
}

export function stageGrep() {
  const guest = resolve(releaseDirectory, "grep.wasm");
  const destinations = ["dist", "public/programs"].map((directory) =>
    resolve(packageRoot, directory, "grep.wasm"),
  );
  for (const path of destinations) mkdirSync(resolve(path, ".."), { recursive: true });
  stageProgram(guest, destinations, { filesystemAdapter });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildGrep();
  stageGrep();
}
