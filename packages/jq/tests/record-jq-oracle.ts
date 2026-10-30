import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { jqCases, type JqCase } from "./jq-cases.ts";

export interface JqObservation {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface JqOracle {
  readonly schemaVersion: 1;
  readonly nativeVersion: string;
  readonly cases: Readonly<Record<string, JqObservation>>;
}

export function executeNative(executable: string, fixture: JqCase): JqObservation {
  const result = spawnSync(executable, fixture.args, {
    input: fixture.stdin ?? "",
    env: { ...process.env, NO_COLOR: "1", ...fixture.env },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, fixture.name);
  assert.ok(typeof result.status === "number", fixture.name);
  return { exit: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function nativeVersion(executable: string): string {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function recordOracle(executable: string): JqOracle {
  const cases = Object.fromEntries(
    jqCases.map((fixture) => [fixture.name, executeNative(executable, fixture)]),
  );
  return { schemaVersion: 1, nativeVersion: nativeVersion(executable), cases };
}

if (process.argv[1]?.endsWith("record-jq-oracle.ts")) {
  const executable = process.argv[2] ?? "jq";
  const oracle = recordOracle(executable);
  const destination = resolve(import.meta.dirname, "jq-oracle.json");
  writeFileSync(destination, `${JSON.stringify(oracle, null, 2)}\n`);
  console.log(`Recorded ${jqCases.length} cases from ${oracle.nativeVersion}`);
}

export function readOracle(): JqOracle {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "jq-oracle.json"), "utf8"));
}
