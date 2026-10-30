import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256, targetRoot } from "../scripts/build-tar.ts";

export const native = process.env.TAR_NATIVE ?? resolve(targetRoot, "release/tar");
export interface Observation {
  readonly status: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}
export interface ArchiveCase {
  readonly name: string;
  readonly args: readonly string[];
  readonly input?: Uint8Array;
  readonly cwd?: string;
}
export function command(
  executable: string,
  args: readonly string[],
  cwd: string,
  input?: Uint8Array,
): Observation {
  const result = spawnSync(executable, args, {
    cwd,
    input,
    timeout: 15_000,
    killSignal: "SIGKILL",
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC", NO_COLOR: "1" },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${executable}: signal ${result.signal}`);
  assert.equal(typeof result.status, "number");
  assert.ok(result.status !== null);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
export function text(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes);
}
export function nativeIdentity() {
  const version = text(command(native, ["--version"], "/").stdout).trim();
  assert.match(version, /tar \(uutils\) 0\.0\.0/);
  const gnuVersion = text(command("/usr/bin/tar", ["--version"], "/").stdout).split("\n")[0];
  assert.equal(gnuVersion, "tar (GNU tar) 1.35", "this oracle corpus requires GNU tar 1.35");
  return {
    nativeVersion: version,
    nativeSha256: sha256(readFileSync(native)),
    gnuVersion,
    gnuSha256: sha256(readFileSync("/usr/bin/tar")),
  };
}
export interface FixtureSet {
  readonly directory: string;
  readonly archive: Uint8Array;
  readonly gzip: Uint8Array;
  readonly corruptGzip: Uint8Array;
  readonly cases: readonly ArchiveCase[];
  readonly expectedList: string;
}
export async function withFixtures<T>(run: (fixtures: FixtureSet) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(
    resolve(process.env.TAR_SCRATCH_ROOT ?? "/work/tmp", "waffle-tar-fixture-"),
  );
  try {
    return await run(makeFixtures(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function makeFixtures(directory: string): FixtureSet {
  const source = resolve(directory, "source");
  mkdirSync(resolve(source, "tree/sub"), { recursive: true });
  writeFileSync(resolve(source, "alpha.txt"), "alpha\nsecond line\n");
  writeFileSync(
    resolve(source, "tree/sub/binary"),
    Uint8Array.from({ length: 9000 }, (_, index) => index % 251),
  );
  for (const name of ["alpha.txt", "tree", "tree/sub", "tree/sub/binary"])
    utimesSync(resolve(source, name), 1_700_000_000, 1_700_000_000);
  const archivePath = resolve(directory, "fixture.tar");
  const produced = command(
    "/usr/bin/tar",
    [
      "--format=ustar",
      "--blocking-factor=1",
      "--sort=name",
      "--owner=1000",
      "--group=1000",
      "--numeric-owner",
      "--mtime=@1700000000",
      "--mode=0755",
      "-cf",
      archivePath,
      "-C",
      source,
      "alpha.txt",
      "tree",
    ],
    directory,
  );
  assert.equal(produced.status, 0, text(produced.stderr));
  const archive = readFileSync(archivePath);
  assert.equal(sha256(archive), "918988ada7dc61ddcda879f47af68b04e420539464e2863946ef38b6e524b9df");
  const compressed = command("/usr/bin/gzip", ["-n", "-c", archivePath], directory);
  assert.equal(compressed.status, 0, text(compressed.stderr));
  const gzip = compressed.stdout;
  assert.equal(sha256(gzip), "5e227e3ec9bad7e895da81242c87ab26d8ad73f4c1b29bfb43fd64154aa42e94");
  writeFileSync(resolve(directory, "fixture.tar.gz"), gzip);
  const corruptGzip = Uint8Array.from(gzip);
  const crcIndex = corruptGzip.length - 8;
  const old = corruptGzip[crcIndex];
  assert.ok(old !== undefined);
  corruptGzip[crcIndex] = old ^ 255;
  writeFileSync(resolve(directory, "corrupt.tar.gz"), corruptGzip);
  writeFileSync(resolve(directory, "invalid.tar"), "this is not a tar archive\n");
  const cases: ArchiveCase[] = [
    { name: "list file with multiple entries", args: ["-tf", "fixture.tar"] },
    { name: "old keystring list", args: ["tf", "fixture.tar"] },
    { name: "verbose deterministic metadata", args: ["-tvf", "fixture.tar"] },
    { name: "gzip autodetection", args: ["-tf", "fixture.tar.gz"] },
    { name: "explicit gzip", args: ["-ztf", "fixture.tar.gz"] },
    { name: "stdin tar pipeline", args: ["-tf", "-"], input: archive },
    { name: "stdin gzip pipeline", args: ["-ztf", "-"], input: gzip },
    {
      name: "archive path remains relative to original cwd with -C",
      args: ["-C", "source", "-tf", "fixture.tar"],
    },
    { name: "missing archive", args: ["-tf", "missing.tar"] },
    { name: "invalid archive", args: ["-tf", "invalid.tar"] },
    { name: "gzip checksum failure", args: ["-tf", "corrupt.tar.gz"] },
    { name: "unsupported compressor", args: ["--zstd", "-tf", "fixture.tar"] },
    { name: "unsupported xz helper", args: ["-Jtf", "fixture.tar"] },
    {
      name: "member selection fails instead of ignoring operands",
      args: ["-tf", "fixture.tar", "alpha.txt"],
    },
  ];
  return {
    directory,
    archive,
    gzip,
    corruptGzip,
    cases,
    expectedList: "alpha.txt\ntree/\ntree/sub/\ntree/sub/binary\n",
  };
}
