import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { generate } from "../tooling/gpu-stream.ts";
import { CommandCleanupError, runOwned } from "./owned-command.ts";

const packageRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(packageRoot, "../..");
export const GPU_FIXTURE_WASM = "triangle.wasm";
export const GPU_SCENE_FIXTURE_WASM = "scene.wasm";
export const GPU_ASYNC_FIXTURE_WASM = "async.wasm";
const fixtures = [GPU_FIXTURE_WASM, GPU_SCENE_FIXTURE_WASM, GPU_ASYNC_FIXTURE_WASM];
const target = "wasm32-wasip1";
const flags = [
  `--target=${target}`,
  "-std=c11",
  "-O2",
  "-g0",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-Wl,--initial-memory=262144",
  "-Wl,--max-memory=16777216",
  "-Wl,--export-memory",
  "-Wl,--strip-debug",
];
const inputs = [
  "scripts/build-gpu-fixture.ts",
  "scripts/owned-command.ts",
  "tests/fixtures/gpu/triangle.c",
  "tests/fixtures/gpu/scene.c",
  "tests/fixtures/gpu/async.c",
  "tests/fixtures/gpu/async_encode.h",
  "tests/fixtures/gpu/async-expected.json",
  "browser/gpu/upstream/webgpu.h",
  "tests/fixtures/gpu/scene_encode.h",
  "tests/fixtures/gpu/gpu_fixture.h",
  "tests/fixtures/gpu/gpu_encode.h",
  "tests/fixtures/gpu/waffle_gpu_stream.h",
  "tests/fixtures/gpu/expected.json",
  "tests/fixtures/gpu/enums.json",
  "browser/gpu/stream.json",
  "browser/gpu/upstream/webgpu.yml",
  "browser/gpu/upstream/LICENSE",
  "browser/gpu/generated/tables.ts",
  "tooling/gpu-stream.ts",
  "tooling/gpu-stream-layout.ts",
  "tooling/gpu-stream-model.ts",
];
const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function contract(root: string) {
  return {
    target,
    sdkVersion: "34.0",
    flags,
    inputs: inputs.map((path) => ({ path, sha256: digest(readFileSync(join(root, path))) })),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid GPU fixture metadata");
  return Object.fromEntries(Object.entries(value));
}

function compilerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "LIBRARY_PATH", "SDKROOT"])
    delete env[key];
  return env;
}

function run(command: string[]): string {
  const result = Bun.spawnSync(command, {
    cwd: packageRoot,
    env: compilerEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed\n${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function compiler(sdkPath: string | undefined): string {
  if (!sdkPath || !isAbsolute(sdkPath))
    throw new Error("WASI_SDK_PATH must be an absolute path to wasi-sdk 34.0");
  const sdk = realpathSync(sdkPath);
  const version = readFileSync(join(sdk, "VERSION"), "utf8");
  if (!version.startsWith("34.0\n") || !version.includes("wasi-libc: 2e6fb9d8ee0c"))
    throw new Error("WASI_SDK_PATH must contain wasi-sdk 34.0 with its pinned wasi-libc");
  const clang = join(sdk, "bin/clang");
  if (!run([clang, "--version"]).startsWith("clang version 23.1.0-wasi-sdk "))
    throw new Error("Expected the wasi-sdk 34.0 clang 23.1.0 compiler");
  return clang;
}

function outputDirectory(directory: string): string {
  if (!isAbsolute(directory)) throw new Error("GPU_FIXTURE_DIR must be absolute and outside Git");
  mkdirSync(directory, { recursive: true });
  const output = realpathSync(directory);
  const detection = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { cwd: output });
  if (detection.exitCode === 0 && detection.stdout.toString().trim() === "true")
    throw new Error("GPU fixture output must be outside Git");
  return output;
}

function inspectImports(wasm: Uint8Array<ArrayBuffer>, name: string): void {
  const module = new WebAssembly.Module(wasm);
  const imports = WebAssembly.Module.imports(module);
  const expected = [
    "runtime_gpu.append",
    "runtime_gpu.close",
    "runtime_gpu.completions",
    "runtime_gpu.open",
    "runtime_gpu.payload",
  ].concat(
    name === GPU_ASYNC_FIXTURE_WASM
      ? []
      : ["runtime_window.surface_info", "runtime_window.surfaces"],
  );
  const custom = imports
    .filter((entry) => entry.module !== "wasi_snapshot_preview1")
    .map((entry) => `${entry.module}.${entry.name}`);
  custom.sort();
  if (json(custom) !== json(expected) || imports.some((entry) => entry.kind !== "function"))
    throw new Error("GPU fixture imports do not match the blocking Preview 1 contract");
  if (name === GPU_ASYNC_FIXTURE_WASM) {
    const wasi = imports
      .filter((entry) => entry.module === "wasi_snapshot_preview1")
      .map((entry) => entry.name);
    wasi.sort();
    if (
      json(wasi) !==
      json([
        "args_get",
        "args_sizes_get",
        "clock_time_get",
        "fd_close",
        "fd_fdstat_get",
        "fd_read",
        "fd_seek",
        "fd_write",
        "proc_exit",
      ])
    )
      throw new Error("Async fixture WASI imports do not match the pinned C command");
  }
  const exports = WebAssembly.Module.exports(module);
  if (!exports.some((entry) => entry.name === "_start" && entry.kind === "function"))
    throw new Error("GPU fixture has no command entry");
  if (!exports.some((entry) => entry.name === "memory" && entry.kind === "memory"))
    throw new Error("GPU fixture has no exported memory");
}

/** One producer compiles all commands; consumers verify without invoking clang. */
export async function buildGpuFixture(directory: string, signal?: AbortSignal): Promise<string> {
  const clang = compiler(process.env.WASI_SDK_PATH);
  await generate(packageRoot, true);
  const outdir = outputDirectory(directory);
  const scratch = mkdtempSync(join(outdir, ".gpu-build-"));
  let safeToRemove = true;
  try {
    const configuration = contract(packageRoot);
    for (const name of fixtures) {
      const artifact = join(scratch, name);
      await runOwned(
        [clang].concat(flags, [
          `-ffile-prefix-map=${repositoryRoot}=/waffle`,
          join(packageRoot, "tests/fixtures/gpu", name.replace(".wasm", ".c")),
          "-o",
          artifact,
        ]),
        { cwd: packageRoot, env: compilerEnvironment(), signal, timeoutMs: 120_000 },
      );
      const wasm = new Uint8Array(readFileSync(artifact));
      inspectImports(wasm, name);
      writeFileSync(
        join(scratch, name.replace(".wasm", ".inputs.json")),
        json({
          contract: configuration,
          artifact: { size: wasm.length, sha256: digest(wasm) },
        }),
      );
    }
    if (json(configuration) !== json(contract(packageRoot)))
      throw new Error("GPU fixture inputs changed during compilation; rebuild explicitly");
    for (const name of fixtures.concat(
      fixtures.map((name) => name.replace(".wasm", ".inputs.json")),
    ))
      renameSync(join(scratch, name), join(outdir, name));
    return join(outdir, GPU_FIXTURE_WASM);
  } catch (error) {
    if (error instanceof CommandCleanupError) safeToRemove = false;
    throw error;
  } finally {
    if (safeToRemove) rmSync(scratch, { recursive: true, force: true });
  }
}

/** Cache freshness check. Deliberately needs neither an SDK nor a compiler. */
function verifiedFixture(
  directory: string,
  name: string,
  sourceRoot: string,
): Uint8Array<ArrayBuffer> {
  const metadataName = name.replace(".wasm", ".inputs.json");
  const metadata = record(JSON.parse(readFileSync(join(directory, metadataName), "utf8")));
  if (json(metadata.contract) !== json(contract(sourceRoot)))
    throw new Error("GPU fixture inputs changed; rebuild explicitly");
  const artifact = record(metadata.artifact);
  const wasm = new Uint8Array(readFileSync(join(directory, name)));
  if (artifact.size !== wasm.length || artifact.sha256 !== digest(wasm))
    throw new Error("GPU fixture artifact changed; rebuild explicitly");
  inspectImports(wasm, name);
  return wasm;
}

export function verifiedGpuFixture(
  directory: string,
  sourceRoot = packageRoot,
): Uint8Array<ArrayBuffer> {
  return verifiedFixture(directory, GPU_FIXTURE_WASM, sourceRoot);
}
export function verifiedGpuSceneFixture(
  directory: string,
  sourceRoot = packageRoot,
): Uint8Array<ArrayBuffer> {
  return verifiedFixture(directory, GPU_SCENE_FIXTURE_WASM, sourceRoot);
}

export function verifiedGpuAsyncFixture(
  directory: string,
  sourceRoot = packageRoot,
): Uint8Array<ArrayBuffer> {
  return verifiedFixture(directory, GPU_ASYNC_FIXTURE_WASM, sourceRoot);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const verify = args.includes("--verify");
  const positional = args.filter((arg) => arg !== "--verify");
  if (positional.length > 1 || args.some((arg) => arg.startsWith("--") && arg !== "--verify"))
    throw new Error("usage: build-gpu-fixture.ts [absolute-output-directory] [--verify]");
  const directory = positional[0] ?? process.env.GPU_FIXTURE_DIR;
  if (!directory) throw new Error("Pass an output directory or set GPU_FIXTURE_DIR");
  if (verify)
    console.log(
      json({
        verified: true,
        triangle: verifiedGpuFixture(directory).length,
        scene: verifiedGpuSceneFixture(directory).length,
        async: verifiedGpuAsyncFixture(directory).length,
      }),
    );
  else {
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    try {
      console.log(await buildGpuFixture(directory, controller.signal));
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
}
