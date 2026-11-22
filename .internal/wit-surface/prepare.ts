import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { browserBundle } from "../../packages/waffle/tests/browser-runner-lifecycle.js";

const microsoft = "7585d3902cad4948f2f8852006d3714b2a9afb1f";
const namespace = "waffle:experiment/window";
const tools = process.env.WASM_TOOLS ?? "wasm-tools";

async function command(args: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "inherit" });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}`);
  return stdout;
}

async function generate(scratch: string) {
  const source = resolve(scratch, "microsoft");
  const generated = resolve(scratch, "generated");
  await Promise.all([mkdir(source), mkdir(generated)]);
  const archive = resolve(scratch, "microsoft.tar.gz");
  await command(
    [
      "curl",
      "-fsSL",
      "-o",
      archive,
      `https://codeload.github.com/microsoft/vscode-wasm/tar.gz/${microsoft}`,
    ],
    scratch,
  );
  await command(["tar", "-xzf", archive, "--strip-components=1"], source);
  await command(
    [
      "patch",
      "--batch",
      "--fuzz=0",
      "-p1",
      "-i",
      resolve(import.meta.dir, "microsoft-browser-init.patch"),
    ],
    source,
  );
  const packageDir = resolve(source, "wasm-component-model");
  const install = ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"];
  await command(install, source);
  await command(install, packageDir);
  await command(
    [
      "node",
      "../node_modules/typescript/bin/tsc",
      "-b",
      "src/tools/tsconfig.publish.json",
      "src/browser/tsconfig.publish.json",
    ],
    packageDir,
  );

  const wit = resolve(import.meta.dir, "guest/wit");
  const require = createRequire(import.meta.url);
  const { Options } = require(resolve(packageDir, "lib/tools/options.js"));
  const { processDocument } = require(resolve(packageDir, "lib/tools/wit2ts.js"));
  const options = { ...Options.defaults, input: wit, outDir: generated };
  assert(Options.validate(options));
  processDocument(
    JSON.parse(await command([tools, "component", "wit", "--json", wit], scratch)),
    options,
  );
  return {
    bindings: resolve(generated, "guest.ts"),
    runtime: resolve(packageDir, "lib/browser/main.js"),
  };
}

async function rustGuests(scratch: string) {
  const guest = resolve(import.meta.dir, "guest");
  const target = resolve(scratch, "target");
  const args = ["cargo", "+1.98.1", "build", "--locked", "--release", "--target", "wasm32-wasip1"];
  const env = { ...process.env, CARGO_TARGET_DIR: target, RUSTC_WRAPPER: "" };
  const output = resolve(target, "wasm32-wasip1/release/surface-wire.wasm");
  await command(args, guest, env);
  const generated = await Bun.file(output).arrayBuffer();
  const wat = await command([tools, "print", output], scratch);
  const imports = wat.split("\n").filter((line) => line.includes(`(import "${namespace}"`));
  assert.deepEqual(imports.map((line) => line.replace(/\(;\d+;\) \(type \d+\) /, "")).sort(), [
    `  (import "${namespace}" "[method]surface.info" (func (param i32 i32)))`,
    `  (import "${namespace}" "[resource-drop]surface" (func (param i32)))`,
    `  (import "${namespace}" "acquire" (func (param i32 i32)))`,
  ]);
  await command(args.concat("--no-default-features"), guest, env);
  return { generated, handwritten: await Bun.file(output).arrayBuffer(), imports };
}

const peer = String.raw`(module
  (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "\10\00\00\00\01\00\00\00")
  (func (export "_start")
    (if (call $read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 8))
      (then unreachable))
    (if (i32.ne (i32.load (i32.const 8)) (i32.const 1)) (then unreachable))))`;

const acquire = `(import "${namespace}" "acquire" (func $acquire (param i32 i32)))`;
const startup = `(module
  ${acquire}
  (import "surface-fixture" "missing" (func $missing))
  (memory (export "memory") 1)
  (func (export "_start") (call $missing)))`;

function staleUse(doubleDrop: boolean) {
  return `(module
    ${acquire}
    (import "${namespace}" "[method]surface.info" (func $info (param i32 i32)))
    (import "${namespace}" "[resource-drop]surface" (func $drop (param i32)))
    (memory (export "memory") 1)
    (func (export "cabi_realloc") (param i32 i32 i32 i32) (result i32) unreachable)
    (func (export "_start") (local $old i32) (local $new i32)
      (call $acquire (i32.const 1) (i32.const 0))
      (if (i32.ne (i32.load8_u (i32.const 0)) (i32.const 1)) (then unreachable))
      (local.set $old (i32.load (i32.const 4)))
      (call $drop (local.get $old))
      (call $acquire (i32.const 1) (i32.const 0))
      (if (i32.ne (i32.load8_u (i32.const 0)) (i32.const 1)) (then unreachable))
      (local.set $new (i32.load (i32.const 4)))
      (if (i32.eq (local.get $old) (local.get $new)) (then unreachable))
      (call $info (local.get $new) (i32.const 8))
      (if (i32.ne (i32.load8_u (i32.const 8)) (i32.const 1)) (then unreachable))
      ${doubleDrop ? "(call $drop (local.get $old))" : "(call $info (local.get $old) (i32.const 8))"}))`;
}

async function controls(scratch: string) {
  const modules = Object.entries({
    peer,
    startup,
    stale: staleUse(false),
    "double-drop": staleUse(true),
  });
  const outputs: Record<string, Blob> = {};
  for (const [name, wat] of modules) {
    const source = resolve(scratch, `${name}.wat`);
    const output = resolve(scratch, `${name}.wasm`);
    await Bun.write(source, wat);
    await command([tools, "parse", source, "-o", output], scratch);
    outputs[`/${name}.wasm`] = new Blob([await Bun.file(output).arrayBuffer()], {
      type: "application/wasm",
    });
  }
  return outputs;
}

async function bundle(path: string, aliases?: Record<string, string>) {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, path)],
    target: "browser",
    minify: true,
    metafile: true,
    plugins: aliases
      ? [
          {
            name: "pinned-wit-bindings",
            setup(build) {
              build.onResolve(
                { filter: /^(@vscode\/wasm-component-model|experiment-wit-bindings)$/ },
                ({ path }) => ({ path: aliases[path]! }),
              );
            },
          },
        ]
      : [],
  });
  if (!result.success || !result.metafile) throw new AggregateError(result.logs, path);
  return { output: result.outputs[0]!, inputs: Object.keys(result.metafile.inputs) };
}

function size(bytes: ArrayBuffer) {
  return { bytes: bytes.byteLength, gzip: gzipSync(new Uint8Array(bytes)).length };
}

export async function prepare(scratch: string) {
  const host = await generate(scratch);
  const guests = await rustGuests(scratch);
  const other = await controls(scratch);
  const [adapter, worker, page, fs] = await Promise.all([
    bundle("adapter.ts", {
      "@vscode/wasm-component-model": host.runtime,
      "experiment-wit-bindings": host.bindings,
    }),
    bundle("worker.ts"),
    bundle("scenarios.ts"),
    browserBundle(resolve(import.meta.dir, "../../packages/waffle/browser/fs-worker.ts")),
  ]);
  assert(adapter.inputs.some((path) => path.endsWith("/generated/guest.ts")));
  const ordinaryInputs = worker.inputs.concat(page.inputs);
  assert(
    !ordinaryInputs.some((path) =>
      /wasm-component-model|wit-surface\/adapter\.ts|generated\/guest\.ts/.test(path),
    ),
  );
  const bytes = {
    generatedTypeScript: size(await Bun.file(host.bindings).arrayBuffer()),
    optionalAdapter: size(await adapter.output.arrayBuffer()),
    generatedGuest: size(guests.generated),
    handwrittenGuest: size(guests.handwritten),
  };
  const wasm = (data: ArrayBuffer) => new Blob([data], { type: "application/wasm" });
  return {
    imports: guests.imports,
    bytes,
    routes: {
      ...other,
      "/": "<!DOCTYPE html><title>Waffle surface binding experiment</title>",
      "/page.js": page.output,
      "/gpu-guest.js": worker.output,
      "/fs-worker.js": fs,
      "/wit-surface-adapter.js": adapter.output,
      "/generated.wasm": wasm(guests.generated),
      "/handwritten.wasm": wasm(guests.handwritten),
    },
  };
}
