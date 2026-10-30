import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import {
  stageProgram,
  verifyWasiGuest,
  wasiBuildConfiguration,
  wasiBuildEnvironment,
  wasiTarget,
} from "../../../tools/program-build-tools.ts";
import {
  buildDirectory,
  familyRecipe,
  packageRoot,
  releaseDirectory,
  source,
  sourceLock,
  workspaceRoot,
} from "./build-config.ts";
import { generateDiffutilsNotices } from "./notices.ts";

export { packageRoot, source, workspaceRoot } from "./build-config.ts";
const patch = resolve(packageRoot, "patches/gnu-wasi.patch");
const receipt = resolve(source, ".waffle-source");
const sourceIdentity = createHash("sha256")
  .update(sourceLock.upstream.archiveSha256)
  .update(readFileSync(patch))
  .digest("hex");

export type Execute = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
) => unknown;

export interface DiffutilsBuildOptions {
  readonly execute?: Execute;
  readonly environment?: typeof wasiBuildEnvironment;
  readonly configuration?: typeof wasiBuildConfiguration;
  readonly verifier?: typeof verifyWasiGuest;
  readonly prepare?: () => Promise<void>;
}

async function downloadSource(): Promise<Uint8Array> {
  const response = await fetch(sourceLock.upstream.archive);
  assert.ok(response.ok, `GNU diffutils source download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  assert.equal(actual, sourceLock.upstream.archiveSha256, "GNU diffutils archive checksum");
  return bytes;
}

export async function prepareDiffutilsSource() {
  if (existsSync(receipt)) {
    assert.equal(readFileSync(receipt, "utf8"), sourceIdentity);
    return;
  }
  assert.ok(!existsSync(source), `Unverified GNU diffutils source directory: ${source}`);
  const bytes = await downloadSource();
  const build = resolve(packageRoot, ".build");
  mkdirSync(build, { recursive: true });
  const archive = resolve(build, "diffutils.tar.xz");
  const scratch = mkdtempSync(resolve(build, "source-"));
  writeFileSync(archive, bytes);
  try {
    execFileSync("tar", ["-xJf", archive, "--strip-components=1", "-C", scratch]);
    execFileSync("patch", ["--batch", "--forward", "-p1", "-d", scratch], {
      input: readFileSync(patch),
    });
    mkdirSync(dirname(source), { recursive: true });
    renameSync(scratch, source);
    writeFileSync(receipt, sourceIdentity);
  } finally {
    rmSync(archive, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function buildDiffutils(options: DiffutilsBuildOptions = {}) {
  const prepare = options.prepare ?? prepareDiffutilsSource;
  const execute = options.execute ?? execFileSync;
  const environment = options.environment ?? wasiBuildEnvironment;
  const configuration = options.configuration ?? wasiBuildConfiguration;
  const verifier = options.verifier ?? verifyWasiGuest;
  await prepare();
  const config = configuration(familyRecipe);
  const inherited = environment(familyRecipe, ".build/diffutils");
  const targetFlags = `--target=${wasiTarget} --sysroot=${config.sysroot}`;
  const env = {
    ...inherited,
    CC: config.linker,
    CFLAGS: `${targetFlags} -Oz -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS`,
    LDFLAGS: `${targetFlags} -Wl,--max-memory=268435456 -lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-process-clocks`,
  };
  mkdirSync(buildDirectory, { recursive: true });
  execute(
    resolve(source, "configure"),
    [
      "--host=wasm32-wasip1",
      "--disable-nls",
      "--disable-rpath",
      "--without-libiconv-prefix",
      "--without-libintl-prefix",
      "gl_cv_func_strcasecmp_works=yes",
    ],
    { cwd: buildDirectory, env, stdio: "inherit" },
  );
  execute("make", ["-C", resolve(buildDirectory, "lib"), "-j2"], {
    cwd: workspaceRoot,
    env,
    stdio: "inherit",
  });
  execute("make", ["-C", releaseDirectory, "-j2", "paths.h", "version.h", "diff", "cmp"], {
    cwd: workspaceRoot,
    env,
    stdio: "inherit",
  });
  verifier(resolve(releaseDirectory, "diff"));
  verifier(resolve(releaseDirectory, "cmp"));
}

interface ProgramSize {
  readonly rawBytes: number;
  readonly strippedBytes: number;
  readonly brotliBytes: number;
  readonly strippedSha256: string;
}

function stageGuest(program: "diff" | "cmp"): ProgramSize {
  const guest = resolve(releaseDirectory, program);
  const raw = readFileSync(guest);
  const destination = resolve(packageRoot, `dist/${program}.wasm`);
  stageProgram(guest, destination);
  const stripped = readFileSync(destination);
  const compressed = brotliCompressSync(stripped, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  });
  writeFileSync(`${destination}.br`, compressed);
  return {
    rawBytes: raw.length,
    strippedBytes: stripped.length,
    brotliBytes: compressed.length,
    strippedSha256: createHash("sha256").update(stripped).digest("hex"),
  };
}

export function stageDiffutils() {
  mkdirSync(resolve(packageRoot, "dist"), { recursive: true });
  const sizes = {
    schemaVersion: 1,
    upstreamVersion: sourceLock.upstream.version,
    archiveSha256: sourceLock.upstream.archiveSha256,
    programs: { diff: stageGuest("diff"), cmp: stageGuest("cmp") },
  };
  writeFileSync(
    resolve(packageRoot, "dist/diffutils.sizes.json"),
    `${JSON.stringify(sizes, null, 2)}\n`,
  );
  generateDiffutilsNotices();
  return sizes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildDiffutils();
  console.log(JSON.stringify(stageDiffutils()));
}
