// Extracted from bash-web 9ef027d7's wasi-build.ts and verify-wasi-guests.ts.
// Family recipes own their sources, patches, packaging and notices.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { assertSeparateSource, optimizeProgram } from "./program-optimize.ts";
import {
  programBytesIdentity,
  transformationProvenance,
  validateProgramDerivation,
} from "./program-derivation.ts";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  gunzipSync,
  gzipSync,
} from "node:zlib";

type Environment = NodeJS.ProcessEnv;
const helper = fileURLToPath(import.meta.url);
export const wasiTarget = "wasm32-wasip1";

export interface WasiBuildRecipe {
  /** Shared workspace root, used for the common sysroot cache and build subprocess. */
  readonly root: string;
  /** Waffle source package containing the pinned libc builder and scanner patch. */
  readonly waffle: string;
  readonly env?: Environment;
}

export interface WasiGuestVerification {
  readonly sdk?: string;
  /** Rust module prefix, for example `waffle_program_support::runtime::wasi`. */
  readonly filesystemAdapter?: string;
}

function recipeEnvironment(recipe: WasiBuildRecipe): Environment {
  return recipe.env ?? process.env;
}

export function wasiBuildConfiguration(recipe: WasiBuildRecipe) {
  const root = resolve(recipe.root);
  const waffle = resolve(recipe.waffle);
  const env = recipeEnvironment(recipe);
  const sdk = resolve(env.WASI_SDK_PATH ?? "/work/cache/wasi-sdk-34.0-x86_64-linux");
  const version = readFileSync(resolve(sdk, "VERSION"), "utf8");
  if (!version.split("\n").includes("34.0") || !version.includes("wasi-libc: 2e6fb9d8ee0c\n")) {
    throw new Error("WASI_SDK_PATH must name wasi-sdk 34.0 with wasi-libc 2e6fb9d8ee0c");
  }
  const builder = resolve(waffle, "scripts/build-wasi-libc.sh");
  const patch = resolve(waffle, "patches/wasi-libc/preopen-scan.patch");
  const identity = createHash("sha256")
    .update(sdk)
    .update(version)
    .update(readFileSync(builder))
    .update(readFileSync(patch))
    .digest("hex");
  const directory = resolve(root, ".build/wasi-libc", identity);
  const sysroot = resolve(directory, "sysroot");
  const linker = resolve(sdk, "bin/clang");
  const rustflags = [
    "-C",
    "link-self-contained=no",
    "-C",
    "linker-flavor=gcc",
    "-C",
    `linker=${linker}`,
    "-C",
    `link-arg=--target=${wasiTarget}`,
    "-C",
    `link-arg=--sysroot=${sysroot}`,
    "-C",
    "link-arg=-Wl,--max-memory=268435456",
  ];
  return { sdk, builder, directory, sysroot, linker, rustflags, identity };
}

function prepareSysroot(recipe: WasiBuildRecipe) {
  const root = resolve(recipe.root);
  const env = recipeEnvironment(recipe);
  const config = wasiBuildConfiguration(recipe);
  const receipt = resolve(config.directory, "recipe.sha256");
  if (existsSync(receipt)) {
    if (
      readFileSync(receipt, "utf8") !== config.identity ||
      !existsSync(resolve(config.sysroot, "lib", wasiTarget, "libc.a"))
    ) {
      throw new Error(`Incomplete patched libc cache: ${config.directory}`);
    }
    return;
  }
  // An output without our success receipt is never silently accepted or deleted.
  if (existsSync(config.sysroot))
    throw new Error(`Unverified patched libc output: ${config.sysroot}`);
  mkdirSync(config.directory, { recursive: true });
  execFileSync("bash", [config.builder, config.sysroot], {
    cwd: root,
    env: { ...env, WASI_SDK_PATH: config.sdk },
    stdio: "inherit",
  });
  if (!existsSync(resolve(config.sysroot, "lib", wasiTarget, "libc.a"))) {
    throw new Error(`Waffle did not produce a WASI libc archive: ${config.sysroot}`);
  }
  writeFileSync(receipt, config.identity);
}

export function wasiSysrootCommand(recipe: WasiBuildRecipe): [string, string[]] {
  const root = resolve(recipe.root);
  const cache = resolve(root, ".build/wasi-libc");
  mkdirSync(cache, { recursive: true });
  // Waffle requires a fresh output. flock serializes independent Cargo callers too;
  // the kernel releases ownership on interruption, without stale lock recovery.
  return [
    "flock",
    [
      resolve(cache, "build.lock"),
      process.execPath,
      helper,
      "--prepare",
      root,
      resolve(recipe.waffle),
    ],
  ];
}

export function wasiBuildEnvironment(
  recipe: WasiBuildRecipe,
  targetDirectory: string,
): Environment {
  const [command, args] = wasiSysrootCommand(recipe);
  execFileSync(command, args, {
    cwd: resolve(recipe.root),
    env: recipeEnvironment(recipe),
    stdio: "inherit",
  });
  return wasiCargoEnvironment(recipe, targetDirectory);
}

// Split from preparation so an async process-group supervisor owns the libc build
// as well as Cargo, including cancellation before Cargo starts.
export function wasiCargoEnvironment(
  recipe: WasiBuildRecipe,
  targetDirectory: string,
): Environment {
  const env = recipeEnvironment(recipe);
  const config = wasiBuildConfiguration(recipe);
  const result: Environment = {
    ...env,
    WASI_SDK_PATH: config.sdk,
    CARGO_TARGET_DIR: resolve(recipe.root, targetDirectory),
    CARGO_TARGET_WASM32_WASIP1_LINKER: config.linker,
    // This takes precedence over RUSTFLAGS and target config. Both native and
    // archived-source callers must receive exactly the same final link recipe.
    CARGO_ENCODED_RUSTFLAGS: config.rustflags.join("\x1f"),
    CC_wasm32_wasip1: config.linker,
    CFLAGS_wasm32_wasip1: `--target=${wasiTarget} --sysroot=${config.sysroot}`,
  };
  delete result.RUSTFLAGS;
  delete result.CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS;
  return result;
}

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
      assert.ok(byte !== undefined, "truncated Wasm integer");
      value += (byte & 127) * 2 ** shift;
      assert.ok(value <= 0xffff_ffff, "oversized Wasm integer");
      if (!(byte & 128)) return value;
      shift += 7;
      assert.ok(shift < 35, "oversized Wasm integer");
    }
  }
  slice(length: number) {
    const start = this.offset;
    this.offset += length;
    assert.ok(this.offset <= this.bytes.length, "truncated Wasm section");
    return this.bytes.subarray(start, this.offset);
  }
}

const customSectionDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Remove only complete `name` custom sections, retaining every other encoded byte. */
export function stripWasmNames(bytes: Uint8Array): Uint8Array {
  const reader = new Reader(bytes);
  const header = reader.slice(8);
  assert.ok(
    Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0).every((byte, index) => header[index] === byte),
    "expected a Wasm module header",
  );
  const retained = [bytes.subarray(0, 8)];
  let removed = false;
  while (reader.offset < bytes.length) {
    const start = reader.offset;
    const kind = reader.slice(1)[0];
    const section = new Reader(reader.slice(reader.integer()));
    const name = kind === 0 ? section.slice(section.integer()) : undefined;
    if (name && customSectionDecoder.decode(name) === "name") {
      removed = true;
      continue;
    }
    retained.push(bytes.subarray(start, reader.offset));
  }
  return removed ? Buffer.concat(retained) : bytes;
}

export function stageProgram(
  source: string,
  destination: string | readonly string[],
  verification: WasiGuestVerification = {},
  producerReceipt?: string,
) {
  const destinations = typeof destination === "string" ? [destination] : destination;
  for (const path of destinations) assertSeparateSource(realpathSync(source), resolve(path));
  const first = destinations[0];
  assert.ok(first, "Missing program staging destination");
  const scratch = mkdtempSync(resolve(dirname(first), ".program-stage-"));
  try {
    const candidate = resolve(scratch, "named.wasm");
    const optimization = optimizeProgram({
      source,
      destination: candidate,
      producerReceipt,
      verify: (path) => verifyWasiGuest(path, verification),
    });
    const bytes = stripWasmNames(readFileSync(candidate));
    const output = programBytesIdentity(bytes);
    const receipt = {
      operation: "optimize-and-strip-program",
      transformer: transformationProvenance(),
      ...(producerReceipt === undefined
        ? {}
        : { producerReceiptSha256: programBytesIdentity(readFileSync(producerReceipt)).sha256 }),
      input: optimization.input,
      operations: [
        optimization,
        { operation: "strip-wasm-name-sections", input: optimization.output, output },
      ],
      output,
    };
    validateProgramDerivation(
      receipt,
      bytes,
      producerReceipt === undefined ? undefined : readFileSync(producerReceipt),
    );
    const outputs = compressedProgramOutputs(bytes);
    for (const path of destinations) publishProgram(path, outputs, receipt);
    return receipt;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function compressedProgramOutputs(bytes: Uint8Array) {
  const gzip = gzipSync(bytes, { level: 9 });
  const brotli = brotliCompressSync(bytes, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  });
  assert.ok(gunzipSync(gzip).equals(bytes), "Gzip program readback differs from final bytes");
  assert.ok(
    brotliDecompressSync(brotli).equals(bytes),
    "Brotli program readback differs from final bytes",
  );
  return { bytes, gzip, brotli };
}

function publishProgram(
  destination: string,
  outputs: ReturnType<typeof compressedProgramOutputs>,
  receipt: unknown,
) {
  const scratch = mkdtempSync(resolve(dirname(destination), ".program-publish-"));
  try {
    const binary = resolve(scratch, "program.wasm");
    const gzip = resolve(scratch, "program.wasm.gz");
    const brotli = resolve(scratch, "program.wasm.br");
    const metadata = resolve(scratch, "program.json");
    writeFileSync(binary, outputs.bytes);
    writeFileSync(gzip, outputs.gzip);
    writeFileSync(brotli, outputs.brotli);
    writeFileSync(metadata, JSON.stringify(receipt, null, 2) + "\n");
    renameSync(
      metadata,
      resolve(dirname(destination), `${basename(destination, ".wasm")}-program.json`),
    );
    renameSync(gzip, `${destination}.gz`);
    renameSync(brotli, `${destination}.br`);
    renameSync(binary, destination);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function readFunctionNameSubsection(data: Reader, names: Map<string, number>) {
  const count = data.integer();
  for (let index = 0; index < count; index++) {
    const functionIndex = data.integer();
    names.set(new TextDecoder().decode(data.slice(data.integer())), functionIndex);
  }
}

function readNameSection(section: ArrayBuffer, names: Map<string, number>) {
  const reader = new Reader(new Uint8Array(section));
  while (reader.offset < reader.bytes.length) {
    const kind = reader.integer();
    const data = new Reader(reader.slice(reader.integer()));
    if (kind !== 1) continue;
    readFunctionNameSubsection(data, names);
  }
}

function functionNames(module: WebAssembly.Module) {
  const names = new Map<string, number>();
  for (const section of WebAssembly.Module.customSections(module, "name")) {
    readNameSection(section, names);
  }
  return names;
}

// Inspect final guest code, not just imports or compiler command lines. The stock
// scanner imports fdstat too, but never calls it from preopen discovery.
function verifyPatchedScanner(path: string, sdk: string, names: Map<string, number>) {
  const scanner = "__wasilibc_populate_preopens";
  const disassembly = execFileSync(
    resolve(sdk, "bin/llvm-objdump"),
    [`--disassemble-symbols=${scanner}`, path],
    { encoding: "utf8" },
  );
  for (const syscall of ["__wasi_fd_prestat_get", "__wasi_fd_fdstat_get"]) {
    const index = names.get(syscall);
    assert.notEqual(index, undefined, `${path}: missing ${syscall}`);
    assert.match(
      disassembly,
      new RegExp(`\\bcall\\s+${index}(?:\\s|$)`),
      `${path}: libc scanner does not call ${syscall}; stock libc may have been linked`,
    );
  }
}

function verifyMissingScanner(
  path: string,
  module: WebAssembly.Module,
  names: Map<string, number>,
  filesystemAdapter?: string,
) {
  // Deadstripping is permitted only when path/prestat imports are absent or
  // provably belong to the explicitly named adapter, never to hidden stock libc.
  const functions = WebAssembly.Module.imports(module).filter((entry) => entry.kind === "function");
  for (let index = 0; index < functions.length; index++) {
    const entry = functions[index];
    assert.ok(entry !== undefined, "truncated Wasm import index");
    if (entry.module !== "wasi_snapshot_preview1" || !/^(fd_prestat_|path_)/.test(entry.name))
      continue;
    const symbol = filesystemAdapter ? `${filesystemAdapter}::${entry.name}` : undefined;
    assert.equal(
      symbol ? names.get(symbol) : undefined,
      index,
      `${path}: filesystem imports remain but libc scanner is missing`,
    );
  }
}

function verifyCappedMemory(path: string, bytes: Uint8Array) {
  const reader = new Reader(bytes);
  reader.slice(8); // Magic/version were already validated by WebAssembly.Module.
  let cappedMemory = false;
  while (reader.offset < bytes.length) {
    const kind = reader.integer();
    const section = new Reader(reader.slice(reader.integer()));
    if (kind !== 5) continue;
    assert.equal(section.integer(), 1, `${path}: expected one guest memory`);
    const flags = section.integer();
    assert.equal(flags, 1, `${path}: guest memory must declare an unshared maximum`);
    section.integer(); // Minimum pages.
    assert.equal(section.integer(), 4096, `${path}: guest memory cap changed`);
    cappedMemory = true;
  }
  assert.ok(cappedMemory, `${path}: no capped guest memory found`);
}

export function verifyWasiGuest(path: string, options: WasiGuestVerification = {}) {
  const sdk = options.sdk ?? process.env.WASI_SDK_PATH ?? "/work/cache/wasi-sdk-34.0-x86_64-linux";
  const bytes = readFileSync(path);
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  // Guests own their only memory. The defined-memory section below cannot
  // account for additional host-provided memories, even when it is capped.
  assert.ok(
    !imports.some((entry) => entry.kind === "memory"),
    `${path}: guest memory must not be imported`,
  );
  const names = functionNames(module);
  const hasScanner = names.has("__wasilibc_populate_preopens");
  if (hasScanner) verifyPatchedScanner(path, sdk, names);
  else verifyMissingScanner(path, module, names, options.filesystemAdapter);
  verifyCappedMemory(path, bytes);
  process.stdout.write(
    `Verified ${hasScanner ? "patched preopen scanner" : "no retained libc filesystem code"} and 256 MiB cap: ${path}\n`,
  );
}

function cli(args: string[]) {
  if (args[0] === "--prepare") {
    const root = args[1];
    const waffle = args[2];
    if (args.length !== 3 || root === undefined || waffle === undefined) {
      throw new Error("Internal sysroot builder arguments missing");
    }
    prepareSysroot({ root, waffle });
    return;
  }
  assert.ok(args.length > 0, "Pass final Wasm guest paths to inspect");
  const adapter = process.env.WASI_FILESYSTEM_ADAPTER;
  const options = adapter ? { filesystemAdapter: adapter } : {};
  for (const path of args) verifyWasiGuest(resolve(path), options);
}

if (process.argv[1] && resolve(process.argv[1]) === helper) cli(process.argv.slice(2));
