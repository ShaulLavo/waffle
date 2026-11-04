import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { duCases } from "../fixtures/du-cases.ts";

import provenance from "../provenance/du.source.json" with { type: "json" };
const oracle = provenance.nativeOracle;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const environment = { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" };

function execute(command: string, args: readonly string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...environment, PWD: cwd },
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${command} terminated by signal`);
  assert.notEqual(result.status, null);
  return {
    status: result.status,
    stdout: result.stdout.toString("base64"),
    stderr: result.stderr.toString("base64"),
  };
}

export function verifyDuOracle(path = oracle.path) {
  assert.equal(sha256(readFileSync(path)), oracle.sha256, "Unpinned native du oracle");
  const result = execute(path, ["--version"], "/");
  assert.equal(result.status, 0);
  assert.equal(Buffer.from(result.stdout, "base64").toString().split("\n")[0], oracle.version);
  return oracle;
}

function fixtures(root: string) {
  mkdirSync(resolve(root, "tree/sub"), { recursive: true });
  for (const [path, text] of [
    ["tree/a", "abc"],
    ["tree/empty", ""],
    ["tree/sub/b", "x".repeat(2049)],
    ["tree/space name", "space"],
    ["tree/שלום", "hello"],
    ["-operand", "dash"],
  ]) {
    assert.ok(path !== undefined && text !== undefined);
    writeFileSync(resolve(root, path), text);
  }
  const fd = openSync(resolve(root, "sparse"), "w");
  try {
    ftruncateSync(fd, 8193);
  } finally {
    closeSync(fd);
  }
  linkSync(resolve(root, "tree/a"), resolve(root, "hard"));
  symlinkSync("tree/a", resolve(root, "link"));
}

function orderedRows(base64: string, zero: boolean) {
  return Buffer.from(base64, "base64")
    .toString("utf8")
    .split(zero ? "\0" : "\n")
    .sort();
}

export function compareDu(candidate: string) {
  const identity = verifyDuOracle();
  const scratchRoot = process.env.DU_SCRATCH_ROOT;
  assert.ok(scratchRoot, "DU_SCRATCH_ROOT must name an owned data-drive directory");
  const root = mkdtempSync(resolve(scratchRoot, "du-fixtures-"));
  const cases = [];
  try {
    fixtures(root);
    for (const item of duCases) {
      const expected = execute(identity.path, item.args, root);
      const actual = execute(candidate, item.args, root);
      const zero = item.args.some((arg) => arg === "-b0");
      assert.equal(expected.status, item.status, `${item.name}: GNU status`);
      const matches =
        actual.status === expected.status &&
        JSON.stringify(orderedRows(actual.stdout, zero)) ===
          JSON.stringify(orderedRows(expected.stdout, zero)) &&
        actual.stderr.length > 0 === expected.stderr.length > 0;
      cases.push({ ...item, expected, actual, matches });
    }
    const apparent = execute(candidate, ["-b", "sparse"], root);
    assert.equal(Buffer.from(apparent.stdout, "base64").toString(), "8193\tsparse\n");
    return {
      oracle: identity,
      candidate: { sha256: sha256(readFileSync(candidate)) },
      apparentDirectoryObservation: {
        expected: execute(identity.path, ["-bs", "tree"], root),
        actual: execute(candidate, ["-bs", "tree"], root),
        qualification: "Not a parity case: upstream excludes native directory metadata lengths",
      },
      comparison:
        "Exact status and output rows; row order ignored, stderr presence compared. Raw bytes retained as base64.",
      passed: cases.filter((item) => item.matches).length,
      failed: cases.filter((item) => !item.matches).length,
      cases,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const candidate = process.argv[2];
  assert.ok(candidate, "Usage: du-oracle.ts NATIVE_CANDIDATE");
  const result = compareDu(resolve(candidate));
  console.log(JSON.stringify(result, null, 2));
  if (result.failed > 0) process.exitCode = 1;
}
