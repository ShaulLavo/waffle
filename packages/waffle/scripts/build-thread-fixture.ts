import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const packageRoot = resolve(import.meta.dir, "..");
export const THREAD_FIXTURE_WASM = "threads.wasm";
export const THREAD_FIXTURE_RECEIPT = "threads.receipt.json";
const source = "packages/waffle/tests/fixtures/threads.rs";
const target = "wasm32-wasip1-threads";
const toolchain = "1.98.1";
const flags = [
  "--edition=2021",
  "--crate-name=waffle_threads",
  "--crate-type=bin",
  `--target=${target}`,
  "-Copt-level=2",
  "-Cdebuginfo=0",
  "-Cstrip=debuginfo",
  "-Ccodegen-units=1",
  "-Cpanic=abort",
  "-Clink-self-contained=yes",
];
const inputs = [
  source,
  "rust-toolchain.toml",
  "packages/waffle/rust-toolchain.toml",
  "packages/waffle/scripts/build-thread-fixture.ts",
];

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

function run(args: string[]): string {
  const child = Bun.spawnSync(args, {
    cwd: packageRoot,
    env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(`${args.join(" ")} failed\n${child.stderr.toString()}`);
  return child.stdout.toString().trim();
}

function contract() {
  for (const name of inputs.filter((name) => name.endsWith("rust-toolchain.toml"))) {
    const pin = record(Bun.TOML.parse(readFileSync(join(root, name), "utf8")));
    if (record(pin.toolchain).channel !== toolchain)
      throw new Error(`${name} must pin ${toolchain}`);
  }
  return {
    target,
    toolchain,
    flags,
    remap: "$WORKTREE=/waffle-thread-fixture",
    inputs: inputs.map((path) => ({ path, sha256: digest(readFileSync(join(root, path))) })),
  };
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function compilerInputs() {
  const rustc = run(["rustup", "which", "--toolchain", toolchain, "rustc"]);
  const version = run([rustc, "-Vv"]);
  if (!version.startsWith(`rustc ${toolchain} `)) throw new Error("unexpected rustc version");
  const sysroot = run([rustc, "--print", "sysroot"]);
  const libdir = run([rustc, "--print", "target-libdir", "--target", target]);
  if (!existsSync(libdir))
    throw new Error(`install ${target} for ${toolchain} in a task-owned toolchain before building`);
  const host = version.match(/^host: (.+)$/m)?.[1];
  if (!host) throw new Error("rustc did not identify its host");
  const linker = join(sysroot, "lib/rustlib", host, "bin/rust-lld");
  const libraries = readdirSync(join(sysroot, "lib"), { withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(sysroot, "lib", entry.name));
  const paths = [rustc, linker].concat(libraries, files(libdir));
  const inventory = paths.map((path) => ({
    path: relative(sysroot, path),
    sha256: digest(readFileSync(path)),
  }));
  inventory.sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (!inventory.some((file) => file.path.endsWith("/self-contained/crt1-command.o")))
    throw new Error("missing bundled command CRT for threaded target");
  return { rustc, version, inventory };
}

function outputDirectory(directory: string): string {
  if (!isAbsolute(directory))
    throw new Error("THREAD_FIXTURE_DIR must be absolute and outside Git");
  const path = resolve(directory);
  if (!relative(root, path).startsWith("../"))
    throw new Error("fixture output must be outside Git");
  mkdirSync(path, { recursive: true });
  const actual = realpathSync(path);
  if (!relative(realpathSync(root), actual).startsWith("../"))
    throw new Error("fixture output resolves inside Git");
  const git = Bun.spawnSync(["git", "-C", actual, "rev-parse", "--is-inside-work-tree"]);
  if (git.exitCode === 0 && git.stdout.toString().trim() === "true")
    throw new Error("fixture output must be outside every Git worktree");
  return actual;
}

function buildThreadFixture(directory: string) {
  const outdir = outputDirectory(directory);
  const scratch = mkdtempSync(join(outdir, ".build-"));
  try {
    const configuration = contract();
    const compiler = compilerInputs();
    const output = join(scratch, THREAD_FIXTURE_WASM);
    run(
      [compiler.rustc].concat(flags, [
        `--remap-path-prefix=${root}=/waffle-thread-fixture`,
        join(root, source),
        "-o",
        output,
      ]),
    );
    const wasm = readFileSync(output);
    const payload = {
      schema: 1,
      contract: configuration,
      compiler: { version: compiler.version, files: compiler.inventory },
      artifact: { path: THREAD_FIXTURE_WASM, size: wasm.length, sha256: digest(wasm) },
    };
    const receipt = { ...payload, sha256: digest(json(payload)) };
    writeFileSync(join(scratch, THREAD_FIXTURE_RECEIPT), json(receipt));
    renameSync(output, join(outdir, THREAD_FIXTURE_WASM));
    renameSync(join(scratch, THREAD_FIXTURE_RECEIPT), join(outdir, THREAD_FIXTURE_RECEIPT));
    return receipt;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid thread fixture receipt");
  return Object.fromEntries(Object.entries(value));
}

function readReceipt(directory: string) {
  const receipt = record(JSON.parse(readFileSync(join(directory, THREAD_FIXTURE_RECEIPT), "utf8")));
  const { sha256, ...payload } = receipt;
  if (receipt.schema !== 1 || sha256 !== digest(json(payload)))
    throw new Error("thread fixture receipt digest does not match");
  return receipt;
}

function verifyThreadCompiler(directory: string): void {
  verifiedThreadFixture(directory);
  const expected = record(readReceipt(directory).compiler);
  const actual = compilerInputs();
  if (json(expected) !== json({ version: actual.version, files: actual.inventory }))
    throw new Error("thread fixture compiler inputs changed or are missing");
}

export function verifiedThreadFixture(directory: string): Uint8Array<ArrayBuffer> {
  const receipt = readReceipt(directory);
  if (json(receipt.contract) !== json(contract()))
    throw new Error("thread fixture inputs changed or are missing; rebuild explicitly");
  const compiler = record(receipt.compiler);
  if (typeof compiler.version !== "string" || !compiler.version.startsWith(`rustc ${toolchain} `))
    throw new Error("thread fixture compiler does not match the pinned toolchain");
  if (!Array.isArray(compiler.files) || compiler.files.length === 0)
    throw new Error("thread fixture has no compiler inventory");
  const artifact = record(receipt.artifact);
  const wasm = readFileSync(join(directory, THREAD_FIXTURE_WASM));
  if (
    artifact.path !== THREAD_FIXTURE_WASM ||
    artifact.sha256 !== digest(wasm) ||
    artifact.size !== wasm.length
  )
    throw new Error("thread fixture output changed or is missing");
  return new Uint8Array(wasm);
}

if (import.meta.main) {
  const directory = process.env.THREAD_FIXTURE_DIR;
  if (!directory) throw new Error("THREAD_FIXTURE_DIR must name an external artifact directory");
  const args = process.argv.slice(2);
  if (args.length === 0) console.log(json(buildThreadFixture(directory)));
  else if (args.length === 1 && args[0] === "--verify") {
    const wasm = verifiedThreadFixture(directory);
    console.log(json({ verified: true, size: wasm.length, sha256: digest(wasm) }));
  } else if (args.length === 1 && args[0] === "--verify-toolchain") {
    verifyThreadCompiler(directory);
    console.log(json({ verifiedToolchain: true }));
  } else throw new Error("usage: build-thread-fixture.ts [--verify | --verify-toolchain]");
}
