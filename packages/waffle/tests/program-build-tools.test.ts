import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packageProgramTools, programToolSources } from "../tooling/program-tools-package";

const packageRoot = resolve(import.meta.dir, "..");
const repository = resolve(packageRoot, "../..");

const consumer = `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  wasiTarget, wasiBuildConfiguration, wasiSysrootCommand,
  wasiCargoEnvironment, wasiBuildEnvironment, verifyWasiGuest, functionNames,
  type WasiBuildRecipe, type WasiGuestVerification,
} from "waffle/program-build-tools";
const entry = import.meta.resolve("waffle/program-build-tools");
assert.ok(entry.endsWith(process.env.EXPECTED_ENTRY_SUFFIX ?? "missing"), entry);
const root = resolve("fixture-" + process.env.RUNTIME);
const waffle = resolve(root, "selected-waffle");
const sdk = resolve(root, "sdk");
mkdirSync(resolve(waffle, "scripts"), { recursive: true });
mkdirSync(resolve(waffle, "patches/wasi-libc"), { recursive: true });
mkdirSync(sdk, { recursive: true });
writeFileSync(resolve(sdk, "VERSION"), "34.0\\nwasi-libc: 2e6fb9d8ee0c\\n");
writeFileSync(resolve(waffle, "patches/wasi-libc/preopen-scan.patch"), "selected patch");
writeFileSync(resolve(waffle, "scripts/build-wasi-libc.sh"),
  'set -eu\\nmkdir -p "$1/lib/wasm32-wasip1"\\nprintf fixture > "$1/lib/wasm32-wasip1/libc.a"\\n');
const recipe: WasiBuildRecipe = {
  root, waffle, env: { ...process.env, WASI_SDK_PATH: sdk, RUSTFLAGS: "discard" },
};
assert.equal(wasiTarget, "wasm32-wasip1");
const config = wasiBuildConfiguration(recipe);
assert.equal(config.builder, resolve(waffle, "scripts/build-wasi-libc.sh"));
assert.equal(config.identity, createHash("sha256").update(sdk)
  .update(readFileSync(resolve(sdk, "VERSION")))
  .update(readFileSync(config.builder))
  .update(readFileSync(resolve(waffle, "patches/wasi-libc/preopen-scan.patch")))
  .digest("hex"));
assert.equal(existsSync(config.sysroot), false);
assert.equal(wasiCargoEnvironment(recipe, "target").RUSTFLAGS, undefined);
const [command, args] = wasiSysrootCommand(recipe);
assert.equal(command, "flock");
assert.equal(args.at(-1), waffle);
assert.equal(args.at(-2), root);
const env = wasiBuildEnvironment(recipe, "target");
assert.equal(env.CARGO_TARGET_DIR, resolve(root, "target"));
assert.ok(env.CARGO_ENCODED_RUSTFLAGS?.includes("--max-memory=268435456"));
assert.equal(readFileSync(resolve(config.sysroot, "lib/wasm32-wasip1/libc.a"), "utf8"), "fixture");
writeFileSync(resolve(waffle, "patches/wasi-libc/preopen-scan.patch"), "different selected patch");
assert.notEqual(wasiBuildConfiguration(recipe).identity, config.identity);
const header = [0, 97, 115, 109, 1, 0, 0, 0];
const custom = (payload: number[]) => [0, payload.length + 5, 4, 110, 97, 109, 101].concat(payload);
const module = (sections: number[]) => new WebAssembly.Module(Uint8Array.from(header.concat(sections)));
const names: Map<string, number> = functionNames(module(custom([1, 7, 2, 0, 1, 97, 7, 1, 98])
  .concat(custom([0, 2, 1, 120]), custom([1, 4, 1, 9, 1, 97]))));
assert.deepEqual(Array.from(names), [["a", 9], ["b", 7]]);
assert.equal(functionNames(module([])).size, 0);
assert.throws(() => functionNames(module(custom([1, 4, 1, 0, 2, 97]))), /truncated/);
const guest = resolve(root, "capped.wasm");
const bytes = Uint8Array.from(header.concat([5, 5, 1, 1, 1, 128, 32]));
writeFileSync(guest, bytes);
const verification: WasiGuestVerification = { sdk, filesystemAdapter: "fixture::wasi" };
verifyWasiGuest(guest, verification);
writeFileSync(guest, Uint8Array.from(header.concat([5, 3, 1, 0, 1])));
assert.throws(() => verifyWasiGuest(guest, verification), /unshared maximum/);
const directory = resolve("node_modules/waffle", process.env.RUNTIME === "node" ? "dist/tooling/program" : "tooling/program");
const extension = process.env.RUNTIME === "node" ? ".js" : ".ts";
const derivation = await import(pathToFileURL(resolve(directory, "program-derivation" + extension)).href);
const optimizer = await import(pathToFileURL(resolve(directory, "program-optimize" + extension)).href);
const sources = derivation.transformationSourceIdentity();
const provenance = derivation.transformationProvenance();
assert.equal(provenance.commit, process.env.TRANSFORMER_COMMIT);
assert.deepEqual(sources, {
  buildToolsSha256: createHash("sha256").update(readFileSync(resolve(directory, "program-build-tools.ts"))).digest("hex"),
  optimizerSourceSha256: createHash("sha256").update(readFileSync(resolve(directory, "program-optimize.ts"))).digest("hex"),
});
const metadata = resolve(directory, "program-transformer.json");
renameSync(metadata, metadata + ".held");
try { assert.throws(() => derivation.transformationProvenance(), /ENOENT/); }
finally { renameSync(metadata + ".held", metadata); }
const identity = derivation.programBytesIdentity(bytes);
const policy = {
  policy: optimizer.programOptimizationPolicy, version: optimizer.programOptimizer.version,
  sha256: optimizer.programOptimizer.linuxX64Sha256,
  flags: Array.from(optimizer.programOptimizationFlags), environment: optimizer.programOptimizationEnvironment,
};
const receipt = {
  operation: "optimize-and-strip-program", input: identity, output: identity, transformer: provenance,
  operations: [{ format: 1, stage: "wasm-opt-before-name-strip", input: identity, output: identity,
    optimizer: policy, producerReceipt: null },
    { operation: "strip-wasm-name-sections", input: identity, output: identity }],
};
derivation.validateProgramDerivation(receipt, bytes);
assert.throws(() => derivation.validateProgramDerivation({ ...receipt,
  transformer: { ...provenance, optimizerSourceSha256: "0".repeat(64) } }, bytes), /Optimizer source changed/);
assert.throws(() => derivation.validateProgramDerivation({ ...receipt,
  output: { ...identity, sha256: "0".repeat(64) } }, bytes), /Final program derivation identity/);
const source = resolve(directory, "program-optimize.ts");
const original = readFileSync(source);
try {
  writeFileSync(source, Buffer.concat([original, Buffer.from("\\n// changed source\\n")]));
  assert.throws(() => derivation.transformationProvenance());
} finally { writeFileSync(source, original); }
const features = Array.from(new TextEncoder().encode("not-supported"));
const featurePayload = [15].concat(Array.from(new TextEncoder().encode("target_features")), [1, 43, features.length], features);
writeFileSync(guest, Uint8Array.from(header.concat([0, featurePayload.length], featurePayload)));
assert.throws(() => optimizer.optimizeProgram({ source: guest, destination: resolve(root, "out.wasm"), verify() {} }), /Unsupported program target feature/);
`;

function checkWorkspacePrepare(scratch: string, installed: string): void {
  const workspace = join(scratch, "packages/waffle");
  cpSync(installed, workspace, { recursive: true });
  mkdirSync(join(scratch, "tools"));
  for (const file of programToolSources)
    writeFileSync(join(scratch, "tools", file), "// foreign consumer helper\n");
  const receipt = readFileSync(join(installed, "tooling/program/program-transformer.json"));
  execFileSync(process.execPath, [join(workspace, "prepare.ts")], {
    cwd: workspace,
    env: { ...process.env, CARGO: "/bin/false", WAFFLE_NETWORK_PREBUILT: "1" },
    stdio: "pipe",
  });
  for (const directory of ["tooling/program", "dist/tooling/program"]) {
    assert.deepEqual(readFileSync(join(workspace, directory, "program-transformer.json")), receipt);
    for (const file of programToolSources)
      assert.deepEqual(
        readFileSync(join(workspace, directory, file)),
        readFileSync(join(installed, "tooling/program", file)),
      );
  }
}

test("packed build tools work without the repository in Node, Bun and a typed consumer", () => {
  const scratch = mkdtempSync(join(tmpdir(), "waffle-build-tools-"));
  try {
    const installed = join(scratch, "node_modules/waffle");
    mkdirSync(installed, { recursive: true });
    const archive = join(scratch, "waffle.tgz");
    execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--filename", archive], {
      cwd: packageRoot,
      stdio: "pipe",
    });
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", installed]);
    for (const file of programToolSources) {
      const original = readFileSync(join(repository, "tools", file));
      assert.deepEqual(readFileSync(join(installed, "tooling/program", file)), original);
      assert.deepEqual(readFileSync(join(installed, "dist/tooling/program", file)), original);
    }
    for (const file of ["scripts/build-wasi-libc.sh", "patches/wasi-libc/preopen-scan.patch"])
      assert.deepEqual(readFileSync(join(installed, file)), readFileSync(join(packageRoot, file)));
    execFileSync(process.execPath, [join(installed, "prepare.ts")], {
      cwd: installed,
      env: { ...process.env, CARGO: "/bin/false", WAFFLE_NETWORK_PREBUILT: "1" },
      stdio: "pipe",
    });
    writeFileSync(join(scratch, "package.json"), '{"type":"module","private":true}\n');
    writeFileSync(join(scratch, "consumer.ts"), consumer);
    const provenance = JSON.parse(
      readFileSync(join(installed, "tooling/program/program-transformer.json"), "utf8"),
    );
    assert.equal(
      provenance.commit,
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
    );
    // A consumer repository must not become the transformer's provenance.
    execFileSync("git", ["init", "--quiet"], { cwd: scratch });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        "consumer",
      ],
      { cwd: scratch },
    );
    checkWorkspacePrepare(scratch, installed);
    for (const runtime of ["node", "bun"]) {
      execFileSync(runtime, ["consumer.ts"], {
        cwd: scratch,
        env: {
          ...process.env,
          RUNTIME: runtime,
          TRANSFORMER_COMMIT: provenance.commit,
          EXPECTED_ENTRY_SUFFIX:
            runtime === "node"
              ? "/dist/tooling/program/program-build-tools.js"
              : "/tooling/program/program-build-tools.ts",
        },
        stdio: "pipe",
      });
    }
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          types: ["bun"],
          typeRoots: [join(packageRoot, "node_modules/@types")],
        },
        files: ["consumer.ts"],
      }),
    );
    execFileSync(join(packageRoot, "node_modules/.bin/tsc"), ["-p", scratch], { stdio: "inherit" });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test.each(["consumer", "waffle-monorepo"])(
  "workspace-shaped consumers preserve packaged tools (%s)",
  (name) => {
    const scratch = mkdtempSync(join(tmpdir(), "waffle-tool-workspace-"));
    try {
      const installed = join(scratch, "packages/waffle");
      const staged = join(installed, "tooling/program");
      mkdirSync(staged, { recursive: true });
      mkdirSync(join(scratch, "tools"));
      writeFileSync(join(scratch, "package.json"), JSON.stringify({ name, private: true }));
      execFileSync("git", ["init", "--quiet"], { cwd: scratch });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/example/consumer.git"], {
        cwd: scratch,
      });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "--quiet",
          "-m",
          "consumer",
        ],
        { cwd: scratch },
      );
      for (const file of programToolSources) {
        writeFileSync(join(staged, file), "packaged " + file);
        writeFileSync(join(scratch, "tools", file), "consumer " + file);
      }
      const metadata = join(staged, "program-transformer.json");
      const receipt = '{"commit":"' + "a".repeat(40) + '"}\n';
      writeFileSync(metadata, receipt);
      packageProgramTools(installed);
      for (const file of programToolSources)
        assert.equal(readFileSync(join(staged, file), "utf8"), "packaged " + file);
      assert.equal(readFileSync(metadata, "utf8"), receipt);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
