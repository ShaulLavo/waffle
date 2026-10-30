import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { generateRustNotices } from "../../../tools/program-notices.ts";
import { prepareChecksumSource } from "./prepare-checksum-source.ts";
import fileOperations from "../provenance/file-operations.source.json" with { type: "json" };
import envSource from "../provenance/env.source.json" with { type: "json" };
import envProvenance from "../vendor/uutils-env/provenance.json" with { type: "json" };

interface CargoPackage {
  id: string;
  name: string;
  version: string;
  source: string | null;
  manifest_path: string;
}

interface CargoMetadata {
  packages: CargoPackage[];
  resolve: {
    nodes: Array<{
      id: string;
      dependencies: string[];
    }>;
  };
}

const root = resolve(import.meta.dirname, "..");
let output =
  "# Third-party notices\n\nGenerated for the coreutils family and its Rust dependency closure.\n\n";

async function include(label: string, directory: string): Promise<void> {
  const names = (await readdir(directory).catch(() => []))
    .filter((name) => /^(license|copying|notice)(\.|-|$)/i.test(name))
    .sort();
  for (const name of names) {
    const text = await readFile(resolve(directory, name), "utf8").catch(() => undefined);
    if (!text) continue;
    const normalized = text.replaceAll("\r\n", "\n").replace(/[ \t]+$/gm, "");
    output += `## ${label} / ${name}\n\n${normalized}\n\n`;
  }
}

const metadata: CargoMetadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--offline", "--locked", "--format-version", "1", "--manifest-path", "Cargo.toml"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  ),
);
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const included = new Set<string>();
const familyRoots = new Set([
  "waffle-coreutils",
  "waffle-cut",
  "waffle-tr",
  "waffle-wc",
  "waffle-clear",
]);

function includeDependencies(id: string): void {
  if (included.has(id)) return;
  included.add(id);
  const node = nodes.get(id);
  assert.ok(node, `Dependency node is missing from Cargo metadata: ${id}`);
  for (const dependency of node.dependencies) includeDependencies(dependency);
}

for (const pkg of metadata.packages) {
  if (familyRoots.has(pkg.name)) includeDependencies(pkg.id);
}

const upstream = metadata.packages.find(
  (pkg) => pkg.name === "uucore" && pkg.source?.endsWith(`#${fileOperations.revision}`),
);
if (!upstream) throw new Error("Pinned file utility source is missing from Cargo metadata");
const upstreamRoot = resolve(dirname(upstream.manifest_path), "../..");
assert.equal(
  createHash("sha256")
    .update(await readFile(resolve(upstreamRoot, fileOperations.license.path)))
    .digest("hex"),
  fileOperations.license.sha256,
  "Pinned uutils root license digest",
);

assert.equal(envSource.repository, fileOperations.repository);
assert.equal(envSource.revision, fileOperations.revision);
assert.deepEqual(envSource.license, fileOperations.license);
assert.deepEqual(envSource.sharedPackage, fileOperations.sharedPackage);
const envDirectory = resolve(root, "vendor/uutils-env");
for (const [name, pkg] of Object.entries(envSource.packages)) {
  const resolved = metadata.packages.find((entry) => entry.name === name && entry.source === null);
  assert.ok(resolved, `Patched env source is missing from Cargo metadata: ${name}`);
  assert.equal(resolved.version, pkg.version);
  assert.equal(dirname(resolved.manifest_path), envDirectory);
}
assert.equal(envProvenance.repository, envSource.repository);
assert.equal(envProvenance.revision, envSource.revision);
function historicalEnvSource(path: string, source: string): string {
  if (path === "Cargo.toml") {
    return source
      .replace("waffle-process-consumer", "shell-wasi-process")
      .replace("../../../process-consumer", "../../shell/wasi-process");
  }
  if (path === "src/wasi_support.rs" || path === "wasi.patch") {
    return source
      .replaceAll("waffle_process_consumer", "shell_wasi_process")
      .replaceAll("inherited_descriptors", "inherited_shell_descriptors");
  }
  return source;
}
for (const [path, digest] of Object.entries(envProvenance.files)) {
  const source = historicalEnvSource(path, await readFile(resolve(envDirectory, path), "utf8"));
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    digest,
    `Patched env source digest: ${path}`,
  );
}
output += `## uutils env source\n\n${envSource.repository} at ${envSource.revision}. Local WASI changes are recorded in vendor/uutils-env/wasi.patch.\n\n`;
await include(`uutils coreutils ${fileOperations.revision}`, upstreamRoot);
for (const pkg of metadata.packages.toSorted((a, b) => a.name.localeCompare(b.name))) {
  if (included.has(pkg.id)) await include(`${pkg.name} ${pkg.version}`, dirname(pkg.manifest_path));
}
await mkdir(resolve(root, "dist"), { recursive: true });
await writeFile(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), output);

// The isolated checksum workspace resolves its patched dependency from the owned source.
prepareChecksumSource();
generateRustNotices({
  root,
  packages: [
    "waffle-coreutils",
    "waffle-cut",
    "waffle-tr",
    "waffle-wc",
    "waffle-clear",
    "waffle-echo",
    "waffle-date",
  ],
  features: "cooperative-wasi",
  prefix: readFileSync(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8"),
  isolated: [
    { manifest: resolve(root, "crates/checksums/Cargo.toml"), packages: ["waffle-coreutils-checksums"] },
  ],
});
