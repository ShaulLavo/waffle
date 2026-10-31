// Rebinds published program-family tarballs to a new runtime without rebuilding guests.
// The source release is admitted by its historical checker; only package.json is rewritten.
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
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { CommandCleanupError } from "../packages/waffle/scripts/owned-command.ts";
import {
  assertGuestsReached,
  assertTwin,
  assetFilename,
  auditPackedImports,
  versionFromTag,
  type Control,
  type ReleasedPackage,
  releaseAssetBase,
  replaceUrls,
  readRuntime,
  verifyInstall,
  runCommand,
  runtimePackageName,
  serve,
  type GuestReach,
  type InstallReceipt,
  type PackageArchive,
  type ReleaseManifest,
  type RebindMetadata,
  type RuntimeAsset,
  type HistoricalRuntimeManifestAsset,
} from "./program-release.ts";
import {
  assertExactHostInterface,
  assertWaffleFamilyManifest,
  parseHostInterface,
  readHostInterface,
  type HostInterface,
} from "../packages/waffle/tooling/host-interface.ts";

const defaultRepository = "ShaulLavo/waffle";
const defaultCommandTimeoutMs = 600_000;
const localCommandTimeoutMs = 60_000;
const dependencyFields = ["dependencies", "peerDependencies", "optionalDependencies"] as const;

type Json = Record<string, unknown>;

type SourcePackage = Omit<ReleasedPackage, "waffleHostInterface"> & {
  readonly waffleHostInterface?: HostInterface;
};
type DependencyField = (typeof dependencyFields)[number];
type SourceArtifact = SourcePackage["artifacts"][number];

type RebindOptions = {
  readonly root: string;
  readonly fromTag: string;
  readonly fromManifestSha256: string;
  readonly tag: string;
  readonly repository: string;
  readonly runtime: RuntimeAsset;
  readonly hostInterface: number;
  readonly historicalRoot: string;
  readonly runtimeSourceCommit?: string;
  readonly runtimePublished?: boolean;
  readonly acceptance?: string;
  readonly registry?: string;
  readonly out: string;
  readonly requireTag: boolean;
  readonly fromAssets?: string;
  readonly commandTimeoutMs: number;
  readonly signal?: AbortSignal;
};

type SourceBundle = {
  readonly schema: "waffle-program-release/1" | "waffle-program-release/2";
  readonly manifestPath: string;
  readonly manifest: Json;
  readonly packages: SourcePackage[];
};

type ReboundPackage = ReleaseManifest["packages"][number] & {
  readonly original: {
    readonly version: string;
    readonly filename: string;
    readonly url: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly changedFiles: ["package.json"];
  readonly manifestChanges: { path: string; from: string; to: string }[];
  readonly fileAccounting: { tracked: number; artifacts: number };
};

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): Json {
  assert.ok(isRecord(value), `${label} must be an object`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`${label} must be a number`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value.map((item, index) => stringValue(item, `${label}[${index}]`));
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const object = record(value, label);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(object))
    result[key] = stringValue(item, `${label}.${key}`);
  return result;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root].concat(args), {
    encoding: "utf8",
    timeout: localCommandTimeoutMs,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

function gitStatus(root: string): string {
  return git(root, ["status", "--porcelain"]);
}

function listTree(root: string, prefix = ""): string[] {
  return readdirSync(resolve(root, prefix), { withFileTypes: true }).flatMap((item) => {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) return listTree(root, path);
    assert.ok(item.isFile(), `Only regular package files are accepted: ${path}`);
    return [path];
  });
}

function extract(archive: string, destination: string): string {
  mkdirSync(destination, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", destination, "--strip-components=1"], {
    timeout: localCommandTimeoutMs,
  });
  return destination;
}

function archivePath(base: string, filename: string): string {
  const candidates = [resolve(base, "assets", filename), resolve(base, filename)];
  const path = candidates.find((candidate) => existsSync(candidate));
  assert.ok(path, `Missing source asset ${filename} in ${base}`);
  return path;
}

async function fetchBytes(url: string, signal: AbortSignal | undefined, timeoutMs: number) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const response = await fetch(url, { signal: combined });
  assert.ok(response.ok, `GET ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function readSourceAsset(
  base: string | undefined,
  filename: string,
  url: string,
  control: Control,
): Promise<{ path: string; bytes: Uint8Array }> {
  if (base) {
    const path = archivePath(base, filename);
    return { path, bytes: readFileSync(path) };
  }
  const bytes = await fetchBytes(url, control.signal, control.timeoutMs);
  return { path: "", bytes };
}

function parseArtifacts(value: unknown, label: string): SourceArtifact[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value.map((item, index) => {
    const artifact = record(item, `${label}[${index}]`);
    return {
      path: stringValue(artifact.path, `${label}[${index}].path`),
      bytes: numberValue(artifact.bytes, `${label}[${index}].bytes`),
      sha256: stringValue(artifact.sha256, `${label}[${index}].sha256`),
    };
  });
}

function parseGuests(value: unknown, label: string): GuestReach {
  const guests = record(value, label);
  return {
    descriptor: stringArray(guests.descriptor, `${label}.descriptor`),
    staticReference: stringArray(guests.staticReference, `${label}.staticReference`),
  };
}

function parsePackage(value: unknown, index: number): SourcePackage {
  const item = record(value, `packages[${index}]`);
  return {
    name: stringValue(item.name, `packages[${index}].name`),
    sourceDirectory: stringValue(item.sourceDirectory, `packages[${index}].sourceDirectory`),
    sourceTree: stringValue(item.sourceTree, `packages[${index}].sourceTree`),
    sourceVersion: stringValue(item.sourceVersion, `packages[${index}].sourceVersion`),
    version: stringValue(item.version, `packages[${index}].version`),
    filename: stringValue(item.filename, `packages[${index}].filename`),
    url: stringValue(item.url, `packages[${index}].url`),
    bytes: numberValue(item.bytes, `packages[${index}].bytes`),
    sha256: stringValue(item.sha256, `packages[${index}].sha256`),
    closureDependencies: stringMap(
      item.closureDependencies,
      `packages[${index}].closureDependencies`,
    ),
    registryDependencies: stringMap(
      item.registryDependencies,
      `packages[${index}].registryDependencies`,
    ),
    strippedFields: stringArray(item.strippedFields, `packages[${index}].strippedFields`),
    typeOnlyUndeclared: stringArray(
      item.typeOnlyUndeclared,
      `packages[${index}].typeOnlyUndeclared`,
    ),
    artifacts: parseArtifacts(item.artifacts, `packages[${index}].artifacts`),
    guests: parseGuests(item.guests, `packages[${index}].guests`),
  };
}

function parseSourceManifest(value: Json, fromTag: string, repository: string): SourceBundle {
  const schema = value.schema;
  assert.ok(
    schema === "waffle-program-release/1" || schema === "waffle-program-release/2",
    "Source manifest schema differs",
  );
  assert.equal(value.tag, fromTag, `Source manifest tag is not ${fromTag}`);
  const sourceVersion = stringValue(value.version, "Source manifest version");
  assert.equal(versionFromTag(fromTag), sourceVersion, "Source tag version differs");
  assert.equal(value.tagState, "tagged", "Source release must be tagged");
  assert.equal(value.dirty, false, "Source release must be clean");
  assert.match(stringValue(value.sourceCommit, "sourceCommit"), /^[a-f0-9]{40}$/);
  const assetBase = releaseAssetBase(repository, fromTag);
  assert.equal(value.assetBase, assetBase, "Source manifest asset base differs");
  const packageValues = value.packages;
  assert.ok(Array.isArray(packageValues), "Source manifest packages must be an array");
  const valueRuntime = value.runtime;
  const packages = packageValues.map((value, index) => {
    const item = parsePackage(value, index);
    if (schema === "waffle-program-release/1") return item;
    const metadata = record(value, `packages[${index}]`);
    const required = readHostInterface(metadata, item.name);
    const provided = readHostInterface(record(valueRuntime, "source runtime"), "source runtime");
    assertExactHostInterface(required, provided, item.name);
    return { ...item, waffleHostInterface: required };
  });
  const order = stringArray(value.order, "Source manifest order");
  assert.ok(packages.length, "Source release has no packages");
  assert.equal(new Set(order).size, order.length, "Duplicate source package");
  assert.deepEqual(
    order,
    packages.map((item) => item.name),
    "Source manifest order differs",
  );
  for (const item of packages) {
    assert.match(item.sourceDirectory, /^packages\/[a-z][a-z0-9-]*$/, "Unsafe source directory");
    assert.match(item.name, /^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/, "Unsafe package name");
    assert.equal(item.version, sourceVersion, `${item.name} source version differs`);
    assert.equal(item.filename, assetFilename(item.name, sourceVersion));
    assert.equal(item.url, `${assetBase}/${item.filename}`);
  }
  const manifestPath = `${assetBase}/program-release.json`;
  return {
    schema,
    manifestPath,
    manifest: value,
    packages,
  };
}

function expectedSums(packages: readonly SourcePackage[]): string {
  return packages.map((item) => `${item.sha256}  ${item.filename}\n`).join("");
}

async function loadSourceBundle(
  options: RebindOptions,
  control: Control,
  stagingRoot: string,
): Promise<SourceBundle> {
  const sourceBase = releaseAssetBase(options.repository, options.fromTag);
  const manifestAsset = await readSourceAsset(
    options.fromAssets,
    "program-release.json",
    `${sourceBase}/program-release.json`,
    control,
  );
  assert.equal(
    sha256(manifestAsset.bytes),
    options.fromManifestSha256,
    "Source manifest hash differs",
  );
  const source = parseSourceManifest(
    record(JSON.parse(new TextDecoder().decode(manifestAsset.bytes)), "source manifest"),
    options.fromTag,
    options.repository,
  );
  const sumsAsset = await readSourceAsset(
    options.fromAssets,
    "SHA256SUMS",
    `${sourceBase}/SHA256SUMS`,
    control,
  );
  const sums = new TextDecoder().decode(sumsAsset.bytes);
  assert.equal(sums, expectedSums(source.packages), "Source SHA256SUMS differs from the manifest");
  const packages: SourcePackage[] = [];
  for (const item of source.packages) {
    const asset = await readSourceAsset(
      options.fromAssets,
      item.filename,
      `${sourceBase}/${item.filename}`,
      control,
    );
    assert.equal(sha256(asset.bytes), item.sha256, `${item.name} source archive hash differs`);
    assert.equal(asset.bytes.length, item.bytes, `${item.name} source archive size differs`);
    const path = asset.path || resolve(stagingRoot, "source-assets", item.filename);
    if (!asset.path) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, asset.bytes);
    }
    packages.push(item);
  }
  return {
    ...source,
    manifestPath: `${sourceBase}/program-release.json`,
    packages,
  };
}

function sourceBlobSet(root: string, commit: string, sourceDirectory: string): Set<string> {
  const output = git(root, ["ls-tree", "-r", "--name-only", commit, `${sourceDirectory}/`]);
  return new Set(output ? output.split("\n") : []);
}

function assertSourceTree(root: string, source: SourceBundle): void {
  const sourceCommit = stringValue(source.manifest.sourceCommit, "Source manifest sourceCommit");
  assert.equal(git(root, ["rev-parse", "HEAD"]), sourceCommit, "Historical HEAD differs");
  assert.equal(gitStatus(root), "", "Historical root is dirty");
  const ancestor = spawnSync(
    "git",
    ["-C", root, "merge-base", "--is-ancestor", sourceCommit, "origin/main"],
    {
      encoding: "utf8",
      timeout: localCommandTimeoutMs,
    },
  );
  assert.equal(ancestor.status, 0, `${sourceCommit} is not an ancestor of origin/main`);
  for (const item of source.packages) {
    assert.equal(
      git(root, ["rev-parse", `HEAD:${item.sourceDirectory}`]),
      item.sourceTree,
      `${item.name} source tree differs`,
    );
  }
}

function assertHistoricalScript(root: string, path: string): void {
  const file = relative(resolve(root), resolve(path));
  assert.ok(
    file && !file.startsWith(`..${sep}`) && !file.startsWith(sep),
    "Historical script escapes its source root",
  );
  const original = execFileSync("git", ["-C", root, "show", `HEAD:${file}`], {
    timeout: localCommandTimeoutMs,
  });
  assert.deepEqual(readFileSync(path), original, `Historical script identity differs: ${file}`);
}

function targetTagState(root: string, tag: string, sourceCommit: string, requireTag: boolean) {
  const result = spawnSync(
    "git",
    ["-C", root, "rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`],
    { encoding: "utf8", timeout: localCommandTimeoutMs },
  );
  assert.ok(result.status === 0 || result.status === 1, `git rev-parse ${tag} failed`);
  const commit = result.status === 0 ? result.stdout.trim() : "";
  if (!commit) {
    assert.ok(!requireTag, `Release tag ${tag} does not exist`);
    return "untagged-candidate" as const;
  }
  assert.equal(commit, sourceCommit, `Tag ${tag} names ${commit}, not historical ${sourceCommit}`);
  return "tagged" as const;
}

function artifactByPath(item: SourcePackage): Map<string, SourceArtifact> {
  return new Map(item.artifacts.map((artifact) => [artifact.path, artifact]));
}

function assertFileAccounting(
  historicalRoot: string,
  sourceCommit: string,
  item: SourcePackage,
  packageRoot: string,
): { tracked: number; artifacts: number } {
  const tracked = sourceBlobSet(historicalRoot, sourceCommit, item.sourceDirectory);
  const artifacts = artifactByPath(item);
  const files = listTree(packageRoot);
  assert.ok(files.includes("package.json"), `${item.name} has no package.json`);
  let trackedCount = 0;
  let artifactCount = 0;
  for (const path of files) {
    if (path === "package.json") continue;
    const sourcePath = `${item.sourceDirectory}/${path}`;
    const local = readFileSync(resolve(packageRoot, path));
    if (tracked.has(sourcePath)) {
      assert.deepEqual(
        local,
        execFileSync("git", ["-C", historicalRoot, "show", `${sourceCommit}:${sourcePath}`], {
          maxBuffer: 16 * 1024 * 1024,
          timeout: localCommandTimeoutMs,
        }),
        `${item.name} changed tracked ${path}`,
      );
      trackedCount++;
      continue;
    }
    const artifact = artifacts.get(path);
    assert.ok(artifact, `${item.name} has unexplained file ${path}`);
    assert.equal(local.length, artifact.bytes, `${item.name} artifact size differs: ${path}`);
    assert.equal(sha256(local), artifact.sha256, `${item.name} artifact hash differs: ${path}`);
    artifactCount++;
  }
  for (const artifact of artifacts.values()) {
    assert.ok(files.includes(artifact.path), `${item.name} is missing artifact ${artifact.path}`);
    const bytes = readFileSync(resolve(packageRoot, artifact.path));
    assert.equal(
      bytes.length,
      artifact.bytes,
      `${item.name} artifact size differs: ${artifact.path}`,
    );
    assert.equal(
      sha256(bytes),
      artifact.sha256,
      `${item.name} artifact hash differs: ${artifact.path}`,
    );
  }
  return { tracked: trackedCount, artifacts: artifactCount };
}

async function identityRepack(
  packageRoot: string,
  item: SourcePackage,
  work: string,
  control: Control,
) {
  const destination = resolve(work, "identity", item.sourceDirectory, item.filename);
  mkdirSync(dirname(destination), { recursive: true });
  await runCommand(
    ["bun", "pm", "pack", "--quiet", "--ignore-scripts", "--filename", destination],
    packageRoot,
    process.env,
    control,
  );
  assert.equal(
    sha256(readFileSync(destination)),
    item.sha256,
    `${item.name} identity repack differs`,
  );
}

async function historicalAdmission(historicalRoot: string, packageRoot: string, control: Control) {
  if (!existsSync(resolve(packageRoot, "package-artifacts.json"))) return;
  await runCommand(
    ["bun", resolve(historicalRoot, "tools/program-package.ts"), "check", packageRoot],
    packageRoot,
    process.env,
    control,
  );
}

function dependencyEntries(manifest: Json): [string, string][] {
  return dependencyFields.flatMap((field) =>
    Object.entries(stringMap(manifest[field], `${String(manifest.name)} ${field}`)),
  );
}

interface PublishedEdgeContext {
  readonly item: SourcePackage;
  readonly sourceSchema: SourceBundle["schema"];
  readonly originalUrls: Map<string, string>;
  readonly urls: Map<string, string>;
}

function rewritePublishedEdges(
  source: Json,
  field: DependencyField,
  context: PublishedEdgeContext,
) {
  const { item, originalUrls, urls, sourceSchema } = context;
  const dependencies = stringMap(source[field], `${item.name} ${field}`);
  const rewritten: Record<string, string> = {};
  for (const [name, spec] of Object.entries(dependencies)) {
    if (name === runtimePackageName) {
      const expected = sourceSchema === "waffle-program-release/1" ? originalUrls.get(name) : "*";
      assert.equal(spec, expected, `${item.name} historical Waffle edge differs: ${field}.${name}`);
      continue;
    }
    const expected = originalUrls.get(name) ?? item.registryDependencies[name];
    assert.equal(spec, expected, `${item.name} original edge differs: ${field}.${name}`);
    rewritten[name] = urls.get(name) ?? spec;
  }
  return rewritten;
}

function rewritePublishedManifest(
  source: Json,
  item: SourcePackage,
  bundle: SourceBundle,
  version: string,
  urls: Map<string, string>,
  targetHostInterface: HostInterface,
): Json {
  assert.equal(source.name, item.name, "Original package name differs");
  assert.equal(source.version, item.version, "Original package version differs");
  if (bundle.schema === "waffle-program-release/2") {
    const required = assertWaffleFamilyManifest(source, item.name);
    assertExactHostInterface(required, targetHostInterface, item.name);
    assert.equal(required, item.waffleHostInterface, `${item.name} source metadata differs`);
  }
  if (
    bundle.schema === "waffle-program-release/1" &&
    Object.hasOwn(source, "waffleHostInterface")
  ) {
    assertExactHostInterface(readHostInterface(source, item.name), targetHostInterface, item.name);
  }
  const originalRuntime = manifestRuntime(bundle.manifest.runtime, "source runtime").url;
  const originalUrls = new Map(bundle.packages.map((entry) => [entry.name, entry.url]));
  originalUrls.set(runtimePackageName, originalRuntime);
  const runtimeEdges = dependencyEntries(source).filter(([name]) => name === runtimePackageName);
  assert.ok(
    runtimeEdges.length,
    `${item.name} historical package has no exact Waffle runtime edge`,
  );
  const context = { item, sourceSchema: bundle.schema, originalUrls, urls };
  const manifest: Json = { ...source, version, waffleHostInterface: targetHostInterface };
  for (const field of dependencyFields) {
    const rewritten = rewritePublishedEdges(source, field, context);
    if (Object.keys(rewritten).length) manifest[field] = rewritten;
    else delete manifest[field];
  }
  const peerDependencies = stringMap(manifest.peerDependencies, `${item.name} peerDependencies`);
  peerDependencies[runtimePackageName] = "*";
  manifest.peerDependencies = peerDependencies;
  return manifest;
}

function canonicalManifest(text: string, label: string): Json {
  const parsed: unknown = JSON.parse(text);
  const value = record(parsed, label);
  assert.equal(text, `${JSON.stringify(value, null, 2)}\n`, `${label} is not canonical JSON`);
  return value;
}

function dependencyChanges(before: Json, after: Json, field: DependencyField) {
  const oldValues = stringMap(before[field], `${String(before.name)} ${field}`);
  const newValues = stringMap(after[field], `${String(after.name)} ${field}`);
  const nonRuntimeKeys = (values: Record<string, string>) =>
    Object.keys(values).filter((name) => name !== runtimePackageName);
  assert.deepEqual(
    nonRuntimeKeys(newValues),
    nonRuntimeKeys(oldValues),
    `${String(before.name)} changed dependency keys`,
  );
  const names = new Set(Object.keys(oldValues).concat(Object.keys(newValues)));
  return Array.from(names).flatMap((name) => {
    if (oldValues[name] === newValues[name]) return [];
    return [
      {
        path: `${field}.${name}`,
        from: oldValues[name] ?? "<missing>",
        to: newValues[name] ?? "<missing>",
      },
    ];
  });
}

function manifestChanges(before: Json, after: Json): { path: string; from: string; to: string }[] {
  const changes: { path: string; from: string; to: string }[] = [];
  const display = (value: unknown) => (value === undefined ? "<missing>" : JSON.stringify(value));
  if (before.version !== after.version) {
    changes.push({
      path: "version",
      from: stringValue(before.version, "version"),
      to: stringValue(after.version, "version"),
    });
  }
  if (before.waffleHostInterface !== after.waffleHostInterface) {
    changes.push({
      path: "waffleHostInterface",
      from: display(before.waffleHostInterface),
      to: display(after.waffleHostInterface),
    });
  }
  return changes.concat(
    dependencyFields.flatMap((field) => dependencyChanges(before, after, field)),
  );
}

function assertOnlyPackageManifestChanged(
  original: string,
  rebound: string,
  item: SourcePackage,
  expected: Json,
) {
  const left = listTree(original).toSorted();
  const right = listTree(rebound).toSorted();
  assert.deepEqual(right, left, `${item.name} rebound file list differs`);
  assert.equal(
    readFileSync(resolve(rebound, "package.json"), "utf8"),
    `${JSON.stringify(expected, null, 2)}\n`,
    `${item.name} packed metadata differs`,
  );
  for (const file of left.filter((path) => path !== "package.json")) {
    assert.deepEqual(
      readFileSync(resolve(rebound, file)),
      readFileSync(resolve(original, file)),
      `${item.name} changed non-manifest file ${file}`,
    );
  }
}

function installedGuests(
  source: SourcePackage,
  receipt: InstallReceipt,
  consumer: string,
): GuestReach {
  const packageRoot = resolve(consumer, "node_modules", source.name);
  const manifest = canonicalManifest(
    readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    source.name,
  );
  const audit = auditPackedImports(packageRoot, manifest);
  assert.deepEqual(
    audit.typeOnlyUndeclared,
    source.typeOnlyUndeclared,
    `${source.name} import audit changed`,
  );
  for (const artifact of source.artifacts) {
    const bytes = readFileSync(resolve(packageRoot, artifact.path));
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(
      sha256(bytes),
      artifact.sha256,
      `${source.name} installed artifact differs: ${artifact.path}`,
    );
  }
  const expected = new Map(
    source.artifacts
      .filter((artifact) => artifact.path.endsWith(".wasm"))
      .map((artifact) => [artifact.path, artifact.sha256]),
  );
  const prefix = `node_modules/${source.name}/`;
  const descriptors = receipt.wasm
    .filter((item) => item.path.startsWith(prefix))
    .map((item) => ({ file: item.path.slice(prefix.length), sha256: item.sha256 }));
  return assertGuestsReached(source.name, expected, descriptors, audit.staticAssets);
}

function topPackages(packages: readonly SourcePackage[]): string[] {
  const referenced = new Set(packages.flatMap((item) => Object.keys(item.closureDependencies)));
  return packages.map((item) => item.name).filter((name) => !referenced.has(name));
}

function bunVersion(): string {
  return execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
}

function manifestRuntime(value: unknown, label: string): HistoricalRuntimeManifestAsset {
  const runtime = record(value, label);
  const metadata = {
    name: stringValue(runtime.name, `${label}.name`),
    version: stringValue(runtime.version, `${label}.version`),
    url: stringValue(runtime.url, `${label}.url`),
    bytes: numberValue(runtime.bytes, `${label}.bytes`),
    sha256: stringValue(runtime.sha256, `${label}.sha256`),
  };
  if (!Object.hasOwn(runtime, "waffleHostInterface")) return metadata;
  return { ...metadata, waffleHostInterface: readHostInterface(runtime, label) };
}

function toolState(root: string) {
  return { commit: git(root, ["rev-parse", "HEAD"]), dirty: gitStatus(root) !== "" };
}

function outputManifest(
  source: SourceBundle,
  options: RebindOptions,
  version: string,
  targetTagState: "tagged" | "untagged-candidate",
  runtime: Awaited<ReturnType<typeof readRuntime>>,
  rebound: ReboundPackage[],
  installCheck: InstallReceipt,
  historicalToolsTree: string,
  tool: { commit: string; dirty: boolean },
): ReleaseManifest {
  const sourceCommit = stringValue(source.manifest.sourceCommit, "Source manifest sourceCommit");
  const fromRuntime = manifestRuntime(
    record(source.manifest.runtime, "source runtime"),
    "source runtime",
  );
  const rebind: RebindMetadata = {
    hostInterface: runtime.hostInterface,
    from: {
      schema: source.schema,
      tag: options.fromTag,
      version: stringValue(source.manifest.version, "source version"),
      manifestUrl: source.manifestPath,
      manifestSha256: options.fromManifestSha256,
      sourceCommit,
      runtime: fromRuntime,
    },
    toolCommit: tool.commit,
    toolDirty: tool.dirty,
    bun: bunVersion(),
    historicalChecker: {
      commit: sourceCommit,
      toolsTree: historicalToolsTree,
      command: "bun tools/program-package.ts check",
    },
    acceptance: options.acceptance
      ? {
          script: relative(options.historicalRoot, options.acceptance),
          commit: sourceCommit,
          sha256: sha256(readFileSync(options.acceptance)),
        }
      : undefined,
    runtimeInput: {
      kind: options.runtime.tarball ? "local-artifact" : "published-download",
      provisional: Boolean(options.runtime.tarball) && !options.runtimePublished,
      sourceCommit: options.runtimeSourceCommit,
    },
  };
  const manifest: ReleaseManifest = {
    schema: "waffle-program-release/2",
    operation: "peer-rebind",
    tag: options.tag,
    version,
    sourceCommit,
    dirty: false,
    tagState: targetTagState,
    assetBase: releaseAssetBase(options.repository, options.tag),
    runtime: {
      name: runtimePackageName,
      version: runtime.version,
      waffleHostInterface: runtime.hostInterface,
      input: runtime.input,
      url: options.runtime.url,
      bytes: runtime.bytes,
      sha256: options.runtime.sha256,
    },
    rebind,
    order: rebound.map((item) => item.name),
    packages: rebound,
    installCheck,
  };
  return manifest;
}

function writeOutput(assets: string, manifest: ReleaseManifest) {
  writeFileSync(resolve(assets, "program-release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const sums = manifest.packages.map((item) => `${item.sha256}  ${item.filename}\n`).join("");
  writeFileSync(resolve(assets, "SHA256SUMS"), sums);
}

function assertOutputDirectory(out: string) {
  assert.ok(
    !existsSync(out) || readdirSync(out).length === 0,
    `Rebind output must be new or empty: ${out}`,
  );
  mkdirSync(out, { recursive: true });
}

interface RebindContext {
  readonly options: RebindOptions;
  readonly source: SourceBundle;
  readonly sourceCommit: string;
  readonly programVersion: string;
  readonly runtimeHostInterface: HostInterface;
  readonly urls: Map<string, string>;
  readonly assets: string;
  readonly work: string;
  readonly control: Control;
}

async function stageReboundPackage(
  context: RebindContext,
  item: SourcePackage,
): Promise<ReboundPackage> {
  const {
    options,
    source,
    sourceCommit,
    programVersion,
    runtimeHostInterface,
    urls,
    assets,
    work,
    control,
  } = context;
  const original = resolve(work, "original", item.sourceDirectory);
  const accounting = assertFileAccounting(options.historicalRoot, sourceCommit, item, original);
  await historicalAdmission(options.historicalRoot, original, control);
  await identityRepack(original, item, work, control);
  const originalText = readFileSync(resolve(original, "package.json"), "utf8");
  const sourceManifest = canonicalManifest(originalText, item.name);
  const rewritten = rewritePublishedManifest(
    sourceManifest,
    item,
    source,
    programVersion,
    urls,
    runtimeHostInterface,
  );
  const rewrittenHostInterface = assertWaffleFamilyManifest(rewritten, item.name);
  assertExactHostInterface(rewrittenHostInterface, runtimeHostInterface, item.name);
  const rewrittenText = `${JSON.stringify(rewritten, null, 2)}\n`;
  const changes = manifestChanges(sourceManifest, rewritten);
  assert.ok(changes.length > 0, `${item.name} has no metadata edge to rebind`);
  assert.ok(
    !rewrittenText.includes(`programs-v${item.version}`),
    `${item.name} kept its old program URL`,
  );
  const oldRuntime = manifestRuntime(source.manifest.runtime, "source runtime").url;
  assert.ok(!rewrittenText.includes(oldRuntime), `${item.name} kept its old runtime URL`);
  assert.ok(
    !rewrittenText.includes(`"version": "${item.version}"`),
    `${item.name} kept its old version`,
  );
  const staged = resolve(work, "rewritten", item.sourceDirectory);
  mkdirSync(dirname(staged), { recursive: true });
  cpSync(original, staged, { recursive: true });
  writeFileSync(resolve(staged, "package.json"), rewrittenText);
  const archive = resolve(assets, assetFilename(item.name, programVersion));
  await runCommand(
    ["bun", "pm", "pack", "--quiet", "--ignore-scripts", "--filename", archive],
    staged,
    process.env,
    control,
  );
  const reboundRoot = extract(archive, resolve(work, "rebound", item.sourceDirectory));
  assertOnlyPackageManifestChanged(original, reboundRoot, item, rewritten);
  const bytes = readFileSync(archive);
  const reboundPackage: ReboundPackage = {
    name: item.name,
    sourceDirectory: item.sourceDirectory,
    sourceTree: item.sourceTree,
    sourceVersion: item.sourceVersion,
    version: programVersion,
    filename: basename(archive),
    url: urls.get(item.name)!,
    bytes: bytes.length,
    sha256: sha256(bytes),
    waffleHostInterface: runtimeHostInterface,
    closureDependencies: Object.fromEntries(
      dependencyEntries(rewritten).filter(
        ([name]) => name !== runtimePackageName && urls.has(name),
      ),
    ),
    registryDependencies: Object.fromEntries(
      dependencyEntries(rewritten).filter(
        ([name]) => name !== runtimePackageName && !urls.has(name),
      ),
    ),
    strippedFields: item.strippedFields,
    typeOnlyUndeclared: item.typeOnlyUndeclared,
    artifacts: item.artifacts,
    guests: item.guests,
    original: {
      version: item.version,
      filename: item.filename,
      url: item.url,
      bytes: item.bytes,
      sha256: item.sha256,
    },
    changedFiles: ["package.json"],
    manifestChanges: changes,
    fileAccounting: accounting,
  };
  return reboundPackage;
}

async function verifyReboundClosure(
  context: RebindContext,
  rebound: ReboundPackage[],
  runtime: Awaited<ReturnType<typeof readRuntime>>,
): Promise<InstallReceipt> {
  const { options, source, urls, assets, work, control } = context;
  const requests: string[] = [];
  const twinAssets = resolve(work, "twin-assets");
  mkdirSync(twinAssets, { recursive: true });
  const server = serve([twinAssets, assets, dirname(runtime.path)], requests);
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const localRuntimeUrl = `${origin}/${basename(runtime.path)}`;
    const localUrls = new Map<string, string>([[runtimePackageName, localRuntimeUrl]]);
    for (const item of rebound) localUrls.set(item.name, `${origin}/${item.filename}`);
    const twins: PackageArchive[] = [];
    for (const item of rebound) {
      const productionRoot = extract(
        itemArchivePath(assets, item),
        resolve(work, "twin-source", item.name),
      );
      const localRoot = resolve(work, "twins", item.name);
      mkdirSync(dirname(localRoot), { recursive: true });
      cpSync(productionRoot, localRoot, { recursive: true });
      const text = readFileSync(resolve(localRoot, "package.json"), "utf8");
      writeFileSync(resolve(localRoot, "package.json"), replaceUrls(text, urls, localUrls));
      const archive = resolve(twinAssets, item.filename);
      await runCommand(
        ["bun", "pm", "pack", "--quiet", "--ignore-scripts", "--filename", archive],
        localRoot,
        process.env,
        control,
      );
      const manifest = canonicalManifest(
        readFileSync(resolve(localRoot, "package.json"), "utf8"),
        item.name,
      );
      const production = {
        name: item.name,
        manifest: rewrittenManifestFor(item, assets),
        archive: itemArchivePath(assets, item),
      };
      const twin = { name: item.name, manifest, archive };
      assertTwin(production, twin, work, (value) => replaceUrls(value, localUrls, urls));
      twins.push(twin);
    }
    const installCheck = await verifyInstall({
      twins,
      urls: localUrls,
      top: topPackages(source.packages),
      registry: options.registry,
      work,
      requests,
      acceptance: options.acceptance,
      runtimeVersion: runtime.version,
      runtimeHostInterface: runtime.hostInterface,
      control,
    });
    for (const sourcePackage of source.packages) {
      const actual = installedGuests(sourcePackage, installCheck, resolve(work, "consumer"));
      assert.deepEqual(actual, sourcePackage.guests, `${sourcePackage.name} guest reach changed`);
    }
    return installCheck;
  } finally {
    server.stop(true);
  }
}

async function buildRebind(options: RebindOptions): Promise<ReleaseManifest> {
  const control = { signal: options.signal, timeoutMs: options.commandTimeoutMs };
  assertOutputDirectory(options.out);
  const work = mkdtempSync(resolve(options.out, ".work-"));
  let retained = false;
  try {
    const requiredHostInterface = parseHostInterface(options.hostInterface, "rebind requirement");
    const source = await loadSourceBundle(options, control, work);
    if (source.schema === "waffle-program-release/1") {
      assert.ok(options.acceptance, "Schema-1 migration requires historical --acceptance");
    }
    const sourceCommit = stringValue(source.manifest.sourceCommit, "Source manifest sourceCommit");
    const programVersion = versionFromTag(options.tag);
    assert.notEqual(options.tag, options.fromTag, "Rebind must have a new program tag");
    assertSourceTree(resolve(options.historicalRoot), source);
    assertHistoricalScript(
      options.historicalRoot,
      resolve(options.historicalRoot, "tools/program-package.ts"),
    );
    if (options.acceptance) assertHistoricalScript(options.historicalRoot, options.acceptance);
    const tagState = targetTagState(
      options.historicalRoot,
      options.tag,
      sourceCommit,
      options.requireTag,
    );
    assert.equal(
      targetTagState(options.historicalRoot, options.fromTag, sourceCommit, true),
      "tagged",
      "Original release tag identity differs",
    );
    const runtime = await readRuntime(options.runtime, options.repository, work, control);
    assertExactHostInterface(requiredHostInterface, runtime.hostInterface, "rebind requirement");
    assert.ok(
      runtime.input.kind !== "local-candidate" || !options.runtimePublished,
      "A local runtime candidate cannot be marked published",
    );
    const assetBase = releaseAssetBase(options.repository, options.tag);
    const urls = new Map<string, string>([[runtimePackageName, options.runtime.url]]);
    for (const item of source.packages)
      urls.set(item.name, `${assetBase}/${assetFilename(item.name, programVersion)}`);
    const assets = resolve(options.out, "assets");
    mkdirSync(assets, { recursive: true });
    const rebound: ReboundPackage[] = [];
    for (const item of source.packages) {
      const sourceArchive = archivePath(
        options.fromAssets ?? resolve(work, "source-assets"),
        item.filename,
      );
      extract(sourceArchive, resolve(work, "original", item.sourceDirectory));
    }
    const context = {
      options,
      source,
      sourceCommit,
      programVersion,
      runtimeHostInterface: runtime.hostInterface,
      urls,
      assets,
      work,
      control,
    };
    for (const item of source.packages) rebound.push(await stageReboundPackage(context, item));
    const installCheck = await verifyReboundClosure(context, rebound, runtime);
    const tool = toolState(resolve(options.root));
    const historicalToolsTree = git(options.historicalRoot, ["rev-parse", `HEAD:tools`]);
    const manifest = outputManifest(
      source,
      options,
      programVersion,
      tagState,
      runtime,
      rebound,
      installCheck,
      historicalToolsTree,
      tool,
    );
    writeOutput(assets, manifest);
    return manifest;
  } catch (error) {
    retained = error instanceof CommandCleanupError;
    if (error instanceof CommandCleanupError)
      throw new CommandCleanupError(`${error.message}; retained ${work}`);
    throw error;
  } finally {
    if (!retained) rmSync(work, { recursive: true, force: true });
  }
}

function itemArchivePath(assets: string, item: { filename: string }): string {
  const path = resolve(assets, item.filename);
  assert.ok(existsSync(path), `Missing rebound archive ${item.filename}`);
  return path;
}

function rewrittenManifestFor(item: ReboundPackage, assets: string): Json {
  return canonicalManifest(
    execFileSync("tar", ["-xzOf", itemArchivePath(assets, item), "package/package.json"], {
      encoding: "utf8",
    }),
    item.name,
  );
}

function cliHostInterface(value: string | undefined): HostInterface {
  assert.ok(value && /^[1-9][0-9]*$/.test(value), "Use --host-interface <positive safe integer>");
  return parseHostInterface(Number(value), "rebind requirement");
}

function cliOptions(argv: string[]): RebindOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", default: resolve(import.meta.dirname, "..") },
      "from-tag": { type: "string" },
      "from-manifest-sha256": { type: "string" },
      tag: { type: "string" },
      repository: { type: "string", default: defaultRepository },
      "runtime-url": { type: "string" },
      "runtime-sha256": { type: "string" },
      "runtime-tarball": { type: "string" },
      "runtime-candidate-source-commit": { type: "string" },
      "host-interface": { type: "string" },
      "runtime-source-commit": { type: "string" },
      "runtime-published": { type: "boolean", default: false },
      "historical-root": { type: "string" },
      acceptance: { type: "string" },
      registry: { type: "string" },
      out: { type: "string" },
      "from-assets": { type: "string" },
      "require-tag": { type: "boolean", default: false },
      "timeout-ms": { type: "string" },
    },
  });
  const fromTag = values["from-tag"];
  const fromManifestSha256 = values["from-manifest-sha256"];
  const tag = values.tag;
  const runtimeUrl = values["runtime-url"];
  const runtimeSha256 = values["runtime-sha256"];
  const historicalRoot = values["historical-root"];
  const out = values.out;
  assert.ok(
    fromTag && fromManifestSha256 && tag && runtimeUrl && runtimeSha256 && historicalRoot && out,
    usage,
  );
  return {
    root: values.root,
    fromTag,
    fromManifestSha256,
    tag,
    repository: values.repository,
    runtime: {
      url: runtimeUrl,
      sha256: runtimeSha256,
      tarball: values["runtime-tarball"],
      candidateSourceCommit: values["runtime-candidate-source-commit"],
    },
    hostInterface: cliHostInterface(values["host-interface"]),
    historicalRoot,
    runtimeSourceCommit: values["runtime-source-commit"],
    runtimePublished: values["runtime-published"],
    acceptance: values.acceptance,
    registry: values.registry,
    out,
    requireTag: values["require-tag"],
    fromAssets: values["from-assets"],
    commandTimeoutMs: values["timeout-ms"] ? Number(values["timeout-ms"]) : defaultCommandTimeoutMs,
  };
}

const usage = `Usage: bun scripts/program-rebind.ts --from-tag programs-vX.Y.Z \\
  --from-manifest-sha256 HEX --tag programs-vX.Y.Z --out DIR \\
  --runtime-url URL --runtime-sha256 HEX --runtime-tarball FILE \\
  --historical-root DIR [--from-assets DIR] [--registry URL] \\
  [--acceptance FILE] [--require-tag] [--timeout-ms MS]`;

async function main(argv: string[]) {
  const controller = new AbortController();
  for (const [name, code] of Object.entries({ SIGINT: 130, SIGTERM: 143 } as const)) {
    process.once(name, () => {
      process.exitCode = code;
      controller.abort(new Error(`Interrupted by ${name}`));
    });
  }
  try {
    const manifest = await buildRebind({ ...cliOptions(argv), signal: controller.signal });
    for (const item of manifest.packages) console.log(`${item.sha256}  ${item.bytes}  ${item.url}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason: unknown = controller.signal.reason;
    if (!(reason instanceof Error)) process.exitCode = 1;
    console.error(reason instanceof Error ? `${reason.message}: ${message}` : message);
  }
}

if (import.meta.main) await main(process.argv.slice(2));

export { buildRebind, type RebindOptions };
