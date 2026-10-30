import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function licenseFiles(pkg: Record<string, unknown>): string[] {
  const directory = dirname(text(pkg.manifest_path));
  const names = readdirSync(directory).filter((name) =>
    /^(licen[cs]e|copying|notice|unlicense)([._-]|$)/i.test(name),
  );
  names.sort();
  const files = names.map((name) => resolve(directory, name));
  if (typeof pkg.license_file === "string") files.push(resolve(directory, pkg.license_file));
  if (files.length) return Array.from(new Set(files));
  const pinned = pinnedLicense(pkg, directory);
  if (pinned) return [pinned];
  assert.ok(
    pkg.source === null || (typeof pkg.source === "string" && pkg.source.startsWith("git+")),
    `Missing license text for ${text(pkg.name)} ${text(pkg.version)}`,
  );
  // Workspace crates may inherit the repository's license, as Cargo permits.
  for (let parent = dirname(directory); parent !== dirname(parent); parent = dirname(parent)) {
    if (existsSync(resolve(parent, "LICENSE"))) return [resolve(parent, "LICENSE")];
    if (existsSync(resolve(parent, "Cargo.lock"))) break;
  }
  throw new Error(`Missing license text for ${text(pkg.name)} ${text(pkg.version)}`);
}

/** Follow only the locked production/build edges of the selected family roots. */
function selectedPackages(metadata: unknown, roots: readonly string[]) {
  const source = record(metadata);
  const packages = array(source.packages).map(record);
  const nodes = array(record(source.resolve).nodes).map(record);
  const byId = new Map(packages.map((pkg) => [text(pkg.id), pkg]));
  const graph = new Map(nodes.map((node) => [text(node.id), node]));
  const queue = packages.filter((pkg) => roots.includes(text(pkg.name))).map((pkg) => text(pkg.id));
  for (const root of roots)
    assert.ok(
      packages.some((pkg) => pkg.name === root),
      `Missing family root: ${root}`,
    );
  const selected = new Map<string, Record<string, unknown>>();
  for (const id of queue) {
    if (selected.has(id)) continue;
    const pkg = byId.get(id);
    assert.ok(pkg, `Missing dependency package: ${id}`);
    selected.set(id, pkg);
    const node = graph.get(id);
    assert.ok(node, `Missing dependency node: ${id}`);
    queue.push(...productionDependencies(node));
  }
  return selected;
}

function formatNotices(packages: ReadonlyMap<string, Record<string, unknown>>): string {
  return Array.from(packages.keys())
    .sort()
    .map((id) => {
      const pkg = packages.get(id)!;
      return licenseFiles(pkg)
        .map(
          (path) =>
            `## ${text(pkg.name)} ${text(pkg.version)} / ${path.split("/").at(-1)}\n\n${readFileSync(path, "utf8")}\n`,
        )
        .join("\n");
    })
    .join("\n");
}

export function rustDependencyNotices(metadata: unknown, roots: readonly string[]): string {
  return formatNotices(selectedPackages(metadata, roots));
}

function productionDependencies(node: Record<string, unknown>): string[] {
  return array(node.deps)
    .map(record)
    .filter((dep) =>
      array(dep.dep_kinds)
        .map(record)
        .some((kind) => kind.kind === null || kind.kind === "build"),
    )
    .map((dep) => text(dep.pkg));
}

function cargoMetadata(root: string, features?: string, manifest?: string): unknown {
  const args = [
    "metadata",
    "--offline",
    "--locked",
    "--format-version",
    "1",
    "--filter-platform",
    "wasm32-wasip1",
  ];
  if (features) args.push("--features", features);
  if (manifest) args.push("--manifest-path", manifest);
  return JSON.parse(
    execFileSync("cargo", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }),
  );
}

export function generateRustNotices(options: {
  readonly root: string;
  readonly packages: readonly string[];
  readonly features?: string;
  readonly prefix?: string;
  /** Family crates with their own Cargo workspace and lockfile; shared crates appear once. */
  readonly isolated?: readonly {
    readonly manifest: string;
    readonly packages: readonly string[];
  }[];
}) {
  const selected = selectedPackages(
    cargoMetadata(options.root, options.features),
    options.packages,
  );
  for (const workspace of options.isolated ?? []) {
    const metadata = cargoMetadata(options.root, undefined, workspace.manifest);
    for (const [id, pkg] of selectedPackages(metadata, workspace.packages)) selected.set(id, pkg);
  }
  const output = resolve(options.root, "dist/THIRD_PARTY_NOTICES.txt");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, (options.prefix ?? "# Third-party notices\n\n") + formatNotices(selected));
}

function pinnedLicense(pkg: Record<string, unknown>, directory: string): string | undefined {
  const identity = `${text(pkg.name)}-${text(pkg.version)}`;
  const pinned = [
    "fluent-langneg-0.13.1",
    "intl_pluralrules-7.0.2",
    "base64-simd-0.8.0",
    "vsimd-0.8.0",
    "blake2b_simd-1.0.5",
  ];
  if (!pinned.includes(identity)) return undefined;
  const receipt = record(
    JSON.parse(readFileSync(new URL(`./licenses/${identity}.json`, import.meta.url), "utf8")),
  );
  const vcs = record(JSON.parse(readFileSync(resolve(directory, ".cargo_vcs_info.json"), "utf8")));
  assert.equal(record(vcs.git).sha1, receipt.revision, "Pinned dependency license source revision");
  const path = new URL(`./licenses/${text(receipt.file)}`, import.meta.url);
  const bytes = readFileSync(path);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    receipt.sha256,
    "Pinned dependency license bytes",
  );
  return path.pathname;
}
