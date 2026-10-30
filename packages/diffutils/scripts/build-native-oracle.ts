import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { resolve } from "node:path";
import { packageRoot, sourceLock, workspaceRoot } from "./build-config.ts";

const recipeIdentity = "gnu-diffutils-native-oracle-v1";
const maximumArchiveBytes = 16 * 1024 * 1024;
const nativeOracleRoot = resolve(
  process.env.NATIVE_ORACLE_ROOT ?? resolve(workspaceRoot, ".build/diffutils-native-oracle"),
);
const nativeOracleScratchRoot = resolve(
  process.env.NATIVE_ORACLE_SCRATCH_ROOT ?? resolve(nativeOracleRoot, ".."),
);
const nativeDiff = resolve(nativeOracleRoot, "diff");
const nativeCmp = resolve(nativeOracleRoot, "cmp");
const metadataPath = resolve(nativeOracleRoot, "metadata.json");

interface CompilerIdentity {
  readonly target: string;
  readonly version: string;
}

interface BinaryMetadata {
  readonly version: string;
  readonly sha256: string;
}

interface NativeOracleMetadata {
  readonly schemaVersion: 1;
  readonly recipe: string;
  readonly source: {
    readonly archive: string;
    readonly archiveSha256: string;
    readonly version: string;
  };
  readonly compiler: CompilerIdentity;
  readonly binaries: {
    readonly diff: BinaryMetadata;
    readonly cmp: BinaryMetadata;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBinaryMetadata(value: unknown): value is BinaryMetadata {
  if (!isRecord(value)) return false;
  return typeof value.version === "string" && typeof value.sha256 === "string";
}

function isNativeOracleMetadata(value: unknown): value is NativeOracleMetadata {
  if (!isRecord(value)) return false;
  const source = value.source;
  const compiler = value.compiler;
  const binaries = value.binaries;
  if (!isRecord(source) || !isRecord(compiler) || !isRecord(binaries)) return false;
  return (
    value.schemaVersion === 1 &&
    value.recipe === recipeIdentity &&
    typeof source.archive === "string" &&
    typeof source.archiveSha256 === "string" &&
    typeof source.version === "string" &&
    typeof compiler.target === "string" &&
    typeof compiler.version === "string" &&
    isBinaryMetadata(binaries.diff) &&
    isBinaryMetadata(binaries.cmp)
  );
}

function firstLine(output: string): string {
  return output.split(/\r?\n/, 1)[0] ?? "";
}

function compilerIdentity(): CompilerIdentity {
  const compiler = process.env.CC ?? "cc";
  const target = execFileSync(compiler, ["-dumpmachine"], { encoding: "utf8" }).trim();
  const version = firstLine(execFileSync(compiler, ["--version"], { encoding: "utf8" })).trim();
  assert.ok(target, "Native oracle compiler target is empty");
  assert.ok(version, "Native oracle compiler version is empty");
  return { target, version };
}

function compilerIdentityHash(identity: CompilerIdentity): string {
  return createHash("sha256").update(`${identity.target}\n${identity.version}\n`).digest("hex");
}

function run(command: string, args: readonly string[], cwd: string): void {
  execFileSync(command, args, {
    cwd,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    stdio: "inherit",
  });
}

async function downloadArchive(): Promise<Uint8Array> {
  const response = await fetch(sourceLock.upstream.archive, {
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `GNU diffutils source download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.byteLength <= maximumArchiveBytes, "GNU diffutils archive is unexpectedly large");
  const actual = createHash("sha256").update(bytes).digest("hex");
  assert.equal(actual, sourceLock.upstream.archiveSha256, "GNU diffutils archive checksum");
  return bytes;
}

function nativeVersion(executable: string, program: string): string {
  const output = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  const version = firstLine(output);
  assert.match(version, /GNU diffutils\) 3\.12/, `${program}: ${version}`);
  return version;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function binaryMetadata(executable: string, program: string): BinaryMetadata {
  return { version: nativeVersion(executable, program), sha256: sha256(executable) };
}

function expectedMetadata(compiler: CompilerIdentity): NativeOracleMetadata {
  return {
    schemaVersion: 1,
    recipe: recipeIdentity,
    source: {
      archive: sourceLock.upstream.archive,
      archiveSha256: sourceLock.upstream.archiveSha256,
      version: sourceLock.upstream.version,
    },
    compiler,
    binaries: {
      diff: binaryMetadata(nativeDiff, "diff"),
      cmp: binaryMetadata(nativeCmp, "cmp"),
    },
  };
}

function verifyCachedOracle(compiler: CompilerIdentity): void {
  assert.ok(existsSync(metadataPath), `Missing native oracle metadata: ${metadataPath}`);
  const parsed: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
  assert.ok(isNativeOracleMetadata(parsed), "Invalid native oracle metadata");
  assert.deepEqual(parsed.source, {
    archive: sourceLock.upstream.archive,
    archiveSha256: sourceLock.upstream.archiveSha256,
    version: sourceLock.upstream.version,
  });
  assert.equal(parsed.compiler.target, compiler.target);
  assert.equal(parsed.compiler.version, compiler.version);
  assert.deepEqual(parsed.binaries.diff, binaryMetadata(nativeDiff, "diff"));
  assert.deepEqual(parsed.binaries.cmp, binaryMetadata(nativeCmp, "cmp"));
  const expectedHash = process.env.NATIVE_ORACLE_COMPILER_IDENTITY;
  if (expectedHash !== undefined)
    assert.equal(compilerIdentityHash(compiler), expectedHash, "Native oracle compiler identity");
}

async function buildNativeOracle(compiler: CompilerIdentity): Promise<void> {
  mkdirSync(nativeOracleRoot, { recursive: true });
  mkdirSync(nativeOracleScratchRoot, { recursive: true });
  const archive = resolve(nativeOracleScratchRoot, "diffutils-3.12.tar.xz");
  const source = mkdtempSync(resolve(nativeOracleScratchRoot, "diffutils-native-source-"));
  const build = mkdtempSync(resolve(nativeOracleScratchRoot, "diffutils-native-build-"));

  try {
    writeFileSync(archive, await downloadArchive());
    run("tar", ["-xJf", archive, "--strip-components=1", "-C", source], workspaceRoot);
    run(resolve(source, "configure"), ["--disable-nls", "--disable-rpath"], build);
    run("make", ["-C", resolve(build, "lib"), "-j2"], workspaceRoot);
    run(
      "make",
      ["-C", resolve(build, "src"), "-j2", "paths.h", "version.h", "diff", "cmp"],
      workspaceRoot,
    );
    copyFileSync(resolve(build, "src/diff"), nativeDiff);
    copyFileSync(resolve(build, "src/cmp"), nativeCmp);
    chmodSync(nativeDiff, 0o755);
    chmodSync(nativeCmp, 0o755);
    writeFileSync(metadataPath, `${JSON.stringify(expectedMetadata(compiler), null, 2)}\n`);
  } finally {
    rmSync(archive, { force: true });
    rmSync(source, { recursive: true, force: true });
    rmSync(build, { recursive: true, force: true });
  }
}

const compiler = compilerIdentity();
const hasCachedArtifacts = [nativeDiff, nativeCmp, metadataPath].some(existsSync);
if (hasCachedArtifacts) {
  verifyCachedOracle(compiler);
  console.log(`Verified cached GNU diffutils ${sourceLock.upstream.version} native oracle`);
} else {
  await buildNativeOracle(compiler);
  verifyCachedOracle(compiler);
  console.log(`Built GNU diffutils ${sourceLock.upstream.version} native oracle`);
}

console.log(`GNU_DIFF=${nativeDiff}`);
console.log(`GNU_CMP=${nativeCmp}`);
