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
const metadataName = "triangle.inputs.json";
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

function inspectImports(wasm: Uint8Array<ArrayBuffer>): void {
  const module = new WebAssembly.Module(wasm);
  const imports = WebAssembly.Module.imports(module);
  const expected = [
    "runtime_gpu.append",
    "runtime_gpu.close",
    "runtime_gpu.completions",
    "runtime_gpu.open",
    "runtime_gpu.payload",
    "runtime_window.surface_info",
    "runtime_window.surfaces",
  ];
  const custom = imports
    .filter((entry) => entry.module !== "wasi_snapshot_preview1")
    .map((entry) => `${entry.module}.${entry.name}`);
  custom.sort();
  if (json(custom) !== json(expected) || imports.some((entry) => entry.kind !== "function"))
    throw new Error("GPU fixture imports do not match the blocking Preview 1 contract");
  const exports = WebAssembly.Module.exports(module);
  if (!exports.some((entry) => entry.name === "_start" && entry.kind === "function"))
    throw new Error("GPU fixture has no command entry");
  if (!exports.some((entry) => entry.name === "memory" && entry.kind === "memory"))
    throw new Error("GPU fixture has no exported memory");
}

/** Compile once; the browser caller consumes triangle.wasm without running clang. */
export async function buildGpuFixture(directory: string, signal?: AbortSignal): Promise<string> {
  const clang = compiler(process.env.WASI_SDK_PATH);
  await generate(packageRoot, true);
  const outdir = outputDirectory(directory);
  const scratch = mkdtempSync(join(outdir, ".gpu-build-"));
  let safeToRemove = true;
  try {
    const configuration = contract(packageRoot);
    const artifact = join(scratch, GPU_FIXTURE_WASM);
    await runOwned(
      [clang].concat(flags, [
        `-ffile-prefix-map=${repositoryRoot}=/waffle`,
        join(packageRoot, "tests/fixtures/gpu/triangle.c"),
        "-o",
        artifact,
      ]),
      { cwd: packageRoot, env: compilerEnvironment(), signal, timeoutMs: 120_000 },
    );
    if (json(configuration) !== json(contract(packageRoot)))
      throw new Error("GPU fixture inputs changed during compilation; rebuild explicitly");
    const wasm = new Uint8Array(readFileSync(artifact));
    inspectImports(wasm);
    const metadata = {
      contract: configuration,
      artifact: { size: wasm.length, sha256: digest(wasm) },
    };
    writeFileSync(join(scratch, metadataName), json(metadata));
    renameSync(artifact, join(outdir, GPU_FIXTURE_WASM));
    renameSync(join(scratch, metadataName), join(outdir, metadataName));
    return join(outdir, GPU_FIXTURE_WASM);
  } catch (error) {
    if (error instanceof CommandCleanupError) safeToRemove = false;
    throw error;
  } finally {
    if (safeToRemove) rmSync(scratch, { recursive: true, force: true });
  }
}

/** Cache freshness check. Deliberately needs neither an SDK nor a compiler. */
export function verifiedGpuFixture(
  directory: string,
  sourceRoot = packageRoot,
): Uint8Array<ArrayBuffer> {
  const metadata = record(JSON.parse(readFileSync(join(directory, metadataName), "utf8")));
  if (json(metadata.contract) !== json(contract(sourceRoot)))
    throw new Error("GPU fixture inputs changed; rebuild explicitly");
  const artifact = record(metadata.artifact);
  const wasm = new Uint8Array(readFileSync(join(directory, GPU_FIXTURE_WASM)));
  if (artifact.size !== wasm.length || artifact.sha256 !== digest(wasm))
    throw new Error("GPU fixture artifact changed; rebuild explicitly");
  inspectImports(wasm);
  return wasm;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const verify = args.includes("--verify");
  const positional = args.filter((arg) => arg !== "--verify");
  if (positional.length > 1 || args.some((arg) => arg.startsWith("--") && arg !== "--verify"))
    throw new Error("usage: build-gpu-fixture.ts [absolute-output-directory] [--verify]");
  const directory = positional[0] ?? process.env.GPU_FIXTURE_DIR;
  if (!directory) throw new Error("Pass an output directory or set GPU_FIXTURE_DIR");
  if (verify) console.log(json({ verified: true, size: verifiedGpuFixture(directory).length }));
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
