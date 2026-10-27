import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const maintained = json("provenance/maintained-transfer.json");
const integration = json("provenance/integration-transfer.json");
const relocation = json("provenance/relocation.json");

for (const entry of maintained.entries) {
  const bytes = readFileSync(resolve(root, entry.newPath.replace(/^packages\/coreutils\//, "")));
  assert.equal(sha256(bytes), entry.transferredSha256, `transferred bytes: ${entry.newPath}`);
  if (entry.classification === "exact") {
    assert.equal(entry.transferredSha256, entry.sourceSha256, `frozen bytes: ${entry.newPath}`);
  }
}

const covered = new Set(
  [maintained.entries, integration.records, relocation.entries]
    .flat()
    .map((entry) => entry.oldPath)
    .filter(Boolean),
);
for (const path of maintained.coverage.inventoryPaths.concat(maintained.coverage.mixedSplitPaths)) {
  assert.ok(covered.has(path), `unaccounted frozen inventory path: ${path}`);
}

for (const path of [
  "scripts/test-coreutils-packaging.ts",
  "scripts/artifacts.ts",
  "scripts/build.ts",
]) {
  const source = read(path);
  for (const name of ["find", "grep", "rg", "python", "sed", "xargs"]) {
    assert.ok(!source.includes(`"${name}"`), `${path} retains other-family program ${name}`);
  }
}
for (const path of ["scripts/wasi-build.ts", "scripts/verify-wasi-guests.ts"]) {
  assert.ok(!existsSync(resolve(root, path)), `duplicated shared helper: ${path}`);
}
const activeRoutes = [
  "scripts/artifacts.ts",
  "scripts/build.ts",
  "scripts/build-family.ts",
  "scripts/build-config.ts",
  "scripts/build-wc.ts",
  "scripts/build-ls.ts",
  "scripts/build-clear.ts",
];
for (const path of activeRoutes) {
  const source = read(path);
  assert.doesNotMatch(source, /buildWasiShell|shellTargetDirectory|BASH_WEB_UTILITY_ARTIFACTS/);
  assert.doesNotMatch(source, /\.\/(?:wasi-build|verify-wasi-guests)\.ts/);
  assert.ok(!source.includes("/work/tmp/waffle-program-build-tools"), `absolute helper: ${path}`);
}
for (const path of ["scripts/build-config.ts", "scripts/build-family.ts", "scripts/artifacts.ts"]) {
  assert.ok(read(path).includes("../../../tools/program-build-tools.ts"), `shared import: ${path}`);
}
const fixtures = maintained.entries.filter((entry) => entry.newPath.includes("/fixtures/"));
assert.equal(fixtures.length, 4);
for (const fixture of fixtures) assert.equal(fixture.sourceSha256, fixture.transferredSha256);
assert.deepEqual(Object.keys(json("sources.lock.json")), ["shellCutTrQualification"]);
console.log(
  `transfer verified: ${maintained.entries.length} maintained assets, ${fixtures.length} frozen fixtures, ${integration.records.length} mixed records, full inventory coverage`,
);
