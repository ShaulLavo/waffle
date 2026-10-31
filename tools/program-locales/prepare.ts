import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { patchBuildScript, sha256, sourceIdentity } from "./patch.ts";
import { selectCatalogs } from "./selection.ts";

interface CargoPackage {
  id: string;
  name: string;
  version: string;
  source: string | null;
  manifest_path: string;
}

export function programLocalePackages(manifest: string, env: NodeJS.ProcessEnv): CargoPackage[] {
  const parsed: unknown = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        "wasm32-wasip1",
        "--manifest-path",
        manifest,
      ],
      { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  assert.ok(
    parsed && typeof parsed === "object" && "packages" in parsed && Array.isArray(parsed.packages),
  );
  const packages = parsed.packages.map((entry: unknown) => {
    assert.ok(
      entry &&
        typeof entry === "object" &&
        "id" in entry &&
        typeof entry.id === "string" &&
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
      id: entry.id,
      name: entry.name,
      version: entry.version,
      source: entry.source,
      manifest_path: entry.manifest_path,
    };
  });
  assert.ok("resolve" in parsed && parsed.resolve && typeof parsed.resolve === "object");
  const graph = parsed.resolve;
  assert.ok(
    "root" in graph && typeof graph.root === "string",
    "Locale metadata needs a package manifest",
  );
  assert.ok("nodes" in graph && Array.isArray(graph.nodes));
  const dependencies = new Map<string, string[]>();
  for (const node of graph.nodes) {
    assert.ok(node && typeof node === "object" && "id" in node && typeof node.id === "string");
    assert.ok("dependencies" in node && Array.isArray(node.dependencies));
    assert.ok(node.dependencies.every((id: unknown): id is string => typeof id === "string"));
    dependencies.set(node.id, node.dependencies);
  }
  const selected = new Set([graph.root]);
  for (const id of selected) {
    const children = dependencies.get(id);
    assert.ok(children, `Missing Cargo dependency node: ${id}`);
    for (const child of children) selected.add(child);
  }
  return packages.filter((entry) => selected.has(entry.id));
}

function localeManifest(root: string, program: string): string {
  if (program === "sed") return resolve(root, "packages/sed/Cargo.toml");
  if (program === "find" || program === "xargs")
    return resolve(root, "packages/findutils/Cargo.toml");
  const isolated = new Set(["cut", "tr", "wc", "echo", "clear", "date"]);
  const path = isolated.has(program)
    ? `packages/coreutils/crates/${program}`
    : "packages/coreutils";
  return resolve(root, path, "Cargo.toml");
}

/** A generated dependency tree whose receipt seals every file, exported from a pinned revision. */
export interface OwnedLocaleSource {
  readonly directory: string;
  readonly revision: string;
  readonly receiptSha256: string;
}

export function verifyOwnedLocaleSource(root: string, owned: OwnedLocaleSource): void {
  const expected = resolve(realpathSync(root), "packages/coreutils/.sources/checksums");
  assert.equal(
    resolve(owned.directory),
    expected,
    "Owned locales require the sealed checksum directory",
  );
  assert.equal(
    realpathSync(owned.directory),
    expected,
    "Owned locales require the sealed checksum directory",
  );
  const bytes = readFileSync(resolve(expected, "waffle-source.json"));
  assert.equal(sha256(bytes), owned.receiptSha256, "Owned locale receipt digest changed");
  const receipt: unknown = JSON.parse(bytes.toString("utf8"));
  assert.ok(receipt && typeof receipt === "object" && "revision" in receipt && "files" in receipt);
  assert.equal(receipt.revision, owned.revision, "Owned locale receipt revision changed");
  assert.deepEqual(
    receipt.files,
    ownedLocaleSourceIdentity(expected),
    "Owned locale sealed source changed",
  );
}

export function ownedLocaleSourceIdentity(directory: string): Record<string, string> {
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => ({ entry, path: resolve(entry.parentPath, entry.name) }))
    .filter(({ path }) => path !== resolve(directory, "waffle-source.json"));
  entries.sort((first, second) => first.path.localeCompare(second.path));
  return Object.fromEntries(
    entries.map(({ entry, path }) => {
      const name = relative(directory, path);
      if (!entry.isSymbolicLink()) return [name, sha256(readFileSync(path))];
      const target = readlinkSync(path);
      const destination = resolve(dirname(path), target);
      assert.ok(
        destination === directory || inside(directory, destination),
        "Owned locale symbolic link escapes sealed source",
      );
      return [name, sha256(`symlink\0${target}`)];
    }),
  );
}

function inside(directory: string, path: string) {
  const offset = relative(directory, path);
  return offset !== "" && !offset.startsWith("..") && !offset.startsWith("/");
}

function pinned(entry: CargoPackage, version: string, owned: OwnedLocaleSource | undefined) {
  const identity = sourceIdentity(version);
  if (entry.source === identity.source) return true;
  if (entry.source !== null) return false;
  if (owned)
    return owned.revision === identity.revision && inside(owned.directory, entry.manifest_path);
  return entry.name === "uu_env";
}

function catalogInput(
  packages: readonly CargoPackage[],
  key: string,
  version: string,
  owned: OwnedLocaleSource | undefined,
) {
  const identity = sourceIdentity(version);
  const catalog = Object.entries(identity.catalogs).find(([name]) => name === key)?.[1];
  assert.ok(catalog, `Missing pinned catalog: ${version}/${key}`);
  const pkg = packages.find(
    (entry) =>
      entry.name === catalog.package && entry.version === version && pinned(entry, version, owned),
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
  readonly ownedSource?: OwnedLocaleSource;
}): NodeJS.ProcessEnv {
  const { root, program, env, ownedSource } = options;
  assert.ok(
    !env.RUSTC_WRAPPER,
    "Program locale builds require their declared rustc wrapper, not a hidden wrapper chain",
  );
  if (ownedSource) verifyOwnedLocaleSource(root, ownedSource);
  const packages = programLocalePackages(options.manifest ?? localeManifest(root, program), env);
  const selections = packages
    .filter((entry) => entry.name === "uucore")
    .map((pkg) => {
      const identity = sourceIdentity(pkg.version);
      assert.ok(pinned(pkg, pkg.version, ownedSource), "Unpinned uucore dependency source");
      const buildScript = resolve(dirname(pkg.manifest_path), "build.rs");
      assert.equal(
        sha256(readFileSync(buildScript)),
        identity.buildScriptSha256,
        "Unpinned uucore build.rs",
      );
      const catalogs = selectCatalogs(program, pkg.version).map((key) =>
        catalogInput(packages, key, pkg.version, ownedSource),
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
    ownedSource: ownedSource ?? null,
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
  mkdirSync(target, { recursive: true });
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
  ["date", "waffle-date"],
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

function generatedKeys(source: string) {
  const keys = Array.from(source.matchAll(/^\s*"([^"\n]+)" => Some/gm), (match) => match[1]);
  assert.ok(
    keys.length >= 2 && keys.every((key) => key?.endsWith("/en-US.ftl")),
    "Unexpected generated locale selection",
  );
  return keys;
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
      const keys = generatedKeys(source);
      const version = readFileSync(resolve(out, "waffle-program-locale-version"), "utf8");
      const expected = readFileSync(resolve(inputs, `${version}.inputs`), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("\t")[0]);
      assert.deepEqual(keys, expected, "Generated catalogs do not match the selected program");
      // Keep the generated bytes themselves: later boundaries must not rely on Cargo's OUT_DIR.
      const path = resolve(out, "embedded_locales.rs");
      return [{ path, sha256: sha256(source), version, keys, source }];
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
  assert.ok(env.WAFFLE_PROGRAM_LOCALE_INPUTS);
  const proof = {
    program,
    selection: readFileSync(resolve(env.WAFFLE_PROGRAM_LOCALE_INPUTS, "selection.json"), "utf8"),
    generated,
    originalGuest: { path: source, sha256: sha256(readFileSync(source)) },
  };
  atomicWrite(
    resolve(env.WAFFLE_PROGRAM_LOCALE_INPUTS, "producer.json"),
    JSON.stringify(proof, null, 2) + "\n",
  );
  atomicWrite(`${destination}.locales.json`, JSON.stringify(proof, null, 2) + "\n");
  return proof;
}

export function programLocaleCargoCommand(
  env: NodeJS.ProcessEnv,
  stableTarget: string,
  program: string,
  args: readonly string[],
): [string, string[]] {
  assert.ok(env.CARGO_TARGET_DIR, "Missing producer target");
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

export function readProgramLocaleProof(guest: string, program: string): unknown {
  const proof: unknown = JSON.parse(readFileSync(`${guest}.locales.json`, "utf8"));
  assert.ok(proof && typeof proof === "object" && "program" in proof && proof.program === program);
  assert.ok(
    "originalGuest" in proof &&
      proof.originalGuest &&
      typeof proof.originalGuest === "object" &&
      "sha256" in proof.originalGuest,
  );
  assert.ok("generated" in proof && Array.isArray(proof.generated) && proof.generated.length > 0);
  for (const generated of proof.generated) {
    assert.ok(
      generated &&
        typeof generated === "object" &&
        "version" in generated &&
        typeof generated.version === "string" &&
        "keys" in generated,
    );
    assert.deepEqual(
      generated.keys,
      selectCatalogs(program, generated.version),
      "Archived locale catalog selection differs",
    );
    assert.ok(
      "sha256" in generated &&
        typeof generated.sha256 === "string" &&
        "source" in generated &&
        typeof generated.source === "string",
      "Locale proof lacks its generated source bytes",
    );
    assert.equal(sha256(generated.source), generated.sha256, "Generated locale source changed");
    assert.deepEqual(
      generatedKeys(generated.source),
      generated.keys,
      "Generated locale source differs",
    );
  }
  assert.equal(
    proof.originalGuest.sha256,
    sha256(readFileSync(guest)),
    "Locale producer bytes differ from the original compiler artifact",
  );
  return proof;
}
