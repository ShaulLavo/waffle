import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cutTrCases } from "../tests/helpers/cut-tr-cases.ts";

const bashPath = process.argv[2];
assert.ok(bashPath, "usage: npm run record:cut-tr -- /absolute/path/to/bash-5.3.15");
const bash = resolve(bashPath);
const environment = { PATH: "/usr/bin:/bin", HOME: "/tmp/spec", LC_ALL: "C" };

function identity(path: string) {
  const result = spawnSync(path, ["--version"], { env: environment, timeout: 3000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  return {
    version: result.stdout.toString().split("\n")[0],
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

const oracle = { bash: identity(bash), cut: identity("/usr/bin/cut"), tr: identity("/usr/bin/tr") };
assert.equal(oracle.bash.version, "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)");
assert.match(oracle.cut.version, /^cut \(GNU coreutils\) /);
assert.match(oracle.tr.version, /^tr \(GNU coreutils\) /);

const cases = cutTrCases.map(([name, script]) => {
  const cwd = mkdtempSync(join(tmpdir(), "bash-web-cut-tr-record-"));
  try {
    const result = spawnSync(bash, ["--noprofile", "--norc", "-c", script], {
      env: environment,
      cwd,
      timeout: 3000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.ok(result.status !== null);
    return {
      name,
      script,
      status: result.status,
      stdoutBase64: result.stdout.toString("base64"),
      stderrPresent: result.stderr.length > 0,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
writeFileSync(
  new URL("../fixtures/cut-tr.json", import.meta.url),
  JSON.stringify({ schema: 1, oracle, environment, cases }, null, 2) + "\n",
  { flag: "wx" },
);
