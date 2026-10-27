import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

const root = resolve(import.meta.dirname, "..");
let output =
  "# Third-party notices\n\nGenerated for the coreutils family and its Rust dependency closure.\n\n";

async function include(label, directory) {
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

const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--offline", "--locked", "--format-version", "1", "--manifest-path", "Cargo.toml"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  ),
);
const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const included = new Set();
const familyRoots = new Set([
  "waffle-coreutils",
  "waffle-cut",
  "waffle-tr",
  "waffle-wc",
  "waffle-clear",
]);

function includeDependencies(id) {
  if (included.has(id)) return;
  included.add(id);
  for (const dependency of nodes.get(id).dependencies) includeDependencies(dependency);
}

for (const pkg of metadata.packages) {
  if (familyRoots.has(pkg.name)) includeDependencies(pkg.id);
}

const fileOperations = JSON.parse(
  await readFile(resolve(root, "provenance/file-operations.source.json"), "utf8"),
);
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

const envSource = JSON.parse(await readFile(resolve(root, "provenance/env.source.json"), "utf8"));
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
const envProvenance = JSON.parse(await readFile(resolve(envDirectory, "provenance.json"), "utf8"));
assert.equal(envProvenance.repository, envSource.repository);
assert.equal(envProvenance.revision, envSource.revision);
function historicalEnvSource(path, source) {
  if (path === "Cargo.toml") {
    return source
      .replace("waffle-process-consumer", "shell-wasi-process")
      .replace("../../../process-consumer", "../../shell/wasi-process");
  }
  if (path === "src/wasi_support.rs" || path === "wasi.patch") {
    return source.replaceAll("waffle_process_consumer", "shell_wasi_process");
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
