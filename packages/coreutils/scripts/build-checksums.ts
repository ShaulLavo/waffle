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

function signalChildGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    // Child already exited.
  }
}

async function stageOne(
  name: string,
  active: Set<ReturnType<typeof spawn>>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [import.meta.filename, "--stage-one", name], {
      cwd: workspaceRoot,
      env: process.env,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    active.add(child);
    const cleanup = () => active.delete(child);
    child.once("error", (error) => {
      cleanup();
      rejectPromise(error);
    });
    child.once("exit", (code, exitSignal) => {
      cleanup();
      if (code === 0 && !signal.aborted) resolvePromise();
      else rejectPromise(new Error(`Staging ${name} failed (${exitSignal ?? code})`));
    });
  });
}

async function stageChecksumsInParallel(names: readonly string[]): Promise<void> {
  const limit = Math.max(1, Math.min(4, availableParallelism(), names.length));
  const active = new Set<ReturnType<typeof spawn>>();
  const controller = new AbortController();
  let nextIndex = 0;
  let failure: unknown;
  const terminate = (signal: NodeJS.Signals) => {
    if (!controller.signal.aborted) controller.abort(new Error(`Interrupted by ${signal}`));
    for (const child of active) signalChildGroup(child, signal);
  };
  const onSigint = () => terminate("SIGINT");
  const onSigterm = () => terminate("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  const runNext = async (name: string) => {
    try {
      await stageOne(name, active, controller.signal);
    } catch (error) {
      failure ??= error;
      if (!controller.signal.aborted) controller.abort(error);
      for (const child of active) signalChildGroup(child, "SIGTERM");
    }
  };
  const worker = async () => {
    while (failure === undefined && !controller.signal.aborted) {
      const name = names[nextIndex++];
      if (!name) return;
      await runNext(name);
    }
  };
  try {
    await Promise.all(Array.from({ length: limit }, () => worker()));
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
  if (failure !== undefined) throw failure;
  controller.signal.throwIfAborted();
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
