import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { awkCases, unsupportedCases, type AwkCase } from "../tests/awk-cases.ts";
import { runEvaluator } from "../tests/evaluator-command.ts";
import { readOracle } from "../tests/record-awk-oracle.ts";

const guest = resolve(import.meta.dirname, "../dist/awk.wasm");
const wasmtime = process.env.WASMTIME ?? "wasmtime";
const oracle = readOracle();

function execute(fixture: AwkCase, timeout = 15_000) {
  const root = mkdtempSync(
    resolve(process.env.AWK_SCRATCH_ROOT ?? "/work/tmp", "waffle-awk-wasmtime-"),
  );
  try {
    for (const [name, text] of Object.entries(fixture.files ?? {})) {
      mkdirSync(dirname(resolve(root, name)), { recursive: true });
      writeFileSync(resolve(root, name), text);
    }
    const result = runEvaluator(
      {
        name: fixture.name,
        executable: wasmtime,
        args: [
          "run",
          "-W",
          "exceptions=y",
          "--argv0",
          "awk",
          "--dir",
          `${root}::/awk-work`,
          "--env",
          "PWD=/awk-work",
          "--env",
          "LC_ALL=C.UTF-8",
          "--env",
          "AWK_FIXTURE=from-environment",
          guest,
        ].concat(fixture.args),
        input: fixture.stdin ?? "",
      },
      timeout,
    );
    assert.equal(result.signal, null, fixture.name);
    const files = Object.fromEntries(
      (fixture.outputFiles ?? []).map((name) => [name, readFileSync(resolve(root, name), "utf8")]),
    );
    return { exit: result.status, stdout: result.stdout, stderr: result.stderr, files };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const fixture of awkCases)
  assert.deepEqual(execute(fixture), oracle[fixture.name], fixture.name);
for (const fixture of unsupportedCases) {
  const result = execute({ name: fixture.name, args: [fixture.program] });
  assert.equal(result.exit, 2, fixture.name);
  assert.equal(result.stdout, "", fixture.name);
  assert.ok(result.stderr.includes(fixture.diagnostic), fixture.name);
}
assert.throws(
  () => execute({ name: "real awk infinite loop deadline", args: ["BEGIN { for (;;) {} }"] }, 500),
  /deadline|timed out|ETIMEDOUT/,
);
console.log(
  `${awkCases.length} exact native-versus-Wasm cases, ${unsupportedCases.length} explicit capability refusals, and a real infinite-loop deadline passed`,
);
