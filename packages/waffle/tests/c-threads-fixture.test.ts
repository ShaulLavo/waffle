import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  C_THREAD_FIXTURE_RECEIPT,
  verifiedCThreadFixture,
} from "../scripts/build-c-thread-fixture.ts";
import { inspectCThreadFixture } from "./c-threads-fixture-inspect.ts";

const source = readFileSync(new URL("./fixtures/threads-c.c", import.meta.url), "utf8");

const minimalSharedMemory = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 2, 18, 1, 3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2, 3,
  17, 128, 128, 1,
]);

test("the C guest keeps the pthread and live-address contract in source", () => {
  expect(source).toContain("pthread_create");
  expect(source).toContain("pthread_join");
  expect(source).toContain("_Thread_local");
  expect(source).toContain("atomic_fetch_add_explicit(&progress");
  expect(source).toContain("stack_addresses");
  expect(source).toContain("tls_addresses");
  expect(source).toContain("release_children");
});

test("receipt verification fails closed without a compiler or output", () => {
  const directory = mkdtempSync("/work/tmp/c-threads-receipt-");
  try {
    expect(() => verifiedCThreadFixture(directory)).toThrow();
    expect(readdirSync(directory)).toEqual([]);
    writeFileSync(join(directory, C_THREAD_FIXTURE_RECEIPT), '{"schema":1,"sha256":"tampered"}\n');
    expect(() => verifiedCThreadFixture(directory)).toThrow("receipt digest does not match");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the inspector rejects truncated Wasm and accepts the shared-memory shape", () => {
  expect(inspectCThreadFixture(minimalSharedMemory).sharedMemory).toEqual({
    minimum: 17,
    maximum: 16384,
    shared: true,
  });
  expect(inspectCThreadFixture(minimalSharedMemory).hasThreadSpawn).toBe(false);
  expect(() => inspectCThreadFixture(minimalSharedMemory.slice(0, -1))).toThrow();
});
