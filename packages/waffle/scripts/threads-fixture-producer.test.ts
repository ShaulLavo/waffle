import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  THREAD_FIXTURE_RECEIPT,
  THREAD_FIXTURE_WASM,
  verifiedThreadFixture,
} from "./build-thread-fixture.ts";
import { inspectThreadFixture } from "../tests/threads-fixture-inspect.ts";

const root = resolve(import.meta.dir, "../../..");
const source = "packages/waffle/tests/fixtures/threads.rs";
const builder = "packages/waffle/scripts/build-thread-fixture.ts";
let scratch = "",
  project = "",
  outdir = "";

function command(args: string[], directory = outdir) {
  return Bun.spawnSync([process.execPath, join(project, builder)].concat(args), {
    env: { ...process.env, THREAD_FIXTURE_DIR: directory },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
}

function success(args: string[], directory = outdir) {
  const child = command(args, directory);
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
}

beforeAll(() => {
  const directory = process.env.THREAD_FIXTURE_TEST_ROOT;
  if (!directory) throw new Error("THREAD_FIXTURE_TEST_ROOT must name external disposable scratch");
  scratch = mkdtempSync(join(directory, "threads-producer-test-"));
  project = join(scratch, "source");
  outdir = join(scratch, "artifact");
  for (const path of [
    source,
    builder,
    "rust-toolchain.toml",
    "packages/waffle/rust-toolchain.toml",
  ]) {
    const destination = join(project, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, path), destination);
  }
  success([]);
}, 120_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("real stock Rust producer emits deterministic guest and receipt without build leftovers", () => {
  const wasm = readFileSync(join(outdir, THREAD_FIXTURE_WASM));
  const receipt = readFileSync(join(outdir, THREAD_FIXTURE_RECEIPT));
  const second = join(scratch, "second");
  success([], second);
  expect(readFileSync(join(second, THREAD_FIXTURE_WASM))).toEqual(wasm);
  expect(readFileSync(join(second, THREAD_FIXTURE_RECEIPT))).toEqual(receipt);
  expect(readdirSync(outdir).sort()).toEqual([THREAD_FIXTURE_RECEIPT, THREAD_FIXTURE_WASM].sort());
  success(["--verify"]);
  success(["--verify-toolchain"]);
}, 120_000);

test("real module imports signed spawn and shared memory and exports stock command and thread entries", () => {
  const inspected = inspectThreadFixture(
    new Uint8Array(readFileSync(join(outdir, THREAD_FIXTURE_WASM))),
  );
  expect(inspected.imports).toContainEqual({
    kind: "function",
    module: "wasi",
    name: "thread-spawn",
    typeIndex: expect.any(Number),
    parameters: ["i32"],
    results: ["i32"],
  });
  expect(inspected.imports.filter((entry) => entry.kind === "memory")).toHaveLength(1);
  expect(inspected.exports).toContainEqual({
    name: "_start",
    kind: "function",
    index: expect.any(Number),
    parameters: [],
    results: [],
  });
  expect(inspected.exports).toContainEqual({
    name: "wasi_thread_start",
    kind: "function",
    index: expect.any(Number),
    parameters: ["i32", "i32"],
    results: [],
  });
  expect(inspected.start).toMatchObject({ parameters: [], results: [] });
  expect(inspected.data.some((segment) => segment.kind === "passive")).toBe(true);
  expect(inspected.data.every((segment) => segment.kind === "passive")).toBe(true);
  expect(inspected.fixed32MiBImportCompatible).toBe(true);
});

function changedFile(path: string, change: (before: Buffer) => void) {
  const before = readFileSync(path);
  try {
    change(before);
    expect(command(["--verify"]).exitCode).not.toBe(0);
  } finally {
    writeFileSync(path, before);
  }
  success(["--verify"]);
}

test("verification fails closed on changed or missing source, builder, config, receipt and wasm", () => {
  for (const path of [
    source,
    builder,
    "rust-toolchain.toml",
    "packages/waffle/rust-toolchain.toml",
  ]) {
    changedFile(join(project, path), (before) =>
      writeFileSync(join(project, path), Buffer.concat([before, Buffer.from("\n")])),
    );
    changedFile(join(project, path), () => rmSync(join(project, path)));
  }
  const artifact = join(outdir, THREAD_FIXTURE_WASM);
  changedFile(artifact, (before) => writeFileSync(artifact, before.subarray(0, before.length - 1)));
  changedFile(artifact, () => rmSync(artifact));
  const receipt = join(outdir, THREAD_FIXTURE_RECEIPT);
  changedFile(receipt, (before) =>
    writeFileSync(
      receipt,
      before
        .toString()
        .replace('"-Cpanic=abort"', '"-Cpanic=unwind"')
        .replace('"schema": 1', '"schema": 2'),
    ),
  );
  changedFile(receipt, () => rmSync(receipt));
}, 30_000);

test("verification has no compiler dependency and never regenerates missing output", () => {
  const child = Bun.spawnSync([process.execPath, join(project, builder), "--verify"], {
    env: { ...process.env, PATH: "/no-compiler-here", THREAD_FIXTURE_DIR: outdir },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  const missing = join(scratch, "absent");
  expect(command(["--verify"], missing).exitCode).not.toBe(0);
  expect(existsSync(missing)).toBe(false);
  expect(() => verifiedThreadFixture(missing)).toThrow();
});

test("producer rejects output inside its source and does not install a missing compiler", () => {
  expect(command([], project).exitCode).not.toBe(0);
  const child = Bun.spawnSync([process.execPath, join(project, builder)], {
    env: {
      ...process.env,
      THREAD_FIXTURE_DIR: join(scratch, "no-rust"),
      RUSTUP_HOME: join(scratch, "empty-rustup"),
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  expect(child.exitCode).not.toBe(0);
  expect(existsSync(join(scratch, "no-rust", THREAD_FIXTURE_RECEIPT))).toBe(false);
  expect(existsSync(join(scratch, "empty-rustup", "toolchains"))).toBe(false);
});
