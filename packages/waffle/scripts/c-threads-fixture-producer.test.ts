import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  C_THREAD_FIXTURE_RECEIPT,
  C_THREAD_FIXTURE_WASM,
  buildCThreadFixtureForTest,
  verifiedCThreadFixture,
  verifyCThreadCompiler,
} from "./build-c-thread-fixture.ts";
import { inspectCThreadFixture } from "../tests/c-threads-fixture-inspect.ts";

const root = process.env.C_THREADS_FIXTURE_TEST_ROOT;
if (!root) throw new Error("C_THREADS_FIXTURE_TEST_ROOT must name a task-owned scratch directory");
const output = join(root, "artifact");
const second = join(root, "artifact-second");

function build(directory: string): void {
  buildCThreadFixtureForTest(directory);
}

test("the stock SDK builds deterministic C thread bytes and receipt", () => {
  build(output);
  const firstWasm = readFileSync(join(output, C_THREAD_FIXTURE_WASM));
  const firstReceipt = readFileSync(join(output, C_THREAD_FIXTURE_RECEIPT));
  build(second);
  expect(readFileSync(join(second, C_THREAD_FIXTURE_WASM))).toEqual(firstWasm);
  expect(readFileSync(join(second, C_THREAD_FIXTURE_RECEIPT))).toEqual(firstReceipt);
  const inspected = inspectCThreadFixture(new Uint8Array(firstWasm));
  expect(inspected.sharedMemory).toEqual({ minimum: 17, maximum: 16384, shared: true });
  expect(inspected.hasThreadSpawn).toBe(true);
  expect(inspected.hasThreadStart).toBe(true);
  expect(inspected.fixed32MiBImportCompatible).toBe(true);
});

test("receipt and compiler inventory verification reject tampering", () => {
  const receipt = join(output, C_THREAD_FIXTURE_RECEIPT);
  const original = readFileSync(receipt);
  writeFileSync(receipt, Buffer.from(original).toString().replace('"schema": 1', '"schema": 2'));
  expect(() => verifiedCThreadFixture(output)).toThrow("receipt digest does not match");
  writeFileSync(receipt, original);
  verifyCThreadCompiler(output);
  expect(existsSync(join(output, C_THREAD_FIXTURE_WASM))).toBe(true);
});
