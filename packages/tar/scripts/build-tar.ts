import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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
import { brotliCompressSync, constants } from "node:zlib";
import {
  stageProgram,
  verifyWasiGuest,
  wasiBuildEnvironment,
  wasiTarget,
  type WasiBuildRecipe,
} from "../../../tools/program-build-tools.ts";
import { rustDependencyNotices } from "../../../tools/program-notices.ts";
import lock from "../sources.lock.json" with { type: "json" };

export const packageRoot = resolve(import.meta.dirname, "..");
export const workspaceRoot = resolve(packageRoot, "../..");
export const sourceRoot = resolve(packageRoot, ".sources/tar");
export const targetRoot = resolve(
  process.env.TAR_TARGET_DIR ?? resolve(packageRoot, ".build/target"),
);
export const familyRecipe = {
  root: workspaceRoot,
  waffle: resolve(workspaceRoot, "packages/waffle"),
} satisfies WasiBuildRecipe;
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const patchPath = resolve(packageRoot, lock.patch.path);

export function sourceIdentity() {
  assert.equal(sha256(readFileSync(patchPath)), lock.patch.sha256, "tar patch hash");
  return sha256(lock.upstream.archiveSha256 + lock.patch.sha256);
}

function verifySource() {
  for (const [path, expected] of Object.entries(lock.sourceFiles)) {
    assert.equal(
      sha256(readFileSync(resolve(sourceRoot, path))),
      expected,
      `tar source input: ${path}`,
    );
  }
}

export async function prepareSource() {
  const identity = sourceIdentity();
  const receipt = resolve(sourceRoot, ".waffle-source");
  if (existsSync(receipt)) {
    assert.equal(readFileSync(receipt, "utf8"), identity, "tar source receipt");
    verifySource();
    return;
  }
  assert.ok(!existsSync(sourceRoot), `Unverified tar source directory: ${sourceRoot}`);
  const response = await fetch(lock.upstream.archive, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `tar source download: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.length, lock.upstream.archiveBytes, "tar source archive length");
  assert.equal(sha256(bytes), lock.upstream.archiveSha256, "tar source archive checksum");
  const parent = dirname(sourceRoot);
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(resolve(parent, "tar-source-"));
  const archive = resolve(scratch, "upstream.tgz");
  const extracted = resolve(scratch, "source");
  try {
    writeFileSync(archive, bytes);
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", extracted], {
      timeout: 30_000,
    });
    execFileSync("patch", ["--batch", "--forward", "-p1", "-d", extracted], {
      input: readFileSync(patchPath),
      timeout: 30_000,
    });
    assert.deepEqual(
      readFileSync(resolve(extracted, "LICENSE")),
      readFileSync(resolve(packageRoot, "licenses/LICENSE.uutils-tar")),
    );
    writeFileSync(resolve(extracted, ".waffle-source"), identity);
    renameSync(extracted, sourceRoot);
    verifySource();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface BuildCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: number;
}
export function buildCommand(kind: "native" | "wasi", env: NodeJS.ProcessEnv): BuildCommand {
  const args = [
    "build",
    "--release",
    "--locked",
    "--offline",
    "-j2",
    "--manifest-path",
    resolve(packageRoot, "producer/Cargo.toml"),
    "--bin",
    "tar",
  ];
  if (kind === "wasi") args.push("--target", wasiTarget);
  return {
    command: "cargo",
    args,
    cwd: packageRoot,
    env: { ...env, CARGO_TARGET_DIR: targetRoot },
    timeout: 300_000,
  };
}
export async function buildTar(kind: "native" | "wasi") {
  await prepareSource();
  const env = kind === "wasi" ? wasiBuildEnvironment(familyRecipe, targetRoot) : process.env;
  const call = buildCommand(kind, env);
  execFileSync(call.command, call.args, {
    cwd: call.cwd,
    env: call.env,
    timeout: call.timeout,
    stdio: "inherit",
  });
  const guest = resolve(targetRoot, wasiTarget, "release/tar.wasm");
  if (kind === "wasi") verifyWasiGuest(guest);
  return kind === "wasi" ? guest : resolve(targetRoot, "release/tar");
}

function dependencyNotices() {
  const result = execFileSync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--offline",
      "--format-version",
      "1",
      "--filter-platform",
      "wasm32-wasip1",
      "--manifest-path",
      resolve(packageRoot, "producer/Cargo.toml"),
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  const metadata: unknown = JSON.parse(result);
  return `uutils tar ${lock.upstream.revision}\n${readFileSync(resolve(packageRoot, "licenses/LICENSE.uutils-tar"), "utf8")}\n\n${rustDependencyNotices(metadata, ["waffle-tar-upstream"])}`;
}

export function stageTar(guest: string) {
  const directory = resolve(packageRoot, "dist");
  mkdirSync(directory, { recursive: true });
  const destination = resolve(directory, "tar.wasm");
  stageProgram(guest, destination);
  const stripped = readFileSync(destination);
  const compressed = brotliCompressSync(stripped, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  writeFileSync(`${destination}.br`, compressed);
  const receipt = {
    schemaVersion: 1,
    upstreamRevision: lock.upstream.revision,
    sourceArchiveSha256: lock.upstream.archiveSha256,
    producerLockSha256: sha256(readFileSync(resolve(packageRoot, "producer/Cargo.lock"))),
    rawBytes: readFileSync(guest).length,
    rawSha256: sha256(readFileSync(guest)),
    strippedBytes: stripped.length,
    strippedSha256: sha256(stripped),
    brotliBytes: compressed.length,
    producerManifestSha256: sha256(readFileSync(resolve(packageRoot, "producer/Cargo.toml"))),
    patchSha256: lock.patch.sha256,
    finalization: "pinned optimizer followed by name stripping; see tar-program.json",
  };
  writeFileSync(resolve(directory, "tar.sizes.json"), JSON.stringify(receipt, null, 2) + "\n");
  writeFileSync(resolve(directory, "THIRD_PARTY_NOTICES.txt"), dependencyNotices());
  copyFileSync(resolve(packageRoot, "sources.lock.json"), resolve(directory, "tar.source.json"));
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--prepare") await prepareSource();
  else if (process.argv[2] === "--native") console.log(await buildTar("native"));
  else console.log(JSON.stringify(stageTar(await buildTar("wasi")), null, 2));
}
