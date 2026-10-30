import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DiffutilsCase } from "./cases.ts";
import { runCommand } from "./command.ts";

export interface Observation {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Executables {
  readonly diff: string;
  readonly cmp: string;
}

export interface Oracle {
  readonly schemaVersion: 1;
  readonly nativeVersions: Executables;
  readonly cases: Readonly<Record<string, Observation>>;
}

function observation(result: ReturnType<typeof runCommand>, name: string): Observation {
  assert.equal(result.signal, null, name);
  assert.ok(typeof result.status === "number", name);
  return { exit: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function executeNative(
  root: string,
  executables: Executables,
  fixture: DiffutilsCase,
): Observation {
  const result = runCommand({
    name: `native ${fixture.name}`,
    executable: executables[fixture.program],
    args: fixture.args,
    cwd: root,
    input: fixture.stdin ?? "",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  return observation(result, fixture.name);
}

export function executeWasm(root: string, wasmtime: string, fixture: DiffutilsCase): Observation {
  const guest = resolve(import.meta.dirname, `../dist/${fixture.program}.wasm`);
  const args = [
    "run",
    "--env",
    "LC_ALL=C",
    "--env",
    "TZ=UTC",
    "--dir",
    `${root}::/`,
    "--argv0",
    fixture.program,
    guest,
  ].concat(fixture.args);
  const result = runCommand({
    name: `Wasm ${fixture.name}`,
    executable: wasmtime,
    args,
    input: fixture.stdin ?? "",
  });
  return observation(result, fixture.name);
}

export function nativeVersion(executable: string, program: string): string {
  const result = runCommand({
    name: `native ${program} version`,
    executable,
    args: ["--version"],
    env: { ...process.env, LC_ALL: "C" },
  });
  assert.equal(result.status, 0, result.stderr);
  const version = result.stdout.split("\n")[0];
  assert.ok(version?.includes("GNU diffutils) 3.12"), version);
  return version;
}

export function readOracle(): Oracle {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "diffutils-oracle.json"), "utf8"));
}
