// Stages, packs and verifies the GitHub release-tarball closure of the program families.
// Workspace edges become immutable release-asset URLs inside disposable staging copies only;
// the source checkout is never modified. See docs/program-release.md.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { CommandCleanupError, runOwned } from "../packages/waffle/scripts/owned-command.ts";
import { admitProgramPackage, verifyProgramTarball } from "../tools/program-package.ts";

export const runtimePackageName = "waffle";
const dependencyFields = ["dependencies", "peerDependencies", "optionalDependencies"] as const;
const strippedFields = ["devDependencies", "scripts", "workspaces"] as const;
const skippedCopies = new Set(["node_modules", ".build", "target", ".sources"]);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts"]);
const unreachableRegistry = "http://127.0.0.1:9/";
const defaultRepository = "ShaulLavo/waffle";
const defaultCommandTimeoutMs = 600_000;
const localCommandTimeoutMs = 60_000;

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
  /** GitHub `owner/name` whose per-tag releases hold the program and runtime assets. */
  readonly repository?: string;
  readonly runtime: RuntimeAsset;
  /** Top-level packages by directory name; their workspace closure is released. */
  readonly families: readonly string[];
  readonly out: string;
  readonly allowDirty?: boolean;
  /** Registry for declared third-party edges. Absent means none may be fetched. */
  readonly registry?: string;
  /** Optional consumer program, bundled against the installed closure and run after install. */
  readonly acceptance?: string;
  /** Refuse an untagged candidate; the release workflow packs only an existing tag. */
  readonly requireTag?: boolean;
  /** Cancels fetches and terminates owned child process groups before staging is removed. */
  readonly signal?: AbortSignal;
  /** Deadline for each fetch and child command. */
  readonly commandTimeoutMs?: number;
}

export interface Control {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
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
  /** How each admitted guest is reached: an exported program descriptor, or a static asset URL. */
  readonly guests: GuestReach;
  readonly original?: {
    readonly version: string;
    readonly filename: string;
    readonly url: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly changedFiles?: string[];
  readonly manifestChanges?: { path: string; from: string; to: string }[];
  readonly fileAccounting?: { tracked: number; artifacts: number };
}

export interface GuestReach {
  readonly descriptor: string[];
  readonly staticReference: string[];
}

export interface RebindMetadata {
  readonly from: {
    readonly tag: string;
    readonly version: string;
    readonly manifestUrl: string;
    readonly manifestSha256: string;
    readonly sourceCommit: string;
    readonly runtime: RuntimeManifestAsset;
  };
  readonly toolCommit: string;
  readonly toolDirty: boolean;
  readonly bun: string;
  readonly historicalChecker: {
    readonly commit: string;
    readonly toolsTree: string;
    readonly command: string;
  };
  readonly acceptance?: { script: string; commit: string; sha256: string };
  readonly runtimeInput: {
    kind: "local-artifact" | "published-download";
    provisional: boolean;
    sourceCommit?: string;
  };
}

export interface RuntimeManifestAsset {
  readonly name: string;
  readonly version: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ReleaseManifest {
  readonly schema: "waffle-program-release/1";
  readonly operation: "release" | "peer-rebind";
  readonly tag: string;
  readonly version: string;
  readonly dirty: boolean;
  /** `tagged`: the tag names the packed commit. `untagged-candidate`: the tag does not exist yet. */
  readonly tagState: "tagged" | "untagged-candidate";
  readonly assetBase: string;
  readonly sourceCommit: string;
  readonly runtime: RuntimeManifestAsset;
  readonly rebind?: RebindMetadata;
  readonly order: string[];
  readonly packages: ReleasedPackage[];
  readonly installCheck: InstallReceipt;
}

export interface InstallReceipt {
  readonly registry: string;
  readonly requests: string[];
  readonly imports: string[];
  readonly wasm: { specifier: string; path: string; sha256: string }[];
  readonly runtimeRoots: number;
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
  const options = { encoding: "utf8", timeout: localCommandTimeoutMs } as const;
  return execFileSync("git", ["-C", root].concat(args), options).trim();
}

export function releaseAssetBase(repository: string, tag: string): string {
  assert.ok(/^[\w.-]+\/[\w.-]+$/.test(repository), `Not a GitHub owner/name: ${repository}`);
  return `https://github.com/${repository}/releases/download/${tag}`;
}

/** The runtime's own per-version release asset; mutable aliases and other tags are refused. */
export function runtimeReleaseUrl(repository: string, version: string): string {
  assert.ok(/^\d+\.\d+\.\d+$/.test(version), `Runtime version is not exact: ${version}`);
  return `${releaseAssetBase(repository, `waffle-v${version}`)}/waffle-${version}.tgz`;
}

function runtimeUrlVersion(url: string) {
  const match = /\/releases\/download\/waffle-v(\d+\.\d+\.\d+)\/waffle-\1\.tgz$/.exec(url);
  assert.ok(match?.[1], `Runtime URL is not a waffle-v<version> release asset: ${url}`);
  return match[1];
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
  /** Package-relative files named by literal `new URL(path, import.meta.url)` in exported code. */
  readonly staticAssets: string[];
}

interface ModuleScope {
  readonly name: string;
  readonly packageRoot: string;
  readonly declared: Set<string>;
  readonly typeOnly: Set<string>;
  readonly staticAssets: Set<string>;
}

/** Check one packed module and return the packed relative modules it loads. */
function auditModule(file: string, scope: ModuleScope): string[] {
  const code = readFileSync(file, "utf8");
  const label = `${scope.name} ${relative(scope.packageRoot, file)}`;
  for (const match of code.matchAll(staticUrlPattern)) {
    const asset = resolveRelative(file, match[1]!);
    assert.ok(asset, `${label} asset is not packed: ${match[1]}`);
    scope.staticAssets.add(relative(scope.packageRoot, asset).split(sep).join("/"));
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
  const scope = {
    name,
    packageRoot,
    declared,
    typeOnly: new Set<string>(),
    staticAssets: new Set<string>(),
  };
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file) || !sourceExtensions.has(extname(file))) continue;
    visited.add(file);
    pending.push(...auditModule(file, scope));
  }
  const typeOnlyUndeclared = Array.from(scope.typeOnly).toSorted();
  const staticAssets = Array.from(scope.staticAssets).toSorted();
  return { files: Array.from(visited), typeOnlyUndeclared, staticAssets };
}

function extract(archive: string, destination: string) {
  mkdirSync(destination, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", destination], { timeout: localCommandTimeoutMs });
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

interface PackPlan {
  readonly order: WorkspacePackage[];
  readonly workspace: Map<string, WorkspacePackage>;
  readonly urls: Map<string, string>;
  readonly version: string;
  readonly work: string;
  readonly destination: string;
}

async function stageAndPack(plan: PackPlan, control: Control): Promise<StagedPackage[]> {
  mkdirSync(plan.destination, { recursive: true });
  const staged: StagedPackage[] = [];
  for (const entry of plan.order) staged.push(await stageOne(entry, plan, control));
  return staged;
}

async function stageOne(entry: WorkspacePackage, plan: PackPlan, control: Control) {
  control.signal?.throwIfAborted();
  const { workspace, urls, version, work } = plan;
  const staged = resolve(work, "packages", entry.directory);
  copyPackage(entry.root, staged);
  const rewrite = rewriteManifest(entry.manifest, version, { workspace, urls });
  writeFileSync(resolve(staged, "package.json"), `${JSON.stringify(rewrite.manifest, null, 2)}\n`);
  const artifacts = existsSync(resolve(staged, "package-artifacts.json"))
    ? admitProgramPackage(staged)
    : [];
  const archive = resolve(plan.destination, assetFilename(entry.name, version));
  const pack = ["bun", "pm", "pack", "--quiet", "--ignore-scripts", "--filename", archive];
  await runCommand(pack, staged, process.env, control);
  if (artifacts.length) verifyProgramTarball(staged, archive);
  const packed = extract(archive, resolve(work, "extracted", entry.directory));
  assertPackedEdges(readJson(resolve(packed, "package.json")), rewrite.manifest);
  assertLicense(packed, entry.name);
  const audit = auditPackedImports(packed, rewrite.manifest);
  return { entry, staged, archive, manifest: rewrite.manifest, rewrite, audit, artifacts };
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
export interface PackageArchive {
  readonly name: string;
  readonly manifest: Json;
  readonly archive: string;
}

export function assertTwin(
  production: PackageArchive,
  twin: PackageArchive,
  work: string,
  toProduction: (text: string) => string,
) {
  const left = extract(
    production.archive,
    resolve(work, "twin-compare", "production", production.name),
  );
  const right = extract(twin.archive, resolve(work, "twin-compare", "local", twin.name));
  const files = listTree(left).toSorted();
  assert.deepEqual(listTree(right).toSorted(), files, `${production.name} twin file list differs`);
  const label = production.name;
  const manifest = readFileSync(resolve(right, "package.json"), "utf8");
  const expected = readFileSync(resolve(left, "package.json"), "utf8");
  assert.equal(toProduction(manifest), expected, `${label} twin manifest differs beyond URLs`);
  for (const file of files.filter((path) => path !== "package.json")) {
    const same = readFileSync(resolve(left, file)).equals(readFileSync(resolve(right, file)));
    assert.ok(same, `${label} twin differs: ${file}`);
  }
}

export async function readRuntime(
  runtime: RuntimeAsset,
  repository: string,
  work: string,
  control: Control,
) {
  const urlVersion = runtimeUrlVersion(runtime.url);
  assert.equal(runtime.url, runtimeReleaseUrl(repository, urlVersion), "Runtime URL is not ours");
  const bytes = runtime.tarball
    ? readFileSync(runtime.tarball)
    : new Uint8Array(await (await fetchOk(runtime.url, control)).arrayBuffer());
  assert.equal(sha256(bytes), runtime.sha256, `Runtime asset hash differs: ${runtime.url}`);
  const path = resolve(work, "runtime", basename(new URL(runtime.url).pathname));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  const manifest = readJson(
    resolve(extract(path, resolve(work, "runtime-extracted")), "package.json"),
  );
  assert.equal(manifest.name, runtimePackageName, "Runtime asset is not the waffle package");
  const version = String(manifest.version);
  assert.equal(version, urlVersion, `Runtime URL names ${urlVersion}, its package is ${version}`);
  return { path, bytes: bytes.length, version };
}

async function fetchOk(url: string, control: Control) {
  const deadline = AbortSignal.timeout(control.timeoutMs);
  const signal = control.signal ? AbortSignal.any([control.signal, deadline]) : deadline;
  const response = await fetch(url, { signal });
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
await Bun.write(process.argv[3], JSON.stringify({ imports, wasm }));
`;

export function serve(directories: string[], requests: string[]) {
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

export function assertLockfile(consumer: string, urls: Map<string, string>) {
  const lock = Bun.JSONC.parse(readFileSync(resolve(consumer, "bun.lock"), "utf8")) as Json;
  const packages = lock.packages as Record<string, unknown[]>;
  const runtimeEntries = Object.values(packages).filter(
    (entry) => typeof entry[0] === "string" && entry[0].startsWith(`${runtimePackageName}@`),
  );
  assert.equal(
    runtimeEntries.length,
    1,
    `Expected one waffle lock entry, found ${runtimeEntries.length}`,
  );
  for (const [name, url] of urls) {
    const resolution = packages[name]?.[0];
    assert.equal(resolution, `${name}@${url}`, `${name} did not install from its release asset`);
  }
  assert.ok(
    !JSON.stringify(lock).includes("workspace:"),
    "Installed lockfile kept a workspace edge",
  );
}

function declaredRegistryDependencies(manifest: Json): string[] {
  const values: string[] = [];
  for (const field of dependencyFields) {
    for (const [name, spec] of Object.entries(
      stringRecord(manifest[field], `${String(manifest.name)} ${field}`),
    )) {
      if (name === runtimePackageName) continue;
      if (/^https?:\/\//.test(spec)) continue;
      values.push(`${name}@${spec}`);
    }
  }
  return values;
}

function packageArchive(item: StagedPackage): PackageArchive {
  return { name: item.entry.name, manifest: item.manifest, archive: item.archive };
}

function physicalRuntimeRoots(consumer: string): string[] {
  const pending = [resolve(consumer, "node_modules")];
  const roots = new Set<string>();
  const visited = new Set<string>();
  while (pending.length) {
    const directory = pending.pop()!;
    const real = realpathSync(directory);
    if (visited.has(real)) continue;
    visited.add(real);
    const manifestPath = resolve(directory, "package.json");
    if (existsSync(manifestPath) && readJson(manifestPath).name === runtimePackageName)
      roots.add(real);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = resolve(directory, entry.name);
      if (statSync(child).isDirectory()) pending.push(child);
    }
  }
  return Array.from(roots).toSorted();
}

export function assertOnePhysicalRuntime(consumer: string, version: string): number {
  const roots = physicalRuntimeRoots(consumer);
  assert.equal(roots.length, 1, `Expected one physical waffle runtime, found ${roots.length}`);
  const manifest = readJson(resolve(roots[0]!, "package.json"));
  assert.equal(manifest.name, runtimePackageName, "Physical runtime has the wrong package name");
  assert.equal(manifest.version, version, `Physical waffle runtime is ${String(manifest.version)}`);
  return roots.length;
}

export interface InstallInputs {
  readonly twins: PackageArchive[];
  readonly urls: Map<string, string>;
  readonly top: string[];
  readonly registry: string | undefined;
  readonly work: string;
  readonly requests: string[];
  readonly acceptance: string | undefined;
  readonly runtimeVersion: string;
  readonly control: Control;
}

/** Real Bun install of the whole twin closure from the local server, then import every export. */
export async function verifyInstall(inputs: InstallInputs): Promise<InstallReceipt> {
  const { twins, urls, top, registry, work, control } = inputs;
  const pinned = twins.flatMap((twin) => declaredRegistryDependencies(twin.manifest));
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
  await runCommand(["bun", "install", "--ignore-scripts"], consumer, env, control);
  assertLockfile(consumer, urls);
  const runtimeRoots = assertOnePhysicalRuntime(consumer, inputs.runtimeVersion);
  const specifiers = twins.flatMap((twin) =>
    exportSpecifiers(String(twin.manifest.name), twin.manifest.exports),
  );
  const resultPath = resolve(consumer, "check.json");
  const check = ["bun", "check.ts", JSON.stringify(specifiers), resultPath];
  await runCommand(check, consumer, env, control);
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as ConsumerResult;
  const consumerRoot = realpathSync(consumer);
  const modules = realpathSync(resolve(consumerRoot, "node_modules")) + sep;
  const wasm = result.wasm.map((item) => {
    assert.ok(item.path.startsWith(modules), `${item.specifier} wasm escapes node_modules`);
    const bytes = readFileSync(item.path);
    return {
      specifier: item.specifier,
      path: relative(consumerRoot, item.path),
      sha256: sha256(bytes),
    };
  });
  const requests = inputs.requests.toSorted();
  const receipt = {
    registry: registry ?? "none",
    requests,
    imports: result.imports,
    wasm,
    runtimeRoots,
  };
  if (!inputs.acceptance) return receipt;
  const external = Array.from(urls.keys());
  const acceptance = await runAcceptance(inputs.acceptance, consumer, external, env, control);
  return { ...receipt, acceptance };
}

/** Bundle the caller's program with every closure package external, so it runs on the installs. */
export async function runAcceptance(
  script: string,
  consumer: string,
  names: string[],
  env: NodeJS.ProcessEnv,
  control: Control,
) {
  const bundle = await Bun.build({
    entrypoints: [resolve(script)],
    outdir: consumer,
    naming: "acceptance.js",
    target: "bun",
    external: names.concat(names.map((name) => `${name}/*`)),
  });
  assert.ok(bundle.success, `Acceptance bundle failed: ${bundle.logs.join("\n")}`);
  // exec keeps the program as the owned group leader; its stdout lands in a file we read back.
  const command = ["sh", "-c", "exec bun acceptance.js > acceptance.out"];
  await runCommand(command, consumer, env, control);
  const output = readFileSync(resolve(consumer, "acceptance.out"), "utf8");
  return { script: basename(script), output: output.trim().split("\n").at(-1) ?? "" };
}

interface ConsumerResult {
  readonly imports: string[];
  readonly wasm: { specifier: string; path: string }[];
}

/** Each child owns a process group with a deadline; abort or timeout retires the whole group. */
export function runCommand(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  control: Control,
) {
  return runOwned(command, { cwd, env, signal: control.signal, timeoutMs: control.timeoutMs });
}

/**
 * Every exported descriptor wasm must be the admitted artifact, and every admitted wasm must be
 * reached: by an exported program descriptor, or by a literal asset URL in exported code.
 */
export function assertGuestsReached(
  name: string,
  expected: Map<string, string>,
  descriptors: { file: string; sha256: string }[],
  staticAssets: readonly string[],
): GuestReach {
  for (const guest of descriptors) {
    const admitted = expected.get(guest.file);
    assert.equal(guest.sha256, admitted, `${name} exported ${guest.file} is not admitted`);
  }
  const descriptor = Array.from(new Set(descriptors.map((guest) => guest.file))).toSorted();
  const reached = new Set(descriptor);
  const staticReference = staticAssets.filter((file) => expected.has(file) && !reached.has(file));
  for (const file of staticReference) reached.add(file);
  const missing = Array.from(expected.keys()).filter((file) => !reached.has(file));
  assert.equal(missing.length, 0, `${name} packs guests no export reaches: ${missing.join(" ")}`);
  return { descriptor, staticReference };
}

function packageGuests(item: StagedPackage, receipt: InstallReceipt): GuestReach {
  const prefix = `node_modules/${item.entry.name}/`;
  const wasm = item.artifacts.filter((file) => file.endsWith(".wasm"));
  const expected = new Map(
    wasm.map((file) => [file, sha256(readFileSync(resolve(item.staged, file)))]),
  );
  const descriptors = receipt.wasm
    .filter((guest) => guest.path.startsWith(prefix))
    .map((guest) => ({ file: guest.path.slice(prefix.length), sha256: guest.sha256 }));
  return assertGuestsReached(item.entry.name, expected, descriptors, item.audit.staticAssets);
}

function sourceState(root: string, order: WorkspacePackage[], allowDirty: boolean) {
  const paths = order.map((entry) => `packages/${entry.directory}`).concat("tools", "scripts");
  const dirty = git(root, ["status", "--porcelain", "--"].concat(paths)) !== "";
  assert.ok(allowDirty || !dirty, `Release sources have uncommitted changes in ${paths.join(" ")}`);
  return { commit: git(root, ["rev-parse", "HEAD"]), dirty };
}

/** An existing tag must name exactly the packed, clean commit; otherwise this is a candidate. */
function tagState(
  root: string,
  tag: string,
  source: { commit: string; dirty: boolean },
  required: boolean,
) {
  const args = ["-C", root, "rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`];
  const result = spawnSync("git", args, { encoding: "utf8", timeout: localCommandTimeoutMs });
  assert.ok(result.status === 0 || result.status === 1, `git rev-parse ${tag} failed`);
  const tagged = result.status === 0 ? result.stdout.trim() : "";
  if (!tagged) {
    assert.ok(!required, `Release tag ${tag} does not exist`);
    return "untagged-candidate" as const;
  }
  assert.equal(tagged, source.commit, `Tag ${tag} names ${tagged}, not packed ${source.commit}`);
  assert.ok(!source.dirty, `Tagged release ${tag} has uncommitted source changes`);
  return "tagged" as const;
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
  receipt: InstallReceipt,
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
    guests: packageGuests(item, receipt),
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

export function replaceUrls(text: string, from: Map<string, string>, to: Map<string, string>) {
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
  readonly control: Control;
}

/** Pack a twin against the local server, prove it equals production up to URLs, install it. */
async function verifyClosure(
  closure: Closure,
  production: { staged: StagedPackage[]; urls: Map<string, string> },
  runtimePath: string,
  options: ReleaseOptions,
) {
  const { workspace, order, version, work, control } = closure;
  const twinAssets = resolve(work, "twin-assets");
  const requests: string[] = [];
  const server = serve([twinAssets, dirname(runtimePath)], requests);
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const runtimeUrl = `${origin}/${basename(runtimePath)}`;
    const urls = closureUrls(order, version, origin, runtimeUrl);
    const plan = { order, workspace, urls, version, work: resolve(work, "twin") };
    const twins = await stageAndPack({ ...plan, destination: twinAssets }, control);
    const toProduction = (text: string) => replaceUrls(text, urls, production.urls);
    production.staged.forEach((item, index) =>
      assertTwin(packageArchive(item), packageArchive(twins[index]!), work, toProduction),
    );
    const top = options.families.map((directory) => byDirectory(workspace, directory).name);
    const { registry, acceptance } = options;
    const inputs = {
      twins: twins.map(packageArchive),
      urls,
      top,
      registry,
      work,
      requests,
      acceptance,
      runtimeVersion: runtimeUrlVersion(options.runtime.url),
      control,
    };
    return await verifyInstall(inputs);
  } finally {
    server.stop(true);
  }
}

/** Stage, pack and verify the closure. Writes assets, manifest and SHA256SUMS into `out/assets`. */
export async function buildRelease(options: ReleaseOptions): Promise<ReleaseManifest> {
  assert.equal(versionFromTag(options.tag), options.version, "Tag and release version differ");
  const root = resolve(options.root);
  const repository = options.repository ?? defaultRepository;
  const assetBase = releaseAssetBase(repository, options.tag);
  const workspace = loadWorkspace(root);
  const order = releaseOrder(workspace, options.families);
  const source = sourceState(root, order, options.allowDirty ?? false);
  const tagged = tagState(root, options.tag, source, options.requireTag ?? false);
  const control = {
    signal: options.signal,
    timeoutMs: options.commandTimeoutMs ?? defaultCommandTimeoutMs,
  };
  const out = resolve(options.out);
  const work = prepareOutput(out);
  let retained = false;
  try {
    const runtime = await readRuntime(options.runtime, repository, work, control);
    const urls = closureUrls(order, options.version, assetBase, options.runtime.url);
    assertUniqueFilenames(urls);
    const assets = resolve(out, "assets");
    const plan = { order, workspace, urls, version: options.version };
    const productionWork = resolve(work, "production");
    const staged = await stageAndPack(
      { ...plan, work: productionWork, destination: assets },
      control,
    );
    const closure = { root, workspace, order, version: options.version, work, control };
    const installCheck = await verifyClosure(closure, { staged, urls }, runtime.path, options);
    const manifest: ReleaseManifest = {
      schema: "waffle-program-release/1",
      operation: "release",
      tag: options.tag,
      version: options.version,
      sourceCommit: source.commit,
      dirty: source.dirty,
      tagState: tagged,
      assetBase,
      runtime: {
        name: runtimePackageName,
        version: runtime.version,
        url: options.runtime.url,
        bytes: runtime.bytes,
        sha256: options.runtime.sha256,
      },
      order: order.map((entry) => entry.name),
      packages: staged.map((item) => releasedPackage(item, root, urls, installCheck)),
      installCheck,
    };
    writeManifest(assets, manifest);
    return manifest;
  } catch (error) {
    // A child group that would not die may still use its files: keep them and say so.
    retained = error instanceof CommandCleanupError;
    if (retained) throw new CommandCleanupError(`${(error as Error).message}; retained ${work}`);
    throw error;
  } finally {
    if (!retained) rmSync(work, { recursive: true, force: true });
  }
}

function assertUniqueFilenames(urls: Map<string, string>) {
  const names = Array.from(urls.values(), (url) => basename(new URL(url).pathname));
  assert.equal(
    new Set(names).size,
    names.length,
    `Release asset names collide: ${names.join(" ")}`,
  );
}

function cliOptions(argv: string[]): ReleaseOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", default: resolve(import.meta.dirname, "..") },
      tag: { type: "string" },
      repository: { type: "string", default: defaultRepository },
      "runtime-url": { type: "string" },
      "runtime-sha256": { type: "string" },
      "runtime-tarball": { type: "string" },
      families: { type: "string", default: "base" },
      out: { type: "string" },
      "allow-dirty": { type: "boolean", default: false },
      registry: { type: "string" },
      acceptance: { type: "string" },
      "require-tag": { type: "boolean", default: false },
      "timeout-ms": { type: "string" },
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
    repository: values.repository,
    runtime: { url: runtimeUrl, sha256: runtimeSha256, tarball: values["runtime-tarball"] },
    families: values.families.split(",").filter(Boolean),
    out,
    allowDirty: values["allow-dirty"],
    registry: values.registry,
    acceptance: values.acceptance,
    requireTag: values["require-tag"],
    commandTimeoutMs: values["timeout-ms"] ? Number(values["timeout-ms"]) : undefined,
  };
}

const usage = `Usage: bun scripts/program-release.ts --list [--families F]
       bun scripts/program-release.ts --tag programs-vX.Y.Z --out DIR \\
  --runtime-url URL --runtime-sha256 HEX [--runtime-tarball FILE] \\
  [--families base,python,git] [--repository OWNER/NAME] [--registry URL] \\
  [--acceptance FILE] [--require-tag] [--timeout-ms MS] [--allow-dirty]`;

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

const signalExitCodes = { SIGINT: 130, SIGTERM: 143 } as const;

/** SIGINT/SIGTERM abort the release: owned children are retired before staging is removed. */
async function main(argv: string[]) {
  const controller = new AbortController();
  for (const [name, code] of Object.entries(signalExitCodes)) {
    process.once(name, () => {
      process.exitCode = code;
      controller.abort(new Error(`Interrupted by ${name}`));
    });
  }
  try {
    const manifest = await buildRelease({ ...cliOptions(argv), signal: controller.signal });
    for (const item of manifest.packages) console.log(`${item.sha256}  ${item.bytes}  ${item.url}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason: unknown = controller.signal.reason;
    if (!(reason instanceof Error)) process.exitCode = 1;
    console.error(reason instanceof Error ? `${reason.message}: ${message}` : message);
  }
}

if (import.meta.main && process.argv.includes("--list")) listClosure(process.argv.slice(2));
else if (import.meta.main) await main(process.argv.slice(2));
