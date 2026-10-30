import assert from "node:assert/strict";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const programOptimizer = {
  version: "wasm-opt version 133 (version_133)",
  linuxX64Sha256: "8f25e9fd5db0fc5f210003aaa432922feb2e52d309e430def2f929e34da9466b",
  archiveSha256: "2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489",
  archive: "binaryen-version_133-x86_64-linux.tar.gz",
} as const;

export const programOptimizationPolicy = "waffle-program-size-v2";
export const programOptimizationEnvironment = {
  BINARYEN_CORES: "1",
  LC_ALL: "C",
  TZ: "UTC",
} as const;

export const programOptimizationFlags = [
  "--mvp-features",
  "--enable-sign-ext",
  "--enable-mutable-globals",
  "--enable-nontrapping-float-to-int",
  "--enable-bulk-memory",
  "--enable-reference-types",
  "--enable-multivalue",
  "--enable-extended-const",
  "--enable-exception-handling",
  "--skip-pass=remove-unused-module-elements",
  "--no-inline=__wasi_fd_*",
  "--no-inline=__wasilibc_populate_preopens",
  "--strip-dwarf",
  "-Oz",
  "-g",
] as const;

export const programReleaseEnvironment = {
  CARGO_PROFILE_RELEASE_OPT_LEVEL: "z",
  CARGO_PROFILE_RELEASE_LTO: "fat",
  CARGO_PROFILE_RELEASE_PANIC: "abort",
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
  CARGO_PROFILE_RELEASE_DEBUG: "0",
  CARGO_PROFILE_RELEASE_STRIP: "debuginfo",
} as const;

export const programCOptimizationFlags = ["-Oz", "-flto"] as const;

export const programOptimizationCoverage = {
  coreutils: "wasm",
  findutils: "wasm",
  grep: "wasm",
  sed: "wasm",
  ripgrep: "wasm",
  python: "wasm",
  git: "already-minified-javascript",
  base: "aggregate-without-binary",
} as const;

export interface ProgramOptimization {
  readonly source: string;
  readonly destination: string;
  readonly verify: (optimizedPath: string) => void;
  readonly producerReceipt?: string;
}

export interface OptimizerOptions {
  readonly executable?: string;
  readonly execute?: (
    executable: string,
    args: readonly string[],
    options: ExecFileSyncOptions,
  ) => string | Buffer;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const identity = (bytes: Uint8Array) => ({ bytes: bytes.byteLength, sha256: sha256(bytes) });

class Reader {
  offset = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  integer() {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.bytes[this.offset++];
      assert.ok(byte !== undefined, "Truncated Wasm integer");
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
      assert.ok(shift < 35, "Oversized Wasm integer");
    }
  }
  take(length: number) {
    const start = this.offset;
    this.offset += length;
    assert.ok(this.offset <= this.bytes.length, "Truncated Wasm section");
    return this.bytes.subarray(start, this.offset);
  }
}

function sections(bytes: Uint8Array) {
  const reader = new Reader(bytes);
  assert.deepEqual(Array.from(reader.take(8)), [0, 97, 115, 109, 1, 0, 0, 0]);
  const result: { kind: number; name: string; bytes: Uint8Array; raw: Uint8Array }[] = [];
  while (reader.offset < bytes.length) {
    const start = reader.offset;
    const kind = reader.take(1)[0];
    assert.ok(kind !== undefined);
    const payload = reader.take(reader.integer());
    const custom = new Reader(payload);
    const name = kind === 0 ? new TextDecoder().decode(custom.take(custom.integer())) : "";
    result.push({ kind, name, bytes: payload, raw: bytes.subarray(start, reader.offset) });
  }
  return result;
}

const supportedFeatures = new Set([
  "mutable-globals",
  "nontrapping-fptoint",
  "bulk-memory",
  "sign-ext",
  "reference-types",
  "multivalue",
  "extended-const",
  "exception-handling",
  "bulk-memory-opt",
  "call-indirect-overlong",
]);

function targetFeatures(metadata: ReturnType<typeof sections>) {
  const result = new Map<string, number>();
  for (const section of metadata.filter((entry) => entry.name === "target_features")) {
    const reader = new Reader(section.bytes);
    reader.take(reader.integer());
    const count = reader.integer();
    for (let index = 0; index < count; index++) {
      const prefix = reader.take(1)[0];
      assert.ok(prefix === 0x2b || prefix === 0x2d, "Invalid target feature prefix");
      const name = new TextDecoder("utf-8", { fatal: true }).decode(reader.take(reader.integer()));
      assert.ok(supportedFeatures.has(name), `Unsupported program target feature: ${name}`);
      assert.ok(!result.has(name), `Duplicate target feature: ${name}`);
      result.set(name, prefix);
    }
    assert.equal(reader.offset, reader.bytes.length, "Trailing target feature bytes");
  }
  return result;
}

function integer(value: number) {
  const bytes: number[] = [];
  do {
    const part = value & 127;
    value >>>= 7;
    bytes.push(part | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

function retainTargetFeatures(before: ReturnType<typeof inspectInput>, output: Uint8Array) {
  const metadata = sections(output);
  const features = targetFeatures(metadata);
  for (const [name, prefix] of targetFeatures(before.metadata)) {
    const current = features.get(name);
    assert.ok(
      current === undefined || current === prefix,
      `Optimizer changed target feature: ${name}`,
    );
    features.set(name, prefix);
  }
  const text = (value: string) =>
    Buffer.concat([integer(Buffer.byteLength(value)), Buffer.from(value)]);
  const entries = Array.from(features, ([name, prefix]) =>
    Buffer.concat([Buffer.from([prefix]), text(name)]),
  );
  const payload = Buffer.concat([text("target_features"), integer(features.size)].concat(entries));
  const section = Buffer.concat([Buffer.from([0]), integer(payload.length), payload]);
  const retained = metadata
    .filter((entry) => entry.name !== "target_features")
    .map((entry) => entry.raw);
  const header: Uint8Array[] = [output.subarray(0, 8)];
  return Buffer.concat(header.concat(retained, [section]));
}

function inspectInput(bytes: Uint8Array<ArrayBuffer>) {
  const module = new WebAssembly.Module(bytes);
  const metadata = sections(bytes);
  const relocatable = metadata.find(
    (section) => section.name === "linking" || section.name.startsWith("reloc."),
  );
  assert.ok(!relocatable, "Relocatable objects must be linked before program optimization");
  targetFeatures(metadata);
  return { module, metadata };
}

function verifyStructure(before: ReturnType<typeof inspectInput>, bytes: Uint8Array<ArrayBuffer>) {
  const after = inspectInput(bytes);
  assert.deepEqual(
    WebAssembly.Module.imports(after.module),
    WebAssembly.Module.imports(before.module),
    "Optimizer changed program imports",
  );
  assert.deepEqual(
    WebAssembly.Module.exports(after.module),
    WebAssembly.Module.exports(before.module),
    "Optimizer changed program exports",
  );
  const memory = (input: typeof before) =>
    input.metadata.filter((section) => section.kind === 5).map((section) => section.bytes);
  assert.deepEqual(memory(after), memory(before), "Optimizer changed program memory limits");
  const dynamic = (input: typeof before) =>
    input.metadata
      .filter((section) => section.name === "dylink" || section.name === "dylink.0")
      .map((section) => ({ name: section.name, bytes: section.bytes }));
  assert.deepEqual(dynamic(after), dynamic(before), "Optimizer changed dynamic linking metadata");
  return after;
}

function tool(options: OptimizerOptions) {
  assert.equal(process.platform, "linux", "Pinned optimizer currently requires Linux x64");
  assert.equal(process.arch, "x64", "Pinned optimizer currently requires Linux x64");
  const executable = realpathSync(
    resolve(
      options.executable ??
        process.env.WASM_OPT ??
        fileURLToPath(new URL("../.build/binaryen-version_133/bin/wasm-opt", import.meta.url)),
    ),
  );
  assert.equal(
    sha256(readFileSync(executable)),
    programOptimizer.linuxX64Sha256,
    "Unpinned wasm-opt executable",
  );
  const execute = options.execute ?? execFileSync;
  const env = programOptimizationEnvironment;
  const version = execute(executable, ["--version"], { env, encoding: "utf8" }).toString().trim();
  assert.equal(version, programOptimizer.version, "Unexpected wasm-opt version");
  return { executable, execute, env };
}

export function assertSeparateSource(source: string, destination: string) {
  assert.notEqual(source, destination, "Compiler input and staged output must differ");
  let target;
  try {
    target = lstatSync(destination);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  assert.ok(
    target.isFile() && !target.isSymbolicLink(),
    "Staged destination must be a regular file",
  );
  const input = statSync(source);
  assert.ok(
    input.dev !== target.dev || input.ino !== target.ino,
    "Staged destination aliases compiler input",
  );
}

export function optimizeProgram(program: ProgramOptimization, options: OptimizerOptions = {}) {
  const source = realpathSync(program.source);
  const destination = resolve(program.destination);
  assertSeparateSource(source, destination);
  const input = readFileSync(source);
  const before = inspectInput(input);
  const optimizer = tool(options);
  const producerReceipt =
    program.producerReceipt === undefined ? null : identity(readFileSync(program.producerReceipt));
  const scratch = mkdtempSync(resolve(dirname(destination), ".program-optimize-"));
  try {
    const stagedInput = resolve(scratch, "input.wasm");
    const optimized = resolve(scratch, "optimized.wasm");
    writeFileSync(stagedInput, input, { flag: "wx" });
    optimizer.execute(
      optimizer.executable,
      [stagedInput].concat(programOptimizationFlags, ["-o", optimized]),
      { env: optimizer.env, stdio: "pipe", timeout: 120_000 },
    );
    const output = retainTargetFeatures(before, readFileSync(optimized));
    writeFileSync(optimized, output);
    const after = verifyStructure(before, output);
    program.verify(optimized);
    assert.equal(
      sha256(readFileSync(optimized)),
      sha256(output),
      "Verifier changed optimizer output",
    );
    assert.equal(
      sha256(readFileSync(source)),
      sha256(input),
      "Compiler input changed during optimization",
    );
    const derivation = {
      format: 1,
      stage: "wasm-opt-before-name-strip",
      optimizer: {
        policy: programOptimizationPolicy,
        version: programOptimizer.version,
        sha256: programOptimizer.linuxX64Sha256,
        flags: Array.from(programOptimizationFlags),
        environment: optimizer.env,
      },
      input: identity(input),
      output: identity(output),
      producerReceipt,
      customSections: after.metadata
        .filter((section) => section.kind === 0)
        .map((section) => ({ name: section.name, ...identity(section.bytes) })),
    };
    renameSync(optimized, destination);
    return derivation;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
