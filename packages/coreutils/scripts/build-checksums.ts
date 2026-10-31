import { execFileSync } from "node:child_process";
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

/** Builds each checksum guest with only its English catalogs into the family release directory. */
export function buildChecksums() {
  const ownedSource = prepareChecksumSource();
  const env = { ...wasiBuildEnvironment(familyRecipe, cargoTarget), ...programReleaseEnvironment };
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
        "-j2",
      ],
    );
    execFileSync(command, args, { cwd: workspaceRoot, env: buildEnv, stdio: "inherit" });
    verifyWasiGuest(resolve(releaseDirectory, `${name}.wasm`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildChecksums();
  stageFamilyPrograms(checksumNames);
}
