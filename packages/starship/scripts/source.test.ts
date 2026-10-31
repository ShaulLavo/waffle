import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import source from "../sources.lock.json" with { type: "json" };
import recipe from "../build-recipe.json" with { type: "json" };

const root = new URL("../", import.meta.url);
const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex");

test("the full release commit and source archive are pinned", () => {
  assert.equal(source.upstream.revision, "f8e4e2155542cc84f49b342122d371f74e0ad253");
  assert.equal(source.upstream.version, "1.27.0");
  assert.ok(source.upstream.archive.endsWith(source.upstream.revision));
  assert.match(source.upstream.archiveSha256, /^[0-9a-f]{64}$/);
  assert.equal(source.upstream.files["src/init/starship.bash"],
    "7aa27e5ff8f79229545d887da6e5aa12f2416de011196a9227bdef1e938f6968");
});

test("dependency resolution and the upstream license stay byte-for-byte unchanged", () => {
  assert.equal(source.dependencyLock.modified, false);
  assert.equal(sha256(source.dependencyLock.localPath), source.dependencyLock.sha256);
  assert.equal(sha256(source.license.localPath), source.license.sha256);
  assert.equal(source.license.spdx, "ISC");
  const lock = readFileSync(new URL(source.dependencyLock.localPath, root), "utf8");
  assert.match(lock, /name = "starship"\nversion = "1\.27\.0"/);
  assert.match(lock, /name = "process_control"\nversion = "5\.2\.0"/);
  assert.match(lock, /name = "open"\nversion = "5\.4\.4"/);
});

test("an unsupported source candidate cannot claim a runtime executable or artifact", () => {
  assert.equal(source.status, "blocked-source-only");
  assert.deepEqual(source.acceptedPatches, []);
  assert.deepEqual(source.runtimeExports, []);
  assert.equal(recipe.supportedProducer, null);
  assert.equal(recipe.runtimeRegistration, false);
  assert.deepEqual(recipe.publishedArtifacts, []);
  for (const path of ["package.json", "package-artifacts.json", "src/index.ts", "dist/starship.wasm"])
    assert.equal(existsSync(new URL(path, root)), false, path);
});

test("the future producer reuses the shared strict build and optimization route", () => {
  assert.equal(recipe.target, "wasm32-wasip1");
  assert.equal(recipe.wasiSdk, "34.0");
  assert.equal(recipe.wasiLibc, "2e6fb9d8ee0c");
  assert.equal(recipe.optimizationPolicy, "waffle-program-size-v2");
  assert.equal(existsSync(new URL(recipe.sharedTools, root)), true);
  assert.equal(existsSync(new URL(recipe.sharedOptimizer, root)), true);
  assert.equal(recipe.minimalDiagnostic.command.at(-1), "--no-default-features");
  assert.match(recipe.minimalDiagnostic.scope, /not an accepted production policy/);
  assert.deepEqual(recipe.blockers.map((blocker) => blocker.id), [
    "dependency-platform",
    "process-capture-and-deadline",
    "parallel-render-and-scan",
    "module-authority",
  ]);
});
