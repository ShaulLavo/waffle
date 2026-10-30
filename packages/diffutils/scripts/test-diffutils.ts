import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { diffutilsCases } from "../tests/cases.ts";
import { writeFixtures } from "../tests/fixtures.ts";
import {
  executeNative,
  executeWasm,
  nativeVersion,
  type Executables,
} from "../tests/oracle.ts";

const root = resolve(import.meta.dirname, "..");
assert.ok(existsSync(resolve(root, "dist/diff.wasm")), "Build dist/diff.wasm first");
assert.ok(existsSync(resolve(root, "dist/cmp.wasm")), "Build dist/cmp.wasm first");
const executables: Executables = {
  diff: process.env.GNU_DIFF ?? "diff",
  cmp: process.env.GNU_CMP ?? "cmp",
};
const wasmtime = process.env.WASMTIME ?? "wasmtime";
nativeVersion(executables.diff, "diff");
nativeVersion(executables.cmp, "cmp");
mkdirSync(resolve(root, ".build"), { recursive: true });
const scratch = mkdtempSync(resolve(root, ".build/oracle-"));

try {
  writeFixtures(scratch);
  for (const fixture of diffutilsCases) {
    const expected = executeNative(scratch, executables, fixture);
    assert.equal(expected.exit, fixture.exit, `${fixture.name}: native oracle exit`);
    const actual = executeWasm(scratch, wasmtime, fixture);
    assert.deepEqual(actual, expected, fixture.name);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`GNU diffutils 3.12 and Wasm: ${diffutilsCases.length} same-input cases passed`);
