import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const packageRoot = resolve(import.meta.dir, "..");
const sourcePath = "packages/waffle/tests/fixtures/threads-c.c";
const source = resolve(root, sourcePath);
const target = "wasm32-wasip1-threads";
const sdkVersion = "34.0";
const sdkLibcRevision = "2e6fb9d8ee0c";
const initialPages = 17;
const maximumPages = 16384;
export const C_THREAD_FIXTURE_WASM = "c-threads.wasm";
export const C_THREAD_FIXTURE_RECEIPT = "c-threads.receipt.json";
const compileFlags = ["--target=wasm32-wasip1-threads", "-pthread", "-O2", "-g0"];
const linkFlags = [
  "-Wl,--import-memory",
  "-Wl,--shared-memory",
  `-Wl,--initial-memory=${initialPages * 65536}`,
  `-Wl,--max-memory=${maximumPages * 65536}`,
];

type Hash = string;
type ReceiptInput = Readonly<{ path: string; sha256: Hash }>;
type CompilerFile = Readonly<{ path: string; sha256: Hash }>;

type FixtureReceipt = Readonly<{
  schema: 1;
  contract: Readonly<{
    source: ReceiptInput;
    builder: ReceiptInput;
    target: string;
    sdkVersion: string;
    sdkLibcRevision: string;
    compileFlags: readonly string[];
    linkFlags: readonly string[];
  }>;
  compiler: Readonly<{
    clangVersion: string;
    linkerVersion: string;
    files: readonly CompilerFile[];
    dependencies: readonly CompilerFile[];
  }>;
  artifact: Readonly<{ path: string; size: number; sha256: Hash }>;
  sha256: Hash;
}>;

const digest = (bytes: Uint8Array | string): Hash =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value));
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return Array.from(value, (entry) => stringValue(entry, label));
}

function inputValue(value: unknown, label: string): ReceiptInput {
  const entry = record(value, label);
  return {
    path: stringValue(entry.path, `${label}.path`),
    sha256: stringValue(entry.sha256, `${label}.sha256`),
  };
}

function fileArray(value: unknown, label: string): CompilerFile[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return Array.from(value, (entry) => inputValue(entry, label));
}

function run(command: readonly string[], cwd = packageRoot): string {
  const child = Bun.spawnSync(Array.from(command), {
    cwd,
    env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  if (child.exitCode !== 0)
    throw new Error(`${command.join(" ")} failed\n${child.stderr.toString()}`);
  return child.stdout.toString().trim();
}

function sdkPath(): string {
  const value = process.env.WASI_SDK_PATH;
  if (!value) throw new Error("WASI_SDK_PATH must name wasi-sdk 34.0");
  const path = realpathSync(value);
  if (!statSync(path).isDirectory()) throw new Error("WASI_SDK_PATH must be a directory");
  return path;
}

function sdkVersionText(sdk: string): string {
  const version = readFileSync(join(sdk, "VERSION"), "utf8").trim();
  if (!version.includes(`\n${sdkVersion}\n`) && !version.startsWith(`${sdkVersion}\n`))
    throw new Error(`WASI_SDK_PATH must contain wasi-sdk ${sdkVersion}`);
  if (!version.includes(`wasi-libc: ${sdkLibcRevision}`))
    throw new Error(`WASI_SDK_PATH must contain wasi-libc ${sdkLibcRevision}`);
  return version;
}

function contract(): FixtureReceipt["contract"] {
  return {
    source: { path: sourcePath, sha256: digest(readFileSync(source)) },
    builder: {
      path: "packages/waffle/scripts/build-c-thread-fixture.ts",
      sha256: digest(readFileSync(import.meta.path)),
    },
    target,
    sdkVersion,
    sdkLibcRevision,
    compileFlags,
    linkFlags,
  };
}

function compilerPath(sdk: string, name: string): string {
  const path = join(sdk, "bin", name);
  if (!existsSync(path)) throw new Error(`missing wasi-sdk tool ${name}`);
  return path;
}

function dependencies(path: string): string[] {
  const text = readFileSync(path, "utf8").replaceAll("\\\n", " ");
  const tokens = text.split(/\s+/).filter(Boolean).slice(2);
  return tokens.map((token) => resolve(dirname(path), token));
}

function inventory(sdk: string, paths: readonly string[]): CompilerFile[] {
  const unique = new Set<string>();
  const files: CompilerFile[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const actual = realpathSync(path);
    if (!statSync(actual).isFile() || unique.has(actual)) continue;
    unique.add(actual);
    if (!actual.startsWith(`${sdk}/`)) continue;
    files.push({ path: relative(sdk, actual), sha256: digest(readFileSync(actual)) });
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return files;
}

function compiler(sdk: string, scratch: string): FixtureReceipt["compiler"] {
  const clang = compilerPath(sdk, "clang");
  const linker = compilerPath(sdk, "wasm-ld");
  const version = sdkVersionText(sdk);
  const output = join(scratch, "probe.wasm");
  const depfile = join(scratch, "dependencies.d");
  if (!existsSync(depfile))
    run([clang].concat(compileFlags, ["-MD", "-MF", depfile, "-fsyntax-only", source]));
  const command = [clang].concat(compileFlags, ["-MD", "-MF", depfile], linkFlags, [
    source,
    "-o",
    output,
  ]);
  const trace = Bun.spawnSync(command.concat("-###"), {
    cwd: packageRoot,
    env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
    stderr: "pipe",
    stdout: "pipe",
    timeout: 120_000,
  });
  if (trace.exitCode !== 0)
    throw new Error(`failed to inspect clang command\n${trace.stderr.toString()}`);
  const tracedPaths = Array.from(
    trace.stderr.toString().matchAll(/"([^"]+)"/g),
    (match) => match[1],
  ).filter((path): path is string => path !== undefined);
  const sdkFiles = [join(sdk, "VERSION"), join(sdk, "bin", "clang.cfg"), clang, linker].concat(
    tracedPaths,
  );
  const clangVersion = run([clang, "--version"]);
  const linkerVersion = run([linker, "--version"]);
  const depPaths = dependencies(join(scratch, "dependencies.d"));
  return {
    clangVersion: `${version}\n${clangVersion}`,
    linkerVersion,
    files: inventory(sdk, sdkFiles),
    dependencies: inventory(sdk, depPaths),
  };
}

function ensureExternalOutput(directory: string): string {
  if (!isAbsolute(directory)) throw new Error("C_THREAD_FIXTURE_DIR must be absolute");
  const path = resolve(directory);
  if (existsSync(path)) throw new Error("C_THREAD_FIXTURE_DIR must not already exist");
  mkdirSync(dirname(path), { recursive: true });
  const parent = realpathSync(dirname(path));
  if (!relative(realpathSync(root), parent).startsWith("../"))
    throw new Error("C_THREAD_FIXTURE_DIR must be outside Git");
  const git = Bun.spawnSync(["git", "-C", parent, "rev-parse", "--is-inside-work-tree"]);
  if (git.exitCode === 0 && git.stdout.toString().trim() === "true")
    throw new Error("C_THREAD_FIXTURE_DIR must be outside every Git worktree");
  return path;
}

function existingOutput(directory: string): string {
  const path = resolve(directory);
  if (!isAbsolute(directory) || !existsSync(path) || !statSync(path).isDirectory())
    throw new Error("C_THREAD_FIXTURE_DIR must name an existing artifact directory");
  return path;
}

export function buildCThreadFixtureForTest(directory: string): FixtureReceipt {
  const output = ensureExternalOutput(directory);
  const sdk = sdkPath();
  const staged = mkdtempSync(join(dirname(output), ".c-threads-fixture-"));
  try {
    const depfile = join(staged, "dependencies.d");
    const wasmPath = join(staged, C_THREAD_FIXTURE_WASM);
    const command = [compilerPath(sdk, "clang")].concat(
      compileFlags,
      ["-MD", "-MF", depfile],
      linkFlags,
      [source, "-o", wasmPath],
    );
    run(command);
    const wasm = readFileSync(wasmPath);
    const compilerInfo = compiler(sdk, staged);
    const receiptPayload = {
      schema: 1 as const,
      contract: contract(),
      compiler: compilerInfo,
      artifact: { path: C_THREAD_FIXTURE_WASM, size: wasm.length, sha256: digest(wasm) },
    };
    const receipt: FixtureReceipt = { ...receiptPayload, sha256: digest(json(receiptPayload)) };
    writeFileSync(join(staged, C_THREAD_FIXTURE_RECEIPT), json(receipt));
    rmSync(depfile, { force: true });
    renameSync(staged, output);
    return receipt;
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

function readReceipt(directory: string): FixtureReceipt {
  const value = record(
    JSON.parse(readFileSync(join(directory, C_THREAD_FIXTURE_RECEIPT), "utf8")),
    "C thread fixture receipt",
  );
  const { sha256, ...payload } = value;
  if (value.schema !== 1 || typeof sha256 !== "string" || sha256 !== digest(json(payload)))
    throw new Error("C thread fixture receipt digest does not match");
  const contractValue = record(value.contract, "C thread fixture contract");
  const compilerValue = record(value.compiler, "C thread fixture compiler");
  const artifactValue = record(value.artifact, "C thread fixture artifact");
  const artifactSize = artifactValue.size;
  if (typeof artifactSize !== "number" || !Number.isInteger(artifactSize) || artifactSize < 0)
    throw new Error("invalid C thread fixture artifact size");
  if (artifactValue.path !== C_THREAD_FIXTURE_WASM)
    throw new Error("invalid C thread fixture artifact path");
  return {
    schema: 1,
    contract: {
      source: inputValue(contractValue.source, "C thread fixture contract.source"),
      builder: inputValue(contractValue.builder, "C thread fixture contract.builder"),
      target: stringValue(contractValue.target, "C thread fixture contract.target"),
      sdkVersion: stringValue(contractValue.sdkVersion, "C thread fixture contract.sdkVersion"),
      sdkLibcRevision: stringValue(
        contractValue.sdkLibcRevision,
        "C thread fixture contract.sdkLibcRevision",
      ),
      compileFlags: stringArray(
        contractValue.compileFlags,
        "C thread fixture contract.compileFlags",
      ),
      linkFlags: stringArray(contractValue.linkFlags, "C thread fixture contract.linkFlags"),
    },
    compiler: {
      clangVersion: stringValue(
        compilerValue.clangVersion,
        "C thread fixture compiler.clangVersion",
      ),
      linkerVersion: stringValue(
        compilerValue.linkerVersion,
        "C thread fixture compiler.linkerVersion",
      ),
      files: fileArray(compilerValue.files, "C thread fixture compiler.files"),
      dependencies: fileArray(compilerValue.dependencies, "C thread fixture compiler.dependencies"),
    },
    artifact: {
      path: C_THREAD_FIXTURE_WASM,
      size: artifactSize,
      sha256: stringValue(artifactValue.sha256, "C thread fixture artifact.sha256"),
    },
    sha256,
  };
}

export function verifiedCThreadFixture(directory: string): Uint8Array<ArrayBuffer> {
  const output = existingOutput(directory);
  const receipt = readReceipt(output);
  const expectedContract = contract();
  if (json(receipt.contract) !== json(expectedContract))
    throw new Error("C thread fixture inputs changed; rebuild explicitly");
  const wasm = readFileSync(join(output, C_THREAD_FIXTURE_WASM));
  if (
    receipt.artifact.path !== C_THREAD_FIXTURE_WASM ||
    receipt.artifact.size !== wasm.length ||
    receipt.artifact.sha256 !== digest(wasm)
  )
    throw new Error("C thread fixture output changed or is missing");
  return new Uint8Array(wasm);
}

export function verifyCThreadCompiler(directory: string): void {
  const output = existingOutput(directory);
  const receipt = readReceipt(output);
  const scratch = mkdtempSync(join(dirname(output), ".c-threads-verify-"));
  try {
    const actual = compiler(sdkPath(), scratch);
    if (json(receipt.compiler) !== json(actual))
      throw new Error("C thread fixture compiler inputs changed or are missing");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const directory = process.argv[2];
  const flag = process.argv[3];
  if (!directory)
    throw new Error("usage: build-c-thread-fixture.ts OUTDIR [--verify | --verify-toolchain]");
  if (!flag) console.log(json(buildCThreadFixtureForTest(directory)));
  else if (flag === "--verify")
    console.log(json({ verified: true, size: verifiedCThreadFixture(directory).length }));
  else if (flag === "--verify-toolchain") {
    verifyCThreadCompiler(directory);
    console.log(json({ verifiedToolchain: true }));
  } else throw new Error("usage: build-c-thread-fixture.ts OUTDIR [--verify | --verify-toolchain]");
}
