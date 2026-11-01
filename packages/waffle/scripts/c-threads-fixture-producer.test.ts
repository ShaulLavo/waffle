import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  C_THREAD_FIXTURE_RECEIPT,
  C_THREAD_FIXTURE_WASM,
  buildCThreadFixtureForTest,
  verifiedCThreadFixture,
  verifyCThreadCompiler,
} from "./build-c-thread-fixture.ts";
import { inspectCThreadFixture } from "../tests/c-threads-fixture-inspect.ts";

// Run explicitly with C_THREADS_FIXTURE_PRODUCER_TESTS=1, WASI_SDK_PATH and a private scratch root.
describe.skipIf(process.env.C_THREADS_FIXTURE_PRODUCER_TESTS !== "1")("stock C producer", () => {
  let output: string;
  let second: string;
  let native: string;
  let admitted = false;
  beforeAll(() => {
    const root = process.env.C_THREADS_FIXTURE_TEST_ROOT;
    if (!root) throw new Error("C_THREADS_FIXTURE_TEST_ROOT must name task-owned scratch");
    if (!process.env.WASI_SDK_PATH) throw new Error("WASI_SDK_PATH must name the stock SDK");
    output = join(root, "artifact");
    second = join(root, "artifact-second");
    native = join(root, "native-threads");
    for (const path of [output, second, native])
      if (existsSync(path)) throw new Error(`test output already exists: ${path}`);
    admitted = true;
  });
  afterAll(() => {
    if (!admitted) return;
    for (const path of [output, second, native])
      if (path) rmSync(path, { recursive: true, force: true });
  });

  test("the stock SDK builds deterministic C thread bytes and receipt", () => {
    buildCThreadFixtureForTest(output);
    const firstWasm = readFileSync(join(output, C_THREAD_FIXTURE_WASM));
    const firstReceipt = readFileSync(join(output, C_THREAD_FIXTURE_RECEIPT));
    buildCThreadFixtureForTest(second);
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
    try {
      writeFileSync(receipt, original.toString().replace('"schema": 1', '"schema": 2'));
      expect(() => verifiedCThreadFixture(output)).toThrow("receipt digest does not match");
    } finally {
      writeFileSync(receipt, original);
    }
    verifyCThreadCompiler(output);
    expect(existsSync(join(output, C_THREAD_FIXTURE_WASM))).toBe(true);
  });

  test.skipIf(!process.env.C_THREADS_FIXTURE_HOST_CC)(
    "all fixture assertions run on native pthreads",
    () => {
      const cc = process.env.C_THREADS_FIXTURE_HOST_CC;
      if (!cc) throw new Error("explicit host compiler required");
      const source = new URL("../tests/fixtures/threads-c.c", import.meta.url).pathname;
      const built = Bun.spawnSync([cc, "-pthread", "-O2", source, "-o", native], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30000,
      });
      expect(built.exitCode, built.stderr.toString()).toBe(0);
      for (const mode of ["pair", "repeat", "nested"]) {
        const ran = Bun.spawnSync([native, mode], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10000,
        });
        expect(ran.exitCode, ran.stderr.toString()).toBe(0);
        expect(ran.stdout.toString()).toBe("c-threads-ok\n");
      }
    },
  );
});
