import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { awkCases, type AwkCase } from "./awk-cases.ts";
import { runEvaluator } from "./evaluator-command.ts";
import { sourceLock } from "../scripts/source-lock.ts";

export interface AwkObservation {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly files: Readonly<Record<string, string>>;
}
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const native = resolve(import.meta.dirname, "../.build/native/awk");
const fixtureSha256 = sha256(JSON.stringify(awkCases));

export function executeNative(fixture: AwkCase, timeoutMs = 15_000): AwkObservation {
  const root = mkdtempSync(
    resolve(process.env.AWK_SCRATCH_ROOT ?? "/work/tmp", "waffle-awk-oracle-"),
  );
  try {
    for (const [name, contents] of Object.entries(fixture.files ?? {})) {
      mkdirSync(dirname(resolve(root, name)), { recursive: true });
      writeFileSync(resolve(root, name), contents);
    }
    const result = runEvaluator(
      {
        name: fixture.name,
        executable: native,
        argv0: "awk",
        args: fixture.args,
        cwd: root,
        input: fixture.stdin ?? "",
        env: { ...process.env, LC_ALL: "C.UTF-8", AWK_FIXTURE: "from-environment" },
      },
      timeoutMs,
    );
    assert.equal(result.signal, null, fixture.name);
    assert.ok(typeof result.status === "number", fixture.name);
    const files = Object.fromEntries(
      (fixture.outputFiles ?? []).map((name) => [name, readFileSync(resolve(root, name), "utf8")]),
    );
    return { exit: result.status, stdout: result.stdout, stderr: result.stderr, files };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function verifyNativeIdentity(): void {
  const receipt: unknown = JSON.parse(readFileSync(`${native}.json`, "utf8"));
  assert.ok(
    receipt &&
      typeof receipt === "object" &&
      "revision" in receipt &&
      "archiveSha256" in receipt &&
      "executableSha256" in receipt &&
      "patchSha256" in receipt,
  );
  assert.equal(receipt.revision, sourceLock.upstream.revision);
  assert.equal(receipt.archiveSha256, sourceLock.upstream.archiveSha256);
  assert.equal(receipt.executableSha256, sha256(readFileSync(native)));
  assert.ok("patchSha256" in receipt);
  assert.equal(
    receipt.patchSha256,
    sha256(readFileSync(resolve(import.meta.dirname, "../patches/wasi-unsupported-ops.patch"))),
  );
}

export function readOracle(): Readonly<Record<string, AwkObservation>> {
  const oracle: unknown = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "awk-oracle.json"), "utf8"),
  );
  assert.ok(
    oracle &&
      typeof oracle === "object" &&
      "revision" in oracle &&
      "fixtureSha256" in oracle &&
      "cases" in oracle,
  );
  assert.equal(oracle.revision, sourceLock.upstream.revision);
  assert.equal(
    oracle.fixtureSha256,
    fixtureSha256,
    "Oracle fixtures changed; record the pinned native oracle again",
  );
  assert.ok(oracle.cases && typeof oracle.cases === "object");
  return Object.fromEntries(
    Object.entries(oracle.cases).map(([name, value]: [string, unknown]) => {
      assert.ok(
        value &&
          typeof value === "object" &&
          "exit" in value &&
          "stdout" in value &&
          "stderr" in value &&
          "files" in value,
      );
      assert.equal(typeof value.exit, "number");
      assert.ok(
        typeof value.exit === "number" &&
          typeof value.stdout === "string" &&
          typeof value.stderr === "string",
      );
      assert.ok(value.files && typeof value.files === "object");
      const files = Object.fromEntries(
        Object.entries(value.files).map(([path, text]: [string, unknown]) => {
          assert.equal(typeof text, "string");
          return [path, String(text)];
        }),
      );
      return [name, { exit: value.exit, stdout: value.stdout, stderr: value.stderr, files }];
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyNativeIdentity();
  const cases = Object.fromEntries(
    awkCases.map((fixture) => [fixture.name, executeNative(fixture)]),
  );
  const oracle = { revision: sourceLock.upstream.revision, fixtureSha256, cases };
  writeFileSync(
    resolve(import.meta.dirname, "awk-oracle.json"),
    JSON.stringify(oracle, null, 2) + "\n",
  );
  console.log(`Recorded ${awkCases.length} pinned native onetrue-awk observations`);
}
