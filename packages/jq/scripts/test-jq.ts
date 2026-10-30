import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { jqCases, type JqCase } from "../tests/jq-cases.ts";
import { runEvaluator } from "../tests/evaluator-command.ts";
import { executeNative, readOracle, type JqObservation } from "../tests/record-jq-oracle.ts";

const root = resolve(import.meta.dirname, "..");
const nativeIndex = process.argv.indexOf("--native");
const native = nativeIndex < 0 ? undefined : process.argv[nativeIndex + 1];
assert.ok(
  process.argv.length === 2 || (native && nativeIndex === 2 && process.argv.length === 4),
  "Use [--native <jq executable>]",
);
const oracle = readOracle();
const wasmtime = process.env.WASMTIME ?? "wasmtime";

function executeWasm(fixture: JqCase): JqObservation {
  const env = Object.entries(fixture.env ?? {}).flatMap(([name, value]) => [
    "--env",
    `${name}=${value}`,
  ]);
  const guest = resolve(root, "dist/jq.wasm");
  assert.ok(existsSync(guest), "Build dist/jq.wasm first");
  const result = runEvaluator({
    name: fixture.name,
    executable: wasmtime,
    args: ["run"].concat(env, [guest], fixture.args),
    input: fixture.stdin ?? "",
  });
  assert.equal(result.signal, null, fixture.name);
  assert.ok(typeof result.status === "number", fixture.name);
  return { exit: result.status, stdout: result.stdout, stderr: result.stderr };
}

function checkExact(actual: JqObservation, expected: JqObservation, name: string) {
  assert.equal(actual.exit, expected.exit, `${name}: exit; ${actual.stderr}`);
  assert.equal(actual.stdout, expected.stdout, `${name}: stdout`);
  assert.equal(actual.stderr, expected.stderr, `${name}: stderr`);
}

function checkCandidate(actual: JqObservation, fixture: JqCase) {
  const expected = oracle.cases[fixture.name];
  assert.ok(expected, `Missing oracle case: ${fixture.name}`);
  if (!fixture.error) return checkExact(actual, expected, fixture.name);
  assert.equal(actual.exit, fixture.error.candidateExit, `${fixture.name}: candidate exit`);
  assert.equal(actual.stdout, expected.stdout, `${fixture.name}: candidate stdout`);
  assert.ok(
    actual.stderr.includes(fixture.error.candidateStderr),
    `${fixture.name}: candidate stderr: ${actual.stderr}`,
  );
}

for (const fixture of jqCases) {
  const actual = native ? executeNative(native, fixture) : executeWasm(fixture);
  if (native) {
    const expected = oracle.cases[fixture.name];
    assert.ok(expected, `Missing oracle case: ${fixture.name}`);
    checkExact(actual, expected, fixture.name);
  } else {
    checkCandidate(actual, fixture);
  }
}

console.log(
  `${native ? oracle.nativeVersion : "jaq WASI"}: ${jqCases.length} native-oracle cases passed`,
);
