// Stages, packs and verifies the GitHub release-tarball closure of the program families.
// Workspace edges become immutable release-asset URLs inside disposable staging copies only;
// the source checkout is never modified. See docs/program-release.md.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { admitProgramPackage, verifyProgramTarball } from "../tools/program-package.ts";

export const runtimePackageName = "waffle";
const dependencyFields = ["dependencies", "peerDependencies", "optionalDependencies"] as const;
const strippedFields = ["devDependencies", "scripts", "workspaces"] as const;
const skippedCopies = new Set(["node_modules", ".build", "target", ".sources"]);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts"]);
const unreachableRegistry = "http://127.0.0.1:9/";

type Json = Record<string, unknown>;
type DependencyField = (typeof dependencyFields)[number];

export interface RuntimeAsset {
  readonly url: string;
  readonly sha256: string;
  /** Optional local copy; it must hash to `sha256`. Otherwise `url` is downloaded. */
  readonly tarball?: string;
}

export interface ReleaseOptions {
  readonly root: string;
  readonly tag: string;
  readonly version: string;
  readonly assetBase: string;
  readonly runtime: RuntimeAsset;
  /** Top-level packages by directory name; their workspace closure is released. */
  readonly families: readonly string[];
  readonly out: string;
  readonly allowDirty?: boolean;
  /** Registry for declared third-party edges. Absent means none may be fetched. */
  readonly registry?: string;
  /** Optional consumer program, bundled against the installed closure and run after install. */
  readonly acceptance?: string;
}

interface WorkspacePackage {
  readonly name: string;
  readonly directory: string;
  readonly root: string;
  readonly manifest: Json;
}

export interface ReleasedPackage {
  readonly name: string;
  readonly sourceDirectory: string;
  readonly sourceTree: string;
  readonly sourceVersion: string;
  readonly version: string;
  readonly filename: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly closureDependencies: Record<string, string>;
  readonly registryDependencies: Record<string, string>;
  readonly strippedFields: string[];
  readonly typeOnlyUndeclared: string[];
  readonly artifacts: { path: string; bytes: number; sha256: string }[];
}

export interface ReleaseManifest {
  readonly schema: "waffle-program-release/1";
  readonly tag: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly dirty: boolean;
  readonly assetBase: string;
  readonly runtime: { name: string; version: string; url: string; bytes: number; sha256: string };
  readonly order: string[];
  readonly packages: ReleasedPackage[];
  readonly installCheck: InstallReceipt;
}

interface InstallReceipt {
  readonly registry: string;
  readonly requests: string[];
  readonly imports: string[];
  readonly wasm: { specifier: string; path: string; sha256: string }[];
  readonly acceptance?: { script: string; output: string };
}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(path: string): Json {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(isRecord(value), `Expected a JSON object: ${path}`);
  return value;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  assert.ok(isRecord(value), `${label} must be an object`);
  for (const spec of Object.values(value)) assert.equal(typeof spec, "string", label);
  return value as Record<string, string>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root].concat(args), { encoding: "utf8" }).trim();
}

export function assetFilename(name: string, version: string): string {
  return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

export function versionFromTag(tag: string): string {
  const match = /^programs-v(\d+\.\d+\.\d+)$/.exec(tag);
  assert.ok(match?.[1], `Program release tags are programs-v<major.minor.patch>: ${tag}`);
  return match[1];
}

export function loadWorkspace(root: string): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  const parent = resolve(root, "packages");
  for (const directory of readdirSync(parent).toSorted()) {
    const path = resolve(parent, directory, "package.json");
    if (!existsSync(path)) continue;
    const manifest = readJson(path);
    assert.ok(typeof manifest.name === "string", `Unnamed workspace package: ${directory}`);
    assert.ok(!packages.has(manifest.name), `Duplicate workspace name: ${manifest.name}`);
    packages.set(manifest.name, {
      name: manifest.name,
      directory,
      root: resolve(parent, directory),
      manifest,
    });
  }
  return packages;
}

function workspaceEdges(entry: WorkspacePackage, workspace: Map<string, WorkspacePackage>) {
  const names = new Set<string>();
  for (const field of dependencyFields) {
    for (const name of Object.keys(stringRecord(entry.manifest[field], field))) {
      if (workspace.has(name) && name !== runtimePackageName) names.add(name);
    }
  }
  const recipe = resolve(entry.root, "package-artifacts.json");
  if (!existsSync(recipe)) return Array.from(names);
  const dependencies = readJson(recipe).dependencies ?? [];
  assert.ok(Array.isArray(dependencies), `${entry.name} artifact dependencies`);
  for (const directory of dependencies) names.add(byDirectory(workspace, String(directory)).name);
  return Array.from(names);
}

function byDirectory(workspace: Map<string, WorkspacePackage>, directory: string) {
  const entry = Array.from(workspace.values()).find((item) => item.directory === directory);
  assert.ok(entry, `No workspace package in packages/${directory}`);
  return entry;
}

/** Dependency-first order of the requested families and their workspace closure. */
export function releaseOrder(
  workspace: Map<string, WorkspacePackage>,
  families: readonly string[],
): WorkspacePackage[] {
  const order: WorkspacePackage[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (entry: WorkspacePackage) => {
    const seen = state.get(entry.name);
    assert.notEqual(seen, "visiting", `Workspace dependency cycle at ${entry.name}`);
    if (seen === "done") return;
    state.set(entry.name, "visiting");
    for (const name of workspaceEdges(entry, workspace).toSorted()) visit(workspace.get(name)!);
    state.set(entry.name, "done");
    order.push(entry);
  };
  for (const directory of families) {
    const entry = byDirectory(workspace, directory);
    assert.notEqual(entry.name, runtimePackageName, "The runtime has its own release");
    visit(entry);
  }
  return order;
}

interface EdgeContext {
  readonly workspace: Map<string, WorkspacePackage>;
  readonly urls: Map<string, string>;
}

function rewriteEdge(
  owner: string,
  field: DependencyField,
  name: string,
  spec: string,
  context: EdgeContext,
) {
  const url = context.urls.get(name);
  if (url) return { url };
  assert.ok(
    !context.workspace.has(name),
    `${owner} ${field}.${name} is outside the release closure`,
  );
  assert.ok(
    !spec.startsWith("workspace:"),
    `${owner} ${field}.${name} is an unresolved workspace edge`,
  );
  assert.ok(!/^(link|file|portal):/.test(spec), `${owner} ${field}.${name} is a local path`);
  assert.ok(!/^[~^=v]?0\.0\.0$/.test(spec), `${owner} ${field}.${name} names an unpublished 0.0.0`);
  return { registry: spec };
}

/** Rewrite one staged manifest. Every workspace edge becomes the exact asset URL. */
export function rewriteManifest(source: Json, version: string, context: EdgeContext) {
  const owner = String(source.name);
  const manifest: Json = { ...source, version };
  const closureDependencies: Record<string, string> = {};
  const registryDependencies: Record<string, string> = {};
  for (const field of dependencyFields) {
    const entries = Object.entries(stringRecord(source[field], `${owner} ${field}`));
    if (!entries.length) continue;
    const rewritten: Record<string, string> = {};
    for (const [name, spec] of entries) {
      const edge = rewriteEdge(owner, field, name, spec, context);
      rewritten[name] = edge.url ?? edge.registry!;
      if (edge.url) closureDependencies[name] = edge.url;
      else registryDependencies[name] = edge.registry!;
    }
    manifest[field] = rewritten;
  }
  const stripped = strippedFields.filter((field) => field in manifest);
  for (const field of stripped) delete manifest[field];
  return { manifest, closureDependencies, registryDependencies, stripped };
}

function copyPackage(source: string, destination: string) {
  cpSync(source, destination, {
    recursive: true,
    filter: (path) => !skippedCopies.has(basename(path)) || path === source,
  });
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(exportTargets);
}

export function exportSpecifiers(name: string, exports: unknown): string[] {
  if (typeof exports === "string" || Array.isArray(exports)) return [name];
  if (!isRecord(exports)) return [name];
  const keys = Object.keys(exports).filter((key) => key.startsWith("."));
  if (!keys.length) return [name];
  return keys
    .filter((key) => !key.includes("*"))
    .map((key) => (key === "." ? name : `${name}${key.slice(1)}`));
}

function bareName(specifier: string) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function isBuiltin(specifier: string) {
  if (specifier.startsWith("node:") || specifier === "bun" || specifier.startsWith("bun:"))
    return true;
  return builtinModules.includes(bareName(specifier));
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.js`,
    resolve(base, "index.ts"),
    resolve(base, "index.js"),
  ];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile());
}

const typeImportPattern = /\bfrom\s+["']([^"'./][^"']*)["']/g;
const staticUrlPattern = /new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;

interface ImportAudit {
  readonly files: string[];
  readonly typeOnlyUndeclared: string[];
}

interface ModuleScope {
  readonly name: string;
  readonly packageRoot: string;
  readonly declared: Set<string>;
  readonly typeOnly: Set<string>;
}

/** Check one packed module and return the packed relative modules it loads. */
function auditModule(file: string, scope: ModuleScope): string[] {
  const code = readFileSync(file, "utf8");
  const label = `${scope.name} ${relative(scope.packageRoot, file)}`;
  for (const match of code.matchAll(staticUrlPattern)) {
    assert.ok(resolveRelative(file, match[1]!), `${label} asset is not packed: ${match[1]}`);
  }
  const loader = extname(file).startsWith(".t") ? "ts" : "js";
  const runtime = new Bun.Transpiler({ loader }).scanImports(code).map((item) => item.path);
  const bare = runtime.filter((specifier) => !specifier.startsWith(".") && !isBuiltin(specifier));
  for (const specifier of bare) {
    assert.ok(scope.declared.has(bareName(specifier)), `${label} imports undeclared ${specifier}`);
  }
  for (const match of code.matchAll(typeImportPattern)) {
    const specifier = match[1]!;
    if (!isBuiltin(specifier) && !scope.declared.has(bareName(specifier)))
      scope.typeOnly.add(bareName(specifier));
  }
  return runtime
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => {
      const target = resolveRelative(file, specifier);
      assert.ok(target, `${label} imports an unpacked module: ${specifier}`);
      return target;
    });
}

/** Walk every exported module graph inside the extracted package. */
export function auditPackedImports(packageRoot: string, manifest: Json): ImportAudit {
  const name = String(manifest.name);
  const declared = new Set(
    dependencyFields
      .flatMap((field) => Object.keys(stringRecord(manifest[field], field)))
      .concat(name),
  );
  const pending = exportTargets(manifest.exports ?? manifest.main ?? "./index.js").map((target) => {
    const path = resolve(packageRoot, target);
    assert.ok(path.startsWith(packageRoot + sep), `${name} export escapes the package: ${target}`);
    assert.ok(existsSync(path), `${name} export target is not packed: ${target}`);
    return path;
  });
  const scope = { name, packageRoot, declared, typeOnly: new Set<string>() };
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file) || !sourceExtensions.has(extname(file))) continue;
    visited.add(file);
    pending.push(...auditModule(file, scope));
  }
  const typeOnlyUndeclared = Array.from(scope.typeOnly).toSorted();
  return { files: Array.from(visited), typeOnlyUndeclared };
}

function extract(archive: string, destination: string) {
  mkdirSync(destination, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", destination]);
  return resolve(destination, "package");
}

function assertLicense(packageRoot: string, name: string) {
  const licenses = readdirSync(packageRoot).filter((file) => /^(LICEN[CS]E|COPYING)/i.test(file));
  assert.ok(licenses.length, `${name} tarball has no root LICENSE`);
}

/** Every dependency spec in the packed manifest is a closure URL or a declared registry pin. */
function assertPackedEdges(packed: Json, expected: Json) {
  assert.deepEqual(
    packed,
    expected,
    `${String(expected.name)} packed package.json differs from staging`,
  );
  const text = JSON.stringify(dependencyFields.map((field) => packed[field] ?? {}));
  assert.ok(!text.includes("workspace:"), `${String(packed.name)} still has a workspace edge`);
}

interface StagedPackage {
  readonly entry: WorkspacePackage;
  readonly staged: string;
  readonly archive: string;
  readonly manifest: Json;
  readonly rewrite: ReturnType<typeof rewriteManifest>;
  readonly audit: ImportAudit;
  readonly artifacts: string[];
}

function stageAndPack(
  order: WorkspacePackage[],
  workspace: Map<string, WorkspacePackage>,
  urls: Map<string, string>,
  version: string,
  work: string,
  destination: string,
): StagedPackage[] {
  const stagingRoot = resolve(work, "packages");
  mkdirSync(destination, { recursive: true });
  return order.map((entry) => {
    const staged = resolve(stagingRoot, entry.directory);
    copyPackage(entry.root, staged);
    const rewrite = rewriteManifest(entry.manifest, version, { workspace, urls });
    writeFileSync(
      resolve(staged, "package.json"),
      `${JSON.stringify(rewrite.manifest, null, 2)}\n`,
    );
    const artifacts = existsSync(resolve(staged, "package-artifacts.json"))
      ? admitProgramPackage(staged)
      : [];
    const archive = resolve(destination, assetFilename(entry.name, version));
    execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--filename", archive], {
      cwd: staged,
      stdio: "pipe",
    });
    if (artifacts.length) verifyProgramTarball(staged, archive);
    const packed = extract(archive, resolve(work, "extracted", entry.directory));
    assertPackedEdges(readJson(resolve(packed, "package.json")), rewrite.manifest);
    assertLicense(packed, entry.name);
    const audit = auditPackedImports(packed, rewrite.manifest);
    return { entry, staged, archive, manifest: rewrite.manifest, rewrite, audit, artifacts };
  });
}

function closureUrls(order: WorkspacePackage[], version: string, base: string, runtimeUrl: string) {
  const urls = new Map<string, string>([[runtimePackageName, runtimeUrl]]);
  for (const entry of order) urls.set(entry.name, `${base}/${assetFilename(entry.name, version)}`);
  return urls;
}

function listTree(root: string, prefix = ""): string[] {
  return readdirSync(resolve(root, prefix), { withFileTypes: true }).flatMap((item) => {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    return item.isDirectory() ? listTree(root, path) : [path];
  });
}

/** The verification twin may differ from production only in the asset URLs in package.json. */
function assertTwin(
  production: StagedPackage,
  twin: StagedPackage,
  work: string,
  toProduction: (text: string) => string,
) {
  const left = extract(
    production.archive,
    resolve(work, "twin-compare", "production", production.entry.directory),
  );
  const right = extract(twin.archive, resolve(work, "twin-compare", "local", twin.entry.directory));
  const files = listTree(left).toSorted();
  assert.deepEqual(
    listTree(right).toSorted(),
    files,
    `${production.entry.name} twin file list differs`,
  );
  const label = production.entry.name;
  const manifest = readFileSync(resolve(right, "package.json"), "utf8");
  const expected = readFileSync(resolve(left, "package.json"), "utf8");
  assert.equal(toProduction(manifest), expected, `${label} twin manifest differs beyond URLs`);
  for (const file of files.filter((path) => path !== "package.json")) {
    const same = readFileSync(resolve(left, file)).equals(readFileSync(resolve(right, file)));
    assert.ok(same, `${label} twin differs: ${file}`);
  }
}

async function readRuntime(runtime: RuntimeAsset, work: string) {
  const bytes = runtime.tarball
    ? readFileSync(runtime.tarball)
    : new Uint8Array(await (await fetchOk(runtime.url)).arrayBuffer());
  assert.equal(sha256(bytes), runtime.sha256, `Runtime asset hash differs: ${runtime.url}`);
  const path = resolve(work, "runtime", basename(new URL(runtime.url).pathname));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  const manifest = readJson(
    resolve(extract(path, resolve(work, "runtime-extracted")), "package.json"),
  );
  assert.equal(manifest.name, runtimePackageName, "Runtime asset is not the waffle package");
  return { path, bytes: bytes.length, version: String(manifest.version) };
}

async function fetchOk(url: string) {
  const response = await fetch(url);
  assert.ok(response.ok, `GET ${url}: ${response.status}`);
  return response;
}

const consumerCheck = `
const specifiers = JSON.parse(process.argv[2]);
const imports = [];
const wasm = [];
function collect(specifier, value, depth) {
  if (value instanceof URL && value.pathname.endsWith(".wasm")) wasm.push({ specifier, path: Bun.fileURLToPath(value) });
  if (depth > 3 || value === null || typeof value !== "object" || value instanceof URL) return;
  for (const item of Array.isArray(value) ? value : Object.values(value)) collect(specifier, item, depth + 1);
}
for (const specifier of specifiers) {
  const module = await import(specifier);
  imports.push(specifier);
  collect(specifier, module, 0);
}
console.log(JSON.stringify({ imports, wasm }));
`;

function serve(directories: string[], requests: string[]) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      const name = path.slice(1);
      const directory = directories.find(
        (item) => !name.includes("/") && existsSync(resolve(item, name)),
      );
      if (!directory) return new Response("not a release asset", { status: 404 });
      return new Response(Bun.file(resolve(directory, name)));
    },
  });
}

function assertLockfile(consumer: string, urls: Map<string, string>) {
  const lock = Bun.JSONC.parse(readFileSync(resolve(consumer, "bun.lock"), "utf8")) as Json;
  const packages = lock.packages as Record<string, unknown[]>;
  for (const [name, url] of urls) {
    const resolution = packages[name]?.[0];
    assert.equal(resolution, `${name}@${url}`, `${name} did not install from its release asset`);
  }
  assert.ok(
    !JSON.stringify(lock).includes("workspace:"),
    "Installed lockfile kept a workspace edge",
  );
}

interface InstallInputs {
  readonly twins: StagedPackage[];
  readonly urls: Map<string, string>;
  readonly top: string[];
  readonly registry: string | undefined;
  readonly work: string;
  readonly requests: string[];
  readonly acceptance: string | undefined;
}

/** Real Bun install of the whole twin closure from the local server, then import every export. */
async function verifyInstall(inputs: InstallInputs): Promise<InstallReceipt> {
  const { twins, urls, top, registry, work } = inputs;
  const pinned = twins.flatMap((twin) => Object.keys(twin.rewrite.registryDependencies));
  assert.ok(registry || !pinned.length, `Registry edges need --registry: ${pinned.join(" ")}`);
  const consumer = resolve(work, "consumer");
  mkdirSync(consumer, { recursive: true });
  const names = top.concat(runtimePackageName);
  const dependencies = Object.fromEntries(names.map((name) => [name, urls.get(name)!]));
  const manifest = { name: "release-consumer", private: true, type: "module", dependencies };
  writeFileSync(resolve(consumer, "package.json"), JSON.stringify(manifest));
  writeFileSync(resolve(consumer, "check.ts"), consumerCheck);
  const env = {
    ...process.env,
    BUN_INSTALL_CACHE_DIR: resolve(work, "bun-cache"),
    BUN_CONFIG_REGISTRY: registry ?? unreachableRegistry,
    NPM_CONFIG_REGISTRY: registry ?? unreachableRegistry,
  };
  await run(["bun", "install"], consumer, env);
  assertLockfile(consumer, urls);
  const specifiers = twins.flatMap((twin) =>
    exportSpecifiers(String(twin.manifest.name), twin.manifest.exports),
  );
  const output = await run(["bun", "check.ts", JSON.stringify(specifiers)], consumer, env);
  const result = JSON.parse(output.trim().split("\n").at(-1)!) as ConsumerResult;
  const modules = resolve(consumer, "node_modules") + sep;
  const wasm = result.wasm.map((item) => {
    assert.ok(item.path.startsWith(modules), `${item.specifier} wasm escapes node_modules`);
    const bytes = readFileSync(item.path);
    return {
      specifier: item.specifier,
      path: relative(consumer, item.path),
      sha256: sha256(bytes),
    };
  });
  const requests = inputs.requests.toSorted();
  const receipt = { registry: registry ?? "none", requests, imports: result.imports, wasm };
  if (!inputs.acceptance) return receipt;
  const acceptance = await runAcceptance(inputs.acceptance, consumer, Array.from(urls.keys()), env);
  return { ...receipt, acceptance };
}

/** Bundle the caller's program with every closure package external, so it runs on the installs. */
async function runAcceptance(
  script: string,
  consumer: string,
  names: string[],
  env: NodeJS.ProcessEnv,
) {
  const bundle = await Bun.build({
    entrypoints: [resolve(script)],
    outdir: consumer,
    naming: "acceptance.js",
    target: "bun",
    external: names.concat(names.map((name) => `${name}/*`)),
  });
  assert.ok(bundle.success, `Acceptance bundle failed: ${bundle.logs.join("\n")}`);
  const output = await run(["bun", "acceptance.js"], consumer, env);
  return { script: basename(script), output: output.trim().split("\n").at(-1) ?? "" };
}

interface ConsumerResult {
  readonly imports: string[];
  readonly wasm: { specifier: string; path: string }[];
}

async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}\n${stdout}\n${stderr}`);
  return stdout;
}

/** Every exported program wasm must be the admitted artifact; every admitted wasm must be reachable. */
function assertWasmReachable(receipt: InstallReceipt, staged: StagedPackage[]) {
  for (const item of staged) {
    const prefix = `node_modules/${item.entry.name}/`;
    const expected = new Map(
      item.artifacts
        .filter((file) => file.endsWith(".wasm"))
        .map((file) => [file, sha256(readFileSync(resolve(item.staged, file)))]),
    );
    const seen = receipt.wasm.filter((wasm) => wasm.path.startsWith(prefix));
    for (const wasm of seen) {
      const file = wasm.path.slice(prefix.length);
      assert.equal(
        wasm.sha256,
        expected.get(file),
        `${item.entry.name} exported ${file} is not the admitted artifact`,
      );
    }
    const reached = new Set(seen.map((wasm) => wasm.path.slice(prefix.length)));
    if (!seen.length) continue;
    for (const file of expected.keys())
      assert.ok(reached.has(file), `${item.entry.name} ${file} is packed but not exported`);
  }
}

function sourceState(root: string, order: WorkspacePackage[], allowDirty: boolean) {
  const paths = order.map((entry) => `packages/${entry.directory}`).concat("tools", "scripts");
  const dirty = git(root, ["status", "--porcelain", "--"].concat(paths)) !== "";
  assert.ok(allowDirty || !dirty, `Release sources have uncommitted changes in ${paths.join(" ")}`);
  return { commit: git(root, ["rev-parse", "HEAD"]), dirty };
}

function artifactRecords(item: StagedPackage) {
  return item.artifacts.map((path) => {
    const bytes = readFileSync(resolve(item.staged, path));
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

function releasedPackage(
  item: StagedPackage,
  root: string,
  urls: Map<string, string>,
): ReleasedPackage {
  const bytes = readFileSync(item.archive);
  return {
    name: item.entry.name,
    sourceDirectory: `packages/${item.entry.directory}`,
    sourceTree: git(root, ["rev-parse", `HEAD:packages/${item.entry.directory}`]),
    sourceVersion: String(item.entry.manifest.version),
    version: String(item.manifest.version),
    filename: basename(item.archive),
    url: urls.get(item.entry.name)!,
    bytes: bytes.length,
    sha256: sha256(bytes),
    closureDependencies: item.rewrite.closureDependencies,
    registryDependencies: item.rewrite.registryDependencies,
    strippedFields: item.rewrite.stripped,
    typeOnlyUndeclared: item.audit.typeOnlyUndeclared,
    artifacts: artifactRecords(item),
  };
}

function prepareOutput(out: string) {
  assert.ok(
    !existsSync(out) || !readdirSync(out).length,
    `Release output must be new or empty: ${out}`,
  );
  mkdirSync(out, { recursive: true });
  return mkdtempSync(resolve(out, ".work-"));
}

function writeManifest(assets: string, manifest: ReleaseManifest) {
  writeFileSync(resolve(assets, "program-release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const sums = manifest.packages.map((item) => `${item.sha256}  ${item.filename}\n`).join("");
  writeFileSync(resolve(assets, "SHA256SUMS"), sums);
}

function replaceUrls(text: string, from: Map<string, string>, to: Map<string, string>) {
  return Array.from(from).reduce(
    (value, [name, url]) => value.replaceAll(url, to.get(name)!),
    text,
  );
}

interface Closure {
  readonly root: string;
  readonly workspace: Map<string, WorkspacePackage>;
  readonly order: WorkspacePackage[];
  readonly version: string;
  readonly work: string;
}

/** Pack a twin against the local server, prove it equals production up to URLs, install it. */
async function verifyClosure(
  closure: Closure,
  production: { staged: StagedPackage[]; urls: Map<string, string> },
  runtimePath: string,
  options: ReleaseOptions,
) {
  const { workspace, order, version, work } = closure;
  const twinAssets = resolve(work, "twin-assets");
  const requests: string[] = [];
  const server = serve([twinAssets, dirname(runtimePath)], requests);
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const runtimeUrl = `${origin}/${basename(runtimePath)}`;
    const urls = closureUrls(order, version, origin, runtimeUrl);
    const twinWork = resolve(work, "twin");
    const twins = stageAndPack(order, workspace, urls, version, twinWork, twinAssets);
    const toProduction = (text: string) => replaceUrls(text, urls, production.urls);
    production.staged.forEach((item, index) => assertTwin(item, twins[index]!, work, toProduction));
    const top = options.families.map((directory) => byDirectory(workspace, directory).name);
    const { registry, acceptance } = options;
    const inputs = { twins, urls, top, registry, work, requests, acceptance };
    return await verifyInstall(inputs);
  } finally {
    server.stop(true);
  }
}

/** Stage, pack and verify the closure. Writes assets, manifest and SHA256SUMS into `out/assets`. */
export async function buildRelease(options: ReleaseOptions): Promise<ReleaseManifest> {
  assert.equal(versionFromTag(options.tag), options.version, "Tag and release version differ");
  const root = resolve(options.root);
  const out = resolve(options.out);
  const workspace = loadWorkspace(root);
  const order = releaseOrder(workspace, options.families);
  const source = sourceState(root, order, options.allowDirty ?? false);
  const work = prepareOutput(out);
  try {
    const runtime = await readRuntime(options.runtime, work);
    const assetBase = options.assetBase.replace(/\/+$/, "");
    const urls = closureUrls(order, options.version, assetBase, options.runtime.url);
    assertUniqueFilenames(urls, options.runtime.url);
    const assets = resolve(out, "assets");
    const productionWork = resolve(work, "production");
    const staged = stageAndPack(order, workspace, urls, options.version, productionWork, assets);
    const closure = { root, workspace, order, version: options.version, work };
    const installCheck = await verifyClosure(closure, { staged, urls }, runtime.path, options);
    assertWasmReachable(installCheck, staged);
    const manifest: ReleaseManifest = {
      schema: "waffle-program-release/1",
      tag: options.tag,
      version: options.version,
      sourceCommit: source.commit,
      dirty: source.dirty,
      assetBase,
      runtime: {
        name: runtimePackageName,
        version: runtime.version,
        url: options.runtime.url,
        bytes: runtime.bytes,
        sha256: options.runtime.sha256,
      },
      order: order.map((entry) => entry.name),
      packages: staged.map((item) => releasedPackage(item, root, urls)),
      installCheck,
    };
    writeManifest(assets, manifest);
    return manifest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function assertUniqueFilenames(urls: Map<string, string>, runtimeUrl: string) {
  const names = Array.from(urls.values(), (url) => basename(new URL(url).pathname));
  assert.equal(
    new Set(names).size,
    names.length,
    `Release asset names collide: ${names.join(" ")}`,
  );
  assert.ok(
    runtimeUrl.startsWith("https://"),
    "The runtime peer must be an immutable https asset URL",
  );
}

const repositoryReleases = "https://github.com/ShaulLavo/waffle/releases/download";

function cliOptions(argv: string[]): ReleaseOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", default: resolve(import.meta.dirname, "..") },
      tag: { type: "string" },
      "asset-base": { type: "string" },
      "runtime-url": { type: "string" },
      "runtime-sha256": { type: "string" },
      "runtime-tarball": { type: "string" },
      families: { type: "string", default: "base" },
      out: { type: "string" },
      "allow-dirty": { type: "boolean", default: false },
      registry: { type: "string" },
      acceptance: { type: "string" },
    },
  });
  const { tag, out } = values;
  const runtimeUrl = values["runtime-url"];
  const runtimeSha256 = values["runtime-sha256"];
  assert.ok(tag && out && runtimeUrl && runtimeSha256, usage);
  return {
    root: values.root,
    tag,
    version: versionFromTag(tag),
    assetBase: values["asset-base"] ?? `${repositoryReleases}/${tag}`,
    runtime: { url: runtimeUrl, sha256: runtimeSha256, tarball: values["runtime-tarball"] },
    families: values.families.split(",").filter(Boolean),
    out,
    allowDirty: values["allow-dirty"],
    registry: values.registry,
    acceptance: values.acceptance,
  };
}

const usage = `Usage: bun scripts/program-release.ts --list [--families F]
       bun scripts/program-release.ts --tag programs-vX.Y.Z --out DIR \\
  --runtime-url URL --runtime-sha256 HEX [--runtime-tarball FILE] \\
  [--families base,python,git] [--asset-base URL] [--registry URL] [--acceptance FILE] [--allow-dirty]`;

/** `--list --families F` prints the dependency-ordered package directories to prepare. */
function listClosure(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      list: { type: "boolean" },
      root: { type: "string", default: resolve(import.meta.dirname, "..") },
      families: { type: "string", default: "base" },
    },
  });
  const families = values.families.split(",").filter(Boolean);
  for (const entry of releaseOrder(loadWorkspace(values.root), families))
    console.log(entry.directory);
}

if (import.meta.main && process.argv.includes("--list")) listClosure(process.argv.slice(2));
else if (import.meta.main) {
  const manifest = await buildRelease(cliOptions(process.argv.slice(2)));
  for (const item of manifest.packages) console.log(`${item.sha256}  ${item.bytes}  ${item.url}`);
}
