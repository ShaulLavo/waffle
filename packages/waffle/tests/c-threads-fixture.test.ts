import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  C_THREAD_FIXTURE_RECEIPT,
  cThreadCompilerEnvironment,
  cThreadCompilerInventory,
  cThreadDependencyPaths,
  verifiedCThreadFixture,
} from "../scripts/build-c-thread-fixture.ts";
import { inspectCThreadFixture } from "./c-threads-fixture-inspect.ts";

const scratchRoot =
  process.env.C_THREADS_SCRATCH_ROOT || (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
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
  const directory = mkdtempSync(join(scratchRoot, "c-threads-receipt-"));
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

test("disabled compiler tests discover without a scratch root or SDK", async () => {
  const child = Bun.spawn(
    [
      "bun",
      "test",
      new URL("../scripts/c-threads-fixture-producer.test.ts", import.meta.url).pathname,
    ],
    {
      env: {
        ...process.env,
        C_THREADS_FIXTURE_PRODUCER_TESTS: "0",
        C_THREADS_FIXTURE_TEST_ROOT: "",
        WASI_SDK_PATH: "/missing-stock-sdk",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const errors = await new Response(child.stderr).text();
    await new Response(child.stdout).text();
    expect(await child.exited, errors).toBe(0);
    expect(errors).toContain("0 fail");
  } finally {
    child.kill();
    await child.exited;
  }
});

test("dependency parsing preserves escaped paths and compiler continuations", () => {
  expect(
    cThreadDependencyPaths(
      "fixture.o: include/a\\ b.h \\\n include/hash\\#name.h include/c\\:d.h include/price$$.h\n",
      "/sdk",
    ),
  ).toEqual([
    "/sdk/include/a b.h",
    "/sdk/include/hash#name.h",
    "/sdk/include/c:d.h",
    "/sdk/include/price$.h",
  ]);
});

test("compiler inventory rejects external, symlinked external and missing inputs", () => {
  const directory = mkdtempSync(join(scratchRoot, "c-threads-inputs-"));
  try {
    const sdk = join(directory, "sdk");
    mkdirSync(sdk);
    const internal = join(sdk, "header.h");
    const external = join(directory, "external.h");
    writeFileSync(internal, "stock");
    writeFileSync(external, "external");
    symlinkSync(external, join(sdk, "symlink.h"));
    expect(cThreadCompilerInventory(sdk, [internal, internal])).toHaveLength(1);
    expect(() => cThreadCompilerInventory(sdk, [external])).toThrow("outside wasi-sdk");
    expect(() => cThreadCompilerInventory(sdk, [join(sdk, "symlink.h")])).toThrow(
      "outside wasi-sdk",
    );
    expect(() => cThreadCompilerInventory(sdk, [join(sdk, "missing.h")])).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compiler environment removes external include and library overrides", () => {
  const env = cThreadCompilerEnvironment({
    CPATH: "/external",
    C_INCLUDE_PATH: "/external",
    LIBRARY_PATH: "/external",
    PATH: "/tools",
    UNRECOGNIZED_COMPILER_OVERRIDE: "/external",
  });
  expect(env.CPATH).toBeUndefined();
  expect(env.C_INCLUDE_PATH).toBeUndefined();
  expect(env.LIBRARY_PATH).toBeUndefined();
  expect(env.PATH).toBe("/tools");
  expect(env.UNRECOGNIZED_COMPILER_OVERRIDE).toBeUndefined();
});
