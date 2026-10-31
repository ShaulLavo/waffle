import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { identity as gnuNativeIdentity } from "./build-native-date-oracle.ts";
import { checksumNames, type ChecksumName } from "./programs.ts";

// Builds only the nine GNU 9.12 checksum programs from the source, flags and toolchain identity
// that the qualified native date oracle already pins. It never builds date or other programs.
const recipe = "gnu-checksum-native-oracle-v1";
const programs = [
  "b2sum",
  "cksum",
  "md5sum",
  "sha1sum",
  "sha224sum",
  "sha256sum",
  "sha384sum",
  "sha512sum",
  "sum",
] as const satisfies readonly ChecksumName[];
assert.deepEqual(programs, checksumNames, "Checksum program set changed");
const makeTargets = programs.map((name) => `src/${name}`);
const generatedTarget = "checksum-oracle-generated";
const generatedRule = `${generatedTarget}: $(filter lib/% src/version.c src/version.h src/coreutils.h,$(BUILT_SOURCES))\n`;
const metadataName = "metadata.json";
const sourceLock = resolve(import.meta.dirname, "gnu-date-source.json");
const versionEnvironment = { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" };

export const checksumOracleRoot = resolve(
  process.env.GNU_CHECKSUM_ORACLE_ROOT ?? ".build/gnu-checksum-native-oracle",
);

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path: string) => sha(readFileSync(path));
const versionLine = (name: ChecksumName) => `${name} (GNU coreutils) 9.12`;

export interface NativeChecksumOracle {
  readonly root: string;
  readonly identity: string;
  readonly utilities: Readonly<
    Record<ChecksumName, { path: string; version: string; sha256: string }>
  >;
}

export function checksumOracleIdentity() {
  return {
    recipe,
    recipeSha256: fileHash(fileURLToPath(import.meta.url)),
    // GNU source pin, configure flags, CFLAGS, compiler, linker, libc, make, ar and the
    // reused date recipe bytes. Any change there invalidates this cache too.
    base: gnuNativeIdentity(),
    sourceLockSha256: fileHash(sourceLock),
    generatedRule,
    makeTargets,
    versions: Object.fromEntries(programs.map((name) => [name, versionLine(name)])),
  };
}

export const identityKey = (identity: ReturnType<typeof checksumOracleIdentity>) =>
  sha(JSON.stringify(identity));

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function nativeVersion(path: string) {
  const result = spawnSync(path, ["--version"], {
    env: versionEnvironment,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.error, undefined, `${path}: failed to start`);
  assert.equal(result.status, 0, `${path} --version: ${result.stderr}`);
  return result.stdout.split("\n", 1)[0];
}

/** Verifies every cached byte and receipt; any mismatch refuses the cache. */
export function verifyNativeChecksums(root = checksumOracleRoot): NativeChecksumOracle {
  const expected = checksumOracleIdentity();
  const saved = record(JSON.parse(readFileSync(resolve(root, metadataName), "utf8")));
  assert.equal(saved.schema, 1, "Unknown native GNU checksum cache schema");
  assert.deepEqual(
    saved.identity,
    expected,
    "Native GNU checksum source/compiler/recipe identity changed",
  );
  assert.deepEqual(saved.makeTargets, makeTargets, "Native GNU checksum make targets changed");
  assert.deepEqual(saved.builtExecutables, programs, "Native GNU checksum build inventory changed");
  assert.match(String(saved.configHeaderSha256), /^[a-f0-9]{64}$/);
  assert.deepEqual(
    readdirSync(root).sort(),
    [metadataName].concat(programs).sort(),
    "Native GNU checksum cache holds unexpected files",
  );
  const binaries = record(saved.binaries);
  assert.deepEqual(Object.keys(binaries), programs);
  const utilities = Object.fromEntries(
    programs.map((name) => {
      const path = resolve(root, name);
      const receipt = record(binaries[name]);
      const stat = lstatSync(path);
      assert.ok(stat.isFile() && (stat.mode & 0o111) !== 0, `${name} is not a cached executable`);
      const sha256 = fileHash(path);
      assert.equal(sha256, receipt.sha256, `Native GNU ${name} cache binary checksum changed`);
      assert.equal(receipt.version, versionLine(name));
      assert.equal(nativeVersion(path), receipt.version, `Native GNU ${name} version changed`);
      return [name, { path, version: versionLine(name), sha256 }];
    }),
  ) as Record<ChecksumName, { path: string; version: string; sha256: string }>;
  return { root, identity: identityKey(expected), utilities };
}

const buildEnvironment = (cflags: string) => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LC_ALL: "C",
  LANG: "C",
  TZ: "UTC0",
  CONFIG_SITE: "/dev/null",
  CFLAGS: cflags,
  CPPFLAGS: "",
  LDFLAGS: "",
  MAKEFLAGS: "",
});

let active: ChildProcess | undefined;

function step(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<void>((done, fail) => {
    // A private process group lets interruption stop configure, make and every compiler.
    const child = spawn("timeout", ["--kill-after=5s", "900s", command].concat(args), {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    active = child;
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      active = undefined;
      return code === 0
        ? done()
        : fail(new Error(`${command} ${args.join(" ")} failed: ${signal ?? code}`));
    });
  });
}

function builtExecutables(build: string) {
  return readdirSync(resolve(build, "src"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.includes("."))
    .filter((entry) => (statSync(resolve(build, "src", entry.name)).mode & 0o111) !== 0)
    .map((entry) => entry.name)
    .sort();
}

async function build(expected: ReturnType<typeof checksumOracleIdentity>, scratch: string) {
  const env = buildEnvironment(expected.base.cflags);
  const archive = resolve(scratch, "coreutils.tar.xz");
  const source = expected.base.source;
  if (process.env.GNU_CHECKSUM_ORACLE_ARCHIVE) {
    copyFileSync(process.env.GNU_CHECKSUM_ORACLE_ARCHIVE, archive);
  } else {
    const download = ["--fail", "--location", "--max-time", "120", source.archive, "-o", archive];
    await step("curl", download, scratch, env);
  }
  assert.ok(statSync(archive).size <= 16 * 1024 * 1024, "GNU source archive exceeds size limit");
  assert.equal(fileHash(archive), source.archiveSha256, "GNU coreutils archive checksum changed");
  await step("tar", ["-xJf", archive, "-C", scratch], scratch, env);
  const output = resolve(scratch, "build");
  mkdirSync(output);
  const configure = expected.base.flags.concat([`CC=${expected.base.compiler.path}`]);
  // A relative source path keeps the random scratch name out of __FILE__ strings.
  await step(`../coreutils-${source.version}/configure`, configure, output, env);
  writeFileSync(resolve(output, "checksum-oracle.mk"), generatedRule);
  const generated = ["-j4", "-f", "Makefile", "-f", "checksum-oracle.mk", generatedTarget];
  await step("make", generated, output, env);
  await step("make", ["-j4", "V=1"].concat(makeTargets), output, env);
  const built = builtExecutables(output);
  assert.deepEqual(built, programs, "Make built a program outside the checksum set");
  const stage = resolve(scratch, "cache");
  mkdirSync(stage);
  for (const name of programs) {
    copyFileSync(resolve(output, "src", name), resolve(stage, name));
    chmodSync(resolve(stage, name), 0o755);
  }
  const binaries = Object.fromEntries(
    programs.map((name) => {
      const path = resolve(stage, name);
      assert.equal(nativeVersion(path), versionLine(name));
      return [name, { version: versionLine(name), sha256: fileHash(path) }];
    }),
  );
  const metadata = {
    schema: 1,
    identity: expected,
    makeTargets,
    builtExecutables: built,
    configHeaderSha256: fileHash(resolve(output, "lib/config.h")),
    binaries,
  };
  writeFileSync(resolve(stage, metadataName), JSON.stringify(metadata, null, 2) + "\n");
  return stage;
}

async function provision() {
  const expected = checksumOracleIdentity();
  const key = identityKey(expected);
  if (process.argv.includes("--identity")) {
    console.log(key);
    return;
  }
  const root = checksumOracleRoot;
  if (existsSync(root) && readdirSync(root).length > 0) {
    // A present cache is verified, never silently rebuilt or replaced.
    console.log(JSON.stringify({ kind: "cache-hit", oracle: verifyNativeChecksums(root) }));
    return;
  }
  assert.ok(!process.argv.includes("--verify-only"), "GNU checksum oracle cache is absent");
  const scratchRoot = process.env.GNU_CHECKSUM_ORACLE_SCRATCH_ROOT;
  assert.ok(scratchRoot, "Set GNU_CHECKSUM_ORACLE_SCRATCH_ROOT to a verified data-drive directory");
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(resolve(scratchRoot, "gnu-checksum-build-"));
  const interrupt = (signal: NodeJS.Signals) => {
    if (active?.pid) process.kill(-active.pid, "SIGKILL");
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", interrupt).once("SIGTERM", interrupt);
  try {
    const stage = await build(expected, scratch);
    mkdirSync(dirname(root), { recursive: true });
    // Only an empty placeholder may be replaced; rmdir refuses a concurrently filled cache.
    if (existsSync(root)) rmdirSync(root);
    renameSync(stage, root);
    console.log(JSON.stringify({ kind: "built", oracle: verifyNativeChecksums(root) }));
  } finally {
    process.off("SIGINT", interrupt).off("SIGTERM", interrupt);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await provision();
}
