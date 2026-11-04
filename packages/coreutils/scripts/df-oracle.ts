import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dfCases, unsupportedDfCases, type DfCase } from "../fixtures/df-cases.ts";

export const gnuDf = {
  version: "df (GNU coreutils) 9.12",
  sha256: "5f184ff8141c04e3b0492a3a94c68ab1a178756cd17465b452bbce256061e81e",
} as const;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const env = { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", LANGUAGE: "en_US", TZ: "UTC" };

function run(binary: string, args: readonly string[], cwd: string) {
  const result = spawnSync(binary, args, { cwd, env, timeout: 10_000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, null);
  return result;
}

function compare(binary: string, oracle: string, cwd: string, fixture: DfCase) {
  const reference = run(oracle, fixture.args, cwd);
  const actual = run(binary, fixture.args, cwd);
  assert.equal(reference.status, fixture.status, `${fixture.name}: GNU status`);
  assert.equal(actual.status, reference.status, `${fixture.name}: upstream status`);
  assert.equal(actual.stderr.length > 0, reference.stderr.length > 0, fixture.name);
  if (fixture.metadata) {
    assert.match(actual.stdout.toString(), /df/);
    assert.equal(actual.stderr.length, 0);
  } else {
    assert.deepEqual(actual.stdout, reference.stdout, `${fixture.name}: stdout`);
  }
  return {
    name: fixture.name,
    status: actual.status,
    stdoutBytes: actual.stdout.length,
    stdoutSha256: sha256(actual.stdout),
    diagnostic: actual.stderr.length > 0,
  };
}

export function compareDf(binary: string, root: string, oracle = "/usr/bin/df") {
  assert.equal(sha256(readFileSync(oracle)), gnuDf.sha256, "Unpinned GNU df oracle");
  assert.equal(run(oracle, ["--version"], root).stdout.toString().split("\n")[0], gnuDf.version);
  assert.equal(
    run(binary, ["--version"], root).stdout.toString().trim(),
    "df (uutils coreutils) 0.13.0",
  );
  const directory = mkdtempSync(resolve(root, "df-oracle-"));
  try {
    writeFileSync(resolve(directory, "input"), "owned fixture\n");
    writeFileSync(resolve(directory, "file with spaces"), "");
    mkdirSync(resolve(directory, "directory"));
    symlinkSync("input", resolve(directory, "link"));
    symlinkSync("missing", resolve(directory, "broken"));
    return {
      oracle: gnuDf,
      candidateSha256: sha256(readFileSync(binary)),
      cases: dfCases.map((fixture) => compare(binary, oracle, directory, fixture)),
      unsupported: unsupportedDfCases,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const binary = process.argv[2];
  const root = process.env.DF_SCRATCH_ROOT;
  assert.ok(binary && root, "Usage: DF_SCRATCH_ROOT=<owned scratch> bun df-oracle.ts <native df>");
  process.stdout.write(`${JSON.stringify(compareDf(resolve(binary), root), null, 2)}\n`);
}
