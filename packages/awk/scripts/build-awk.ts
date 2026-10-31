import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  stageProgram,
  verifyWasiGuest,
  wasiBuildConfiguration,
  wasiSysrootCommand,
} from "../../../tools/program-build-tools.ts";
import { familyRecipe, packageRoot, releaseDirectory } from "./build-config.ts";
import { generateNotices } from "./notices.ts";
import { sourceLock } from "./source-lock.ts";

const files = [
  "awkgram.tab.c",
  "b.c",
  "main.c",
  "parse.c",
  "proctab.c",
  "tran.c",
  "lib.c",
  "run.c",
  "lex.c",
];
const patch = resolve(packageRoot, "patches/wasi-unsupported-ops.patch");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function run(command: string, args: readonly string[], cwd: string, input?: Uint8Array) {
  return execFileSync("timeout", ["--kill-after=2s", "600s", command].concat(args), {
    cwd,
    input,
    env: { ...process.env, TMPDIR: process.env.AWK_SCRATCH_ROOT ?? "/work/tmp" },
    stdio: ["pipe", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function prepareSource(work: string): Promise<string> {
  const response = await fetch(sourceLock.upstream.archive, {
    signal: AbortSignal.timeout(60_000),
  });
  assert.ok(response.ok, `onetrue-awk source download failed: ${response.status}`);
  const archive = new Uint8Array(await response.arrayBuffer());
  assert.equal(sha256(archive), sourceLock.upstream.archiveSha256, "onetrue-awk archive checksum");
  const source = resolve(work, "source");
  mkdirSync(source);
  const path = resolve(work, "source.tar.gz");
  writeFileSync(path, archive);
  run("tar", ["-xzf", path, "--strip-components=1", "-C", source], work);
  run("patch", ["--batch", "--forward", "-p1"], source, readFileSync(patch));
  assert.equal(sha256(readFileSync(resolve(source, "LICENSE"))), sourceLock.upstream.licenseSha256);
  assert.equal(
    sha256(readFileSync(resolve(packageRoot, "LICENSE"))),
    sourceLock.upstream.licenseSha256,
  );
  run("bison", ["-d", "awkgram.y"], source);
  run("cc", ["-O2", "-o", "maketab", "maketab.c"], source);
  writeFileSync(
    resolve(source, "proctab.c"),
    run(resolve(source, "maketab"), ["awkgram.tab.h"], source),
  );
  return source;
}

function buildNative(source: string): void {
  const output = resolve(packageRoot, ".build/native/awk");
  mkdirSync(dirname(output), { recursive: true });
  run("cc", ["-O2", "-o", output].concat(files, ["-lm"]), source);
  writeFileSync(
    `${output}.json`,
    JSON.stringify(
      {
        revision: sourceLock.upstream.revision,
        archiveSha256: sourceLock.upstream.archiveSha256,
        patchSha256: sha256(readFileSync(patch)),
        executableSha256: sha256(readFileSync(output)),
        compiler: run("cc", ["--version"], source).toString().split("\n")[0],
      },
      null,
      2,
    ) + "\n",
  );
}

function buildWasi(source: string): string {
  const config = wasiBuildConfiguration(familyRecipe);
  const [command, args] = wasiSysrootCommand(familyRecipe);
  run(command, args, familyRecipe.root);
  const guest = resolve(releaseDirectory, "awk.wasm");
  mkdirSync(dirname(guest), { recursive: true });
  run(
    config.linker,
    [
      "--target=wasm32-wasip1",
      `--sysroot=${config.sysroot}`,
      "-Oz",
      "-mllvm",
      "-wasm-enable-sjlj",
      "-mllvm",
      "-wasm-use-legacy-eh=false",
      `-ffile-prefix-map=${source}=onetrue-awk`,
      "-Wl,--max-memory=268435456",
      "-o",
      guest,
    ].concat(files, ["-lsetjmp", "-lm"]),
    source,
  );
  verifyWasiGuest(guest, { sdk: config.sdk });
  return guest;
}

function stage(guest: string): void {
  const directory = resolve(packageRoot, "dist");
  mkdirSync(directory, { recursive: true });
  const output = resolve(directory, "awk.wasm");
  const config = wasiBuildConfiguration(familyRecipe);
  const derivation = stageProgram(guest, output, { sdk: config.sdk });
  const raw = readFileSync(guest);
  const stripped = readFileSync(output);
  const compressed = readFileSync(`${output}.br`);
  const gzip = readFileSync(`${output}.gz`);
  const receipt = {
    schemaVersion: 1,
    revision: sourceLock.upstream.revision,
    archiveSha256: sourceLock.upstream.archiveSha256,
    patchSha256: sha256(readFileSync(patch)),
    libcRecipeIdentity: config.identity,
    libcSha256: sha256(readFileSync(resolve(config.sysroot, "lib/wasm32-wasip1/libc.a"))),
    libsetjmpSha256: sha256(readFileSync(resolve(config.sysroot, "lib/wasm32-wasip1/libsetjmp.a"))),
    raw: { bytes: raw.length, sha256: sha256(raw) },
    stripped: { bytes: stripped.length, sha256: sha256(stripped) },
    brotli: { bytes: compressed.length, sha256: sha256(compressed) },
    gzip: { bytes: gzip.length, sha256: sha256(gzip) },
    operation: derivation.operation,
    transformer: derivation.transformer,
    compiler: run(config.linker, ["--version"], packageRoot).toString().split("\n")[0],
  };
  writeFileSync(resolve(directory, "awk.sizes.json"), JSON.stringify(receipt, null, 2) + "\n");
  generateNotices();
  console.log(JSON.stringify(receipt, null, 2));
}

export async function buildAwk(nativeOnly = false): Promise<void> {
  const scratch = process.env.AWK_SCRATCH_ROOT ?? "/work/tmp";
  const work = mkdtempSync(resolve(scratch, "waffle-awk-build-"));
  try {
    const source = await prepareSource(work);
    buildNative(source);
    if (!nativeOnly) stage(buildWasi(source));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(
    process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--native"),
  );
  await buildAwk(process.argv[2] === "--native");
}
