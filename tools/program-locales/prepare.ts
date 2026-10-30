import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { patchBuildScript, sha256, sourceIdentity } from "./patch.ts";
import { selectCatalogs } from "./selection.ts";

interface CargoPackage {
  name: string;
  version: string;
  source: string | null;
  manifest_path: string;
}

function cargoPackages(manifest: string): CargoPackage[] {
  const parsed: unknown = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--locked", "--offline", "--format-version", "1", "--manifest-path", manifest],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  assert.ok(
    parsed && typeof parsed === "object" && "packages" in parsed && Array.isArray(parsed.packages),
  );
  return parsed.packages.map((entry: unknown) => {
    assert.ok(
      entry &&
        typeof entry === "object" &&
        "name" in entry &&
        typeof entry.name === "string" &&
        "version" in entry &&
        typeof entry.version === "string" &&
        "source" in entry &&
        (typeof entry.source === "string" || entry.source === null) &&
        "manifest_path" in entry &&
        typeof entry.manifest_path === "string",
    );
    return {
      name: entry.name,
      version: entry.version,
      source: entry.source,
      manifest_path: entry.manifest_path,
    };
  });
}

function catalogInput(packages: readonly CargoPackage[], key: string, version: string) {
  const identity = sourceIdentity(version);
  const catalog = Object.entries(identity.catalogs).find(([name]) => name === key)?.[1];
  assert.ok(catalog, `Missing pinned catalog: ${version}/${key}`);
  const pkg = packages.find(
    (entry) =>
      entry.name === catalog.package &&
      entry.version === version &&
      (entry.source === identity.source || (entry.name === "uu_env" && entry.source === null)),
  );
  assert.ok(pkg, `Missing pinned locale package: ${catalog.package} ${version}`);
  const path = resolve(dirname(pkg.manifest_path), catalog.path);
  assert.equal(sha256(readFileSync(path)), catalog.sha256, `Changed catalog: ${path}`);
  return { key, path, sha256: catalog.sha256 };
}

function atomicWrite(path: string, text: string) {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return;
  const temporary = `${path}.${process.pid}`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

export function prepareProgramLocales(options: {
  readonly root: string;
  readonly program: string;
  readonly env: NodeJS.ProcessEnv;
  readonly manifest?: string;
}): NodeJS.ProcessEnv {
  const { root, program, env } = options;
  assert.ok(
    !env.RUSTC_WRAPPER,
    "Program locale builds require their declared rustc wrapper, not a hidden wrapper chain",
  );
  const packages = cargoPackages(options.manifest ?? resolve(root, "Cargo.toml"));
  const selections = packages
    .filter((entry) => entry.name === "uucore")
    .map((pkg) => {
      const identity = sourceIdentity(pkg.version);
      assert.equal(pkg.source, identity.source, "Unpinned uucore dependency source");
      const buildScript = resolve(dirname(pkg.manifest_path), "build.rs");
      assert.equal(
        sha256(readFileSync(buildScript)),
        identity.buildScriptSha256,
        "Unpinned uucore build.rs",
      );
      const catalogs = selectCatalogs(program, pkg.version).map((key) =>
        catalogInput(packages, key, pkg.version),
      );
      return {
        version: pkg.version,
        source: pkg.source,
        buildScript,
        buildScriptSha256: identity.buildScriptSha256,
        patchedBuildScriptSha256: sha256(
          patchBuildScript(
            readFileSync(buildScript, "utf8"),
            pkg.version,
            resolve(import.meta.dirname, "generate.rs"),
            resolve(import.meta.dirname, "rustc-wrapper.ts"),
          ),
        ),
        catalogs,
      };
    });
  assert.ok(selections.length > 0, "No applicable uucore dependency");
  const implementation = [
    "prepare.ts",
    "selection.ts",
    "patch.ts",
    "rustc-wrapper.ts",
    "generate.rs",
    "sources.json",
    "build.ts",
  ].map((path) => ({
    path: `tools/program-locales/${path}`,
    sha256: sha256(readFileSync(resolve(import.meta.dirname, path))),
  }));
  const receipt = {
    program,
    policy: "utility-and-common-English-only",
    implementation,
    sources: selections,
  };
  const directory = resolve(root, ".build/program-locales", sha256(JSON.stringify(receipt)));
  mkdirSync(directory, { recursive: true });
  for (const selection of selections) {
    const patched = patchBuildScript(
      readFileSync(selection.buildScript, "utf8"),
      selection.version,
      resolve(import.meta.dirname, "generate.rs"),
      resolve(import.meta.dirname, "rustc-wrapper.ts"),
    );
    const sources = resolve(directory, "sources", sha256(patched));
    mkdirSync(sources, { recursive: true });
    atomicWrite(resolve(sources, "build.rs"), patched);
    atomicWrite(
      resolve(directory, `${selection.version}.inputs`),
      selection.catalogs.map((entry) => `${entry.key}\t${entry.path}\n`).join(""),
    );
  }
  atomicWrite(resolve(directory, "selection.json"), JSON.stringify(receipt, null, 2) + "\n");
  const implementationId = sha256(JSON.stringify(implementation));
  assert.ok(env.CARGO_TARGET_DIR, "Missing pinned Cargo target directory");
  const target = resolve(
    root,
    ".build/program-locales/cargo",
    implementationId,
    basename(env.CARGO_TARGET_DIR),
  );
  return {
    ...env,
    CARGO_TARGET_DIR: target,
    RUSTC_WRAPPER: resolve(import.meta.dirname, "rustc-wrapper.ts"),
    WAFFLE_PROGRAM_LOCALE_INPUTS: directory,
    WAFFLE_PROGRAM_LOCALE_IMPLEMENTATION: implementationId,
  };
}

const packagesByProgram: ReadonlyMap<string, string> = new Map([
  ["cut", "waffle-cut"],
  ["tr", "waffle-tr"],
  ["wc", "waffle-wc"],
  ["echo", "waffle-echo"],
  ["clear", "waffle-clear"],
]);

export function singleProgramBuilds(args: readonly string[], programs: readonly string[]) {
  assert.ok(programs.length > 0, "Missing program selection");
  const common: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-p" || arg === "--package" || arg === "--bin") {
      index++;
      continue;
    }
    if (arg === "--bins") continue;
    assert.ok(
      arg && !arg.startsWith("--all") && !arg.startsWith("--exclude"),
      "Grouped Cargo selection is not supported",
    );
    common.push(arg);
  }
  return programs.map((program) => {
    selectCatalogs(program, "0.13.0");
    const packageName = packagesByProgram.get(program) ?? "waffle-coreutils";
    return { program, args: common.concat(["-p", packageName, "--bin", program]) };
  });
}

export function recordProgramLocaleBuild(env: NodeJS.ProcessEnv) {
  const inputs = env.WAFFLE_PROGRAM_LOCALE_INPUTS;
  assert.ok(inputs, "Missing selected locale inputs");
  assert.ok(env.CARGO_TARGET_DIR, "Missing producer target");
  const build = resolve(env.CARGO_TARGET_DIR, "wasm32-wasip1/release/build");
  const generated = readdirSync(build)
    .filter((name) => name.startsWith("uucore-"))
    .flatMap((name) => {
      const out = resolve(build, name, "out");
      const marker = resolve(out, "waffle-program-locale-inputs");
      if (!existsSync(marker) || readFileSync(marker, "utf8") !== inputs) return [];
      const source = readFileSync(resolve(out, "embedded_locales.rs"), "utf8");
      const keys = Array.from(source.matchAll(/^\s*"([^"\n]+)" => Some/gm), (match) => match[1]);
      assert.ok(
        keys.length >= 2 && keys.every((key) => key?.endsWith("/en-US.ftl")),
        "Unexpected generated locale selection",
      );
      const version = readFileSync(resolve(out, "waffle-program-locale-version"), "utf8");
      const expected = readFileSync(resolve(inputs, `${version}.inputs`), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("\t")[0]);
      assert.deepEqual(keys, expected, "Generated catalogs do not match the selected program");
      return [{ path: resolve(out, "embedded_locales.rs"), sha256: sha256(source), version, keys }];
    });
  assert.ok(generated.length > 0, "Cargo produced no catalog selection proof");
  atomicWrite(resolve(inputs, "generated.json"), JSON.stringify(generated, null, 2) + "\n");
  return generated;
}

export function finishProgramLocaleBuild(
  env: NodeJS.ProcessEnv,
  stableTarget: string,
  program: string,
) {
  const generated = recordProgramLocaleBuild(env);
  assert.ok(env.CARGO_TARGET_DIR);
  const source = resolve(env.CARGO_TARGET_DIR, "wasm32-wasip1/release", `${program}.wasm`);
  const destination = resolve(stableTarget, "wasm32-wasip1/release", `${program}.wasm`);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  const proof = {
    generated,
    originalGuest: { path: source, sha256: sha256(readFileSync(source)) },
  };
  assert.ok(env.WAFFLE_PROGRAM_LOCALE_INPUTS);
  atomicWrite(
    resolve(env.WAFFLE_PROGRAM_LOCALE_INPUTS, "producer.json"),
    JSON.stringify(proof, null, 2) + "\n",
  );
  return proof;
}

export function programLocaleCargoCommand(
  env: NodeJS.ProcessEnv,
  stableTarget: string,
  program: string,
  args: readonly string[],
): [string, string[]] {
  assert.ok(env.CARGO_TARGET_DIR, "Missing producer target");
  mkdirSync(env.CARGO_TARGET_DIR, { recursive: true });
  return [
    "flock",
    [
      resolve(env.CARGO_TARGET_DIR, "program-locale.lock"),
      process.execPath,
      resolve(import.meta.dirname, "build.ts"),
      program,
      stableTarget,
    ].concat(args),
  ];
}
