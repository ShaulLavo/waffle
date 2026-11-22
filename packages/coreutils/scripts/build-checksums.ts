import { execFileSync, spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  verifyWasiGuest,
  wasiBuildEnvironment,
  wasiTarget,
} from "../../../tools/program-build-tools.ts";
import { programReleaseEnvironment } from "../../../tools/program-optimize.ts";
import {
  prepareProgramLocales,
  programLocaleCargoCommand,
} from "../../../tools/program-locales/prepare.ts";
import {
  familyRecipe,
  packageRoot,
  releaseDirectory,
  targetDirectory,
  workspaceRoot,
} from "./build-config.ts";
import { stageFamilyPrograms } from "./build-family.ts";
import { prepareChecksumSource } from "./prepare-checksum-source.ts";
import { checksumNames } from "./programs.ts";

const manifest = resolve(packageRoot, "crates/checksums/Cargo.toml");
// The isolated workspace has its own lockfile, so it keeps its own Cargo target.
const cargoTarget = ".build/coreutils-checksums";

function cargoJobs(): string {
  return String(Math.max(1, Math.min(4, availableParallelism())));
}

/** Builds each checksum guest with only its English catalogs into the family release directory. */
export function buildChecksums() {
  const ownedSource = prepareChecksumSource();
  const env = { ...wasiBuildEnvironment(familyRecipe, cargoTarget), ...programReleaseEnvironment };
  const jobs = `-j${cargoJobs()}`;
  for (const name of checksumNames) {
    const buildEnv = prepareProgramLocales({
      root: workspaceRoot,
      program: name,
      env,
      manifest,
      ownedSource,
    });
    const [command, args] = programLocaleCargoCommand(
      buildEnv,
      resolve(workspaceRoot, targetDirectory),
      name,
      [
        "build",
        "--locked",
        "--release",
        "--target",
        wasiTarget,
        "--manifest-path",
        manifest,
        "--bin",
        name,
        jobs,
      ],
    );
    execFileSync(command, args, { cwd: workspaceRoot, env: buildEnv, stdio: "inherit" });
    verifyWasiGuest(resolve(releaseDirectory, `${name}.wasm`));
  }
}

async function stageOne(name: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [import.meta.filename, "--stage-one", name], {
      cwd: workspaceRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Staging ${name} failed (${signal ?? code})`));
    });
  });
}

async function stageChecksumsInParallel(names: readonly string[]): Promise<void> {
  const limit = Math.max(1, Math.min(4, availableParallelism(), names.length));
  let nextIndex = 0;
  let failure: unknown;
  const worker = async () => {
    while (failure === undefined) {
      const name = names[nextIndex++];
      if (!name) return;
      try {
        await stageOne(name);
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  if (failure !== undefined) throw failure;
}

function isChecksumName(value: string | undefined): value is (typeof checksumNames)[number] {
  return value !== undefined && (checksumNames as readonly string[]).includes(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const stageFlag = process.argv.indexOf("--stage-one");
  if (stageFlag >= 0) {
    const name = process.argv[stageFlag + 1];
    if (!isChecksumName(name)) throw new Error(`Unknown checksum program: ${name ?? ""}`);
    stageFamilyPrograms([name]);
  } else {
    buildChecksums();
    await stageChecksumsInParallel(checksumNames);
  }
}
