import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { teeOutputNames, type TeeCase } from "../fixtures/tee-cases.ts";
import source from "../provenance/tee.source.json" with { type: "json" };

const env = { ...process.env, LC_ALL: "C", LANG: "C", LANGUAGE: "en_US" };

export function verifyGnuTee() {
  const path = process.env.GNU_TEE ?? source.oracle.path;
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  assert.equal(sha256, source.oracle.sha256, "GNU tee executable bytes changed");
  const result = spawnSync(path, ["--version"], { env, timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  const version = result.stdout.toString().split("\n")[0];
  assert.equal(version, source.oracle.version);
  return { path, sha256, version };
}

export function observeNativeTee(fixture: TeeCase) {
  const oracle = verifyGnuTee();
  const root = process.env.TEE_SCRATCH_ROOT;
  assert.ok(root, "Set TEE_SCRATCH_ROOT to a verified data-drive directory");
  const cwd = mkdtempSync(resolve(root, "tee-oracle-"));
  try {
    return observeFixture(cwd, oracle.path, fixture);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    assert.equal(existsSync(cwd), false, "Native fixture survived teardown");
  }
}

function observeFixture(cwd: string, executable: string, fixture: TeeCase) {
  for (const [name, content] of Object.entries(fixture.files))
    writeFileSync(resolve(cwd, name), content);
  if (fixture.denied) {
    assert.notEqual(process.getuid?.(), 0, "Denial requires a real unprivileged principal");
    chmodSync(resolve(cwd, fixture.denied), 0o400);
  }
  const command = fixture.closedStdout ? "/bin/sh" : executable;
  const args = fixture.closedStdout
    ? ["-c", 'exec "$@" >&-', "tee-closed-stdout", executable].concat(fixture.args)
    : fixture.args;
  const result = spawnSync(command, args, {
    cwd,
    env,
    input: fixture.input,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, fixture.name);
  assert.notEqual(result.status, null, fixture.name);
  const files = Object.fromEntries(
    teeOutputNames(fixture).map((name) => {
      const path = resolve(cwd, name);
      return [name, existsSync(path) ? readFileSync(path) : null];
    }),
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, files };
}
