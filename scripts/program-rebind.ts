// Rebinds published program-family tarballs to a new runtime without rebuilding guests.
// The source release is admitted by its historical checker; only package.json is rewritten.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  assertGuestsReached,
  assertTwin,
  assetFilename,
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
  type RuntimeManifestAsset,
} from "./program-release.ts";

const defaultRepository = "ShaulLavo/waffle";
const defaultCommandTimeoutMs = 600_000;
const localCommandTimeoutMs = 60_000;
const dependencyFields = ["dependencies", "peerDependencies", "optionalDependencies"] as const;
const runtimeVersionPattern = /\/releases\/download\/waffle-v(\d+\.\d+\.\d+)\/waffle-\1\.tgz$/;

type Json = Record<string, unknown>;
type DependencyField = (typeof dependencyFields)[number];

type SourceArtifact = { path: string; bytes: number; sha256: string };
type SourcePackage = {
  name: string;
  sourceDirectory: string;
  sourceTree: string;
  sourceVersion: string;
  version: string;
  filename: string;
  url: string;
  bytes: number;
  sha256: string;
  closureDependencies: Record<string, string>;
  registryDependencies: Record<string, string>;
  strippedFields: string[];
  typeOnlyUndeclared: string[];
  artifacts: SourceArtifact[];
  guests: GuestReach;
};

type RebindOptions = {
  readonly root: string;
  readonly fromTag: string;
  readonly fromManifestSha256: string;
  readonly tag: string;
  readonly repository: string;
  readonly runtime: RuntimeAsset;
  readonly historicalRoot: string;
  readonly acceptance?: string;
  readonly registry?: string;
  readonly out: string;
  readonly requireTag: boolean;
  readonly fromAssets?: string;
  readonly commandTimeoutMs: number;
  readonly signal?: AbortSignal;
};

type SourceBundle = {
  readonly manifestPath: string;
  readonly manifestBytes: Uint8Array;
  readonly manifest: Json;
  readonly packages: SourcePackage[];
  readonly sums: string;
  readonly assetBase: string;
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
  }).trim();
}

function gitStatus(root: string): string {
  return git(root, ["status", "--porcelain"]);
}

function listTree(root: string, prefix = ""): string[] {
  return readdirSync(resolve(root, prefix), { withFileTypes: true }).flatMap((item) => {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    return item.isDirectory() ? listTree(root, path) : [path];
  });
}

function extract(archive: string, destination: string): string {
  mkdirSync(destination, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", destination], { timeout: localCommandTimeoutMs });
  const packageRoot = resolve(destination, "package");
  assert.ok(existsSync(packageRoot), `Archive has no package directory: ${archive}`);
  return packageRoot;
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
  control: { signal: AbortSignal | undefined; timeoutMs: number },
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
  assert.equal(value.schema, "waffle-program-release/1", "Source manifest schema differs");
  assert.equal(value.tag, fromTag, `Source manifest tag is not ${fromTag}`);
  const sourceVersion = stringValue(value.version, "Source manifest version");
  const assetBase = releaseAssetBase(repository, fromTag);
  assert.equal(value.assetBase, assetBase, "Source manifest asset base differs");
  const packageValues = value.packages;
  assert.ok(Array.isArray(packageValues), "Source manifest packages must be an array");
  const packages = packageValues.map(parsePackage);
  const order = stringArray(value.order, "Source manifest order");
  assert.deepEqual(
    order,
    packages.map((item) => item.name),
    "Source manifest order differs",
  );
  for (const item of packages) {
    assert.equal(item.version, sourceVersion, `${item.name} source version differs`);
    assert.equal(item.filename, assetFilename(item.name, sourceVersion));
    assert.equal(item.url, `${assetBase}/${item.filename}`);
  }
  const manifestPath = `${assetBase}/program-release.json`;
  const normalized = { ...value, sourceVersion };
  return {
    manifestPath,
    manifestBytes: new Uint8Array(),
    manifest: normalized,
    packages,
    sums: "",
    assetBase,
  };
}

function expectedSums(packages: readonly SourcePackage[]): string {
  return packages.map((item) => `${item.sha256}  ${item.filename}\n`).join("");
}

async function loadSourceBundle(
  options: RebindOptions,
  control: { signal: AbortSignal | undefined; timeoutMs: number },
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
    packages.push({ ...item, url: item.url });
  }
  return {
    ...source,
    manifestPath: `${sourceBase}/program-release.json`,
    manifestBytes: manifestAsset.bytes,
    sums,
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
        readFileSync(resolve(historicalRoot, sourcePath)),
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
  }
  assert.equal(
    trackedCount,
    tracked.size - (tracked.has(`${item.sourceDirectory}/package.json`) ? 1 : 0),
  );
  assert.equal(artifactCount, artifacts.size);
  return { tracked: trackedCount, artifacts: artifactCount };
}

async function identityRepack(
  packageRoot: string,
  item: SourcePackage,
  work: string,
  control: { signal: AbortSignal | undefined; timeoutMs: number },
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

async function historicalAdmission(
  historicalRoot: string,
  packageRoot: string,
  control: { signal: AbortSignal | undefined; timeoutMs: number },
) {
  if (!existsSync(resolve(packageRoot, "package-artifacts.json"))) return;
  await runCommand(
    ["bun", resolve(historicalRoot, "tools/program-package.ts"), "check", packageRoot],
    historicalRoot,
    process.env,
    control,
  );
}

function dependencyEntries(manifest: Json): [string, string][] {
  return dependencyFields.flatMap((field) =>
    Object.entries(dependencyRecord(manifest[field], `${String(manifest.name)} ${field}`)),
  );
}

function dependencyRecord(value: unknown, label: string): Record<string, string> {
  return stringMap(value, label);
}

function rewritePublishedManifest(source: Json, version: string, urls: Map<string, string>): Json {
  const manifest: Json = { ...source, version };
  for (const field of dependencyFields) {
    const dependencies = dependencyRecord(source[field], `${String(source.name)} ${field}`);
    if (!Object.keys(dependencies).length) continue;
    const rewritten: Record<string, string> = {};
    for (const [name, spec] of Object.entries(dependencies))
      rewritten[name] = urls.get(name) ?? spec;
    manifest[field] = rewritten;
  }
  return manifest;
}

function canonicalManifest(text: string, label: string): Json {
  const parsed: unknown = JSON.parse(text);
  const value = record(parsed, label);
  assert.equal(text, `${JSON.stringify(value, null, 2)}\n`, `${label} is not canonical JSON`);
  return value;
}

function manifestChanges(before: Json, after: Json): { path: string; from: string; to: string }[] {
  const changes: { path: string; from: string; to: string }[] = [];
  if (before.version !== after.version) {
    changes.push({
      path: "version",
      from: stringValue(before.version, "version"),
      to: stringValue(after.version, "version"),
    });
  }
  for (const field of dependencyFields) {
    const oldValues = dependencyRecord(before[field], `${String(before.name)} ${field}`);
    const newValues = dependencyRecord(after[field], `${String(after.name)} ${field}`);
    assert.deepEqual(
      Object.keys(newValues),
      Object.keys(oldValues),
      `${String(before.name)} changed dependency keys`,
    );
    for (const [name, oldValue] of Object.entries(oldValues)) {
      const newValue = newValues[name];
      if (oldValue === newValue) continue;
      changes.push({
        path: `${field}.${name}`,
        from: oldValue,
        to: stringValue(newValue, `${field}.${name}`),
      });
    }
  }
  const allowed = new Set(
    ["version"].concat(changes.filter((item) => item.path !== "version").map((item) => item.path)),
  );
  for (const [key, value] of Object.entries(before)) {
    if (dependencyFields.includes(key as DependencyField) || key === "version") continue;
    assert.deepEqual(value, after[key], `${String(before.name)} changed ${key}`);
  }
  assert.ok(changes.every((item) => allowed.has(item.path)));
  return changes;
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
  assert.deepEqual(
    canonicalManifest(readFileSync(resolve(rebound, "package.json"), "utf8"), item.name),
    expected,
  );
  for (const file of left.filter((path) => path !== "package.json")) {
    assert.deepEqual(
      readFileSync(resolve(rebound, file)),
      readFileSync(resolve(original, file)),
      `${item.name} changed non-manifest file ${file}`,
    );
  }
}

function installedGuests(source: SourcePackage, receipt: InstallReceipt): GuestReach {
  const expected = new Map(
    source.artifacts
      .filter((artifact) => artifact.path.endsWith(".wasm"))
      .map((artifact) => [artifact.path, artifact.sha256]),
  );
  const prefix = `node_modules/${source.name}/`;
  const descriptors = receipt.wasm
    .filter((item) => item.path.startsWith(prefix))
    .map((item) => ({ file: item.path.slice(prefix.length), sha256: item.sha256 }));
  return assertGuestsReached(source.name, expected, descriptors, source.guests.staticReference);
}

function topPackages(packages: readonly SourcePackage[]): string[] {
  const referenced = new Set(packages.flatMap((item) => Object.keys(item.closureDependencies)));
  return packages.map((item) => item.name).filter((name) => !referenced.has(name));
}

function bunVersion(): string {
  return execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
}

function manifestRuntime(value: unknown, label: string): RuntimeManifestAsset {
  const runtime = record(value, label);
  return {
    name: stringValue(runtime.name, `${label}.name`),
    version: stringValue(runtime.version, `${label}.version`),
    url: stringValue(runtime.url, `${label}.url`),
    bytes: numberValue(runtime.bytes, `${label}.bytes`),
    sha256: stringValue(runtime.sha256, `${label}.sha256`),
  };
}

function runtimeVersion(url: string): string {
  const match = runtimeVersionPattern.exec(url);
  assert.ok(match?.[1], `Runtime URL is not a release asset: ${url}`);
  return match[1];
}

function toolState(root: string) {
  return { commit: git(root, ["rev-parse", "HEAD"]), dirty: gitStatus(root) !== "" };
}

function outputManifest(
  source: SourceBundle,
  options: RebindOptions,
  version: string,
  targetTagState: "tagged" | "untagged-candidate",
  runtime: { path: string; bytes: number; version: string },
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
    from: {
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
      ? { script: basename(options.acceptance), commit: sourceCommit }
      : undefined,
  };
  const manifest: ReleaseManifest = {
    schema: "waffle-program-release/1",
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
      url: options.runtime.url,
      bytes: runtime.bytes,
      sha256: options.runtime.sha256,
    },
    rebind,
    order: rebound.map((item) => item.name),
    packages: rebound,
    installCheck,
  };
  assert.equal(manifest.version, version, "Target tag version differs");
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

async function buildRebind(options: RebindOptions): Promise<ReleaseManifest> {
  const control = { signal: options.signal, timeoutMs: options.commandTimeoutMs };
  assertOutputDirectory(options.out);
  const work = mkdtempSync(resolve(options.out, ".work-"));
  let retained = false;
  try {
    const source = await loadSourceBundle(options, control, work);
    const sourceCommit = stringValue(source.manifest.sourceCommit, "Source manifest sourceCommit");
    const programVersion = options.tag.slice("programs-v".length);
    assert.match(programVersion, /^\d+\.\d+\.\d+$/, "Target tag version is invalid");
    assertSourceTree(resolve(options.historicalRoot), source);
    const tagState = targetTagState(
      options.historicalRoot,
      options.tag,
      sourceCommit,
      options.requireTag,
    );
    const runtime = await readRuntime(options.runtime, options.repository, work, control);
    assert.equal(runtime.version, runtimeVersion(options.runtime.url));
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
      const original = extract(sourceArchive, resolve(work, "original", item.sourceDirectory));
      const accounting = assertFileAccounting(options.historicalRoot, sourceCommit, item, original);
      await identityRepack(original, item, work, control);
      await historicalAdmission(options.historicalRoot, original, control);
      const originalText = readFileSync(resolve(original, "package.json"), "utf8");
      const sourceManifest = canonicalManifest(originalText, item.name);
      const rewritten = rewritePublishedManifest(sourceManifest, programVersion, urls);
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
      execFileSync("cp", ["-a", original, staged]);
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
        closureDependencies: Object.fromEntries(
          dependencyEntries(rewritten).filter(([name]) => urls.has(name)),
        ),
        registryDependencies: Object.fromEntries(
          dependencyEntries(rewritten).filter(([name]) => !urls.has(name)),
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
      rebound.push(reboundPackage);
    }
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
        execFileSync("cp", ["-a", productionRoot, localRoot]);
        const text = readFileSync(resolve(localRoot, "package.json"), "utf8");
        writeFileSync(
          resolve(localRoot, "package.json"),
          replaceUrls(text, new Map(urls), localUrls),
        );
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
        assertTwin(production, twin, work, (value) => replaceUrls(value, localUrls, new Map(urls)));
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
        control,
      });
      for (const sourcePackage of source.packages) {
        const actual = installedGuests(sourcePackage, installCheck);
        const expectedPaths = sourcePackage.guests.descriptor
          .concat(sourcePackage.guests.staticReference)
          .toSorted();
        const actualPaths = actual.descriptor.concat(actual.staticReference).toSorted();
        assert.deepEqual(actualPaths, expectedPaths, `${sourcePackage.name} guest reach changed`);
      }
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
    } finally {
      server.stop(true);
    }
  } catch (error) {
    retained = error instanceof Error && error.message.includes("retained");
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
    runtime: { url: runtimeUrl, sha256: runtimeSha256, tarball: values["runtime-tarball"] },
    historicalRoot,
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
