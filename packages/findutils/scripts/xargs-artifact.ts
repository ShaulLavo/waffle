import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readProgramLocaleProof } from "../../../tools/program-locales/prepare.ts";
import { verifyWasiGuest, wasiBuildConfiguration } from "../../../tools/program-build-tools.ts";

export const workspaceRoot = resolve(import.meta.dirname, "../../..");
const inputs = [
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "packages/findutils/Cargo.toml",
  "packages/findutils/src/bin/xargs.rs",
  "packages/findutils/vendor/uutils-xargs",
  "packages/findutils/scripts/build-findutils.ts",
  "packages/findutils/scripts/build-xargs.ts",
  "packages/findutils/scripts/xargs-source.ts",
  "packages/findutils/scripts/xargs-artifact.ts",
  "packages/process-consumer",
  "tools/program-build-tools.ts",
  "tools/program-locales",
  "packages/waffle/scripts/build-wasi-libc.sh",
  "packages/waffle/patches/wasi-libc/preopen-scan.patch",
];

export function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}
function git(args: string[]) {
  return execFileSync("git", args, { cwd: workspaceRoot, encoding: "utf8" }).trim();
}
export function githubIdentity() {
  const sourceCommit = process.env.GITHUB_SHA;
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  assert.ok(sourceCommit && /^[a-f0-9]{40}$/.test(sourceCommit), "GITHUB_SHA required");
  assert.ok(runId && /^\d+$/.test(runId), "GITHUB_RUN_ID required");
  assert.ok(runAttempt && /^\d+$/.test(runAttempt), "GITHUB_RUN_ATTEMPT required");
  assert.equal(git(["rev-parse", "HEAD"]), sourceCommit, "checkout differs from artifact run SHA");
  return { sourceCommit, runId, runAttempt };
}

export function sourceInputs(paths: string[]) {
  assert.equal(
    git(["diff", "--name-only", "HEAD", "--"].concat(paths)),
    "",
    "dirty producer inputs",
  );
  const files = git(["ls-files", "--"].concat(paths)).split("\n").sort();
  assert.ok(files.length > 0 && files.every(Boolean));
  return files.map((path) => ({
    path,
    blob: git(["rev-parse", `HEAD:${path}`]),
    sha256: sha256(readFileSync(resolve(workspaceRoot, path))),
  }));
}

function environment() {
  const config = wasiBuildConfiguration({
    root: workspaceRoot,
    waffle: resolve(workspaceRoot, "packages/waffle"),
  });
  return {
    sdkVersion: readFileSync(resolve(config.sdk, "VERSION"), "utf8"),
    rustcVersion: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
    sysrootRecipe: config.identity,
    libcSha256: sha256(readFileSync(resolve(config.sysroot, "lib/wasm32-wasip1/libc.a"))),
  };
}

function receipt(bytes: Uint8Array, locales: unknown) {
  return {
    schema: "waffle-xargs-process-artifact/v1",
    identity: githubIdentity(),
    inputs: sourceInputs(inputs),
    environment: environment(),
    locales,
    guest: { bytes: bytes.length, sha256: sha256(bytes) },
  };
}

export function writeXargsArtifact(directory: string) {
  const guest = resolve(workspaceRoot, ".build/findutils/wasm32-wasip1/release/xargs.wasm");
  verifyWasiGuest(guest);
  const bytes = readFileSync(guest);
  const proof = receipt(bytes, readProgramLocaleProof(guest, "xargs"));
  mkdirSync(directory, { recursive: true });
  copyFileSync(guest, resolve(directory, "xargs.wasm"));
  copyFileSync(`${guest}.locales.json`, resolve(directory, "xargs.wasm.locales.json"));
  writeFileSync(resolve(directory, "receipt.json"), JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
}

export function verifyXargsArtifact(directory: string) {
  const path = resolve(directory, "xargs.wasm");
  const bytes = readFileSync(path);
  const actual: unknown = JSON.parse(readFileSync(resolve(directory, "receipt.json"), "utf8"));
  const expected = receipt(bytes, readProgramLocaleProof(path, "xargs"));
  assert.deepEqual(actual, expected, "xargs artifact source/run/input/checksum identity mismatch");
  verifyWasiGuest(path);
  return { bytes, receipt: expected };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, "pass the output artifact directory");
  writeXargsArtifact(resolve(process.argv[2]!));
}
