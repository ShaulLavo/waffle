import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReleaseManifest } from "./program-release.ts";

/**
 * Repacks verified program-release tarballs with exact semver internal `@waffle-os/*`
 * dependencies (replacing GitHub Release `.tgz` URLs) and publishes them to npm in
 * dependency order. Skips any package@version already present on npm.
 */
const assetsDir = resolve(process.argv[2] ?? ".build/program-release/assets");
const dryRun = process.argv.includes("--dry-run");
const manifestPath = join(assetsDir, "program-release.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest;

const publishedVersions = new Map(manifest.packages.map((pkg) => [pkg.name, pkg.version]));

function isPublished(spec: string): boolean {
  try {
    execFileSync("npm", ["view", spec, "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

for (const pkg of manifest.packages) {
  const spec = `${pkg.name}@${pkg.version}`;
  if (!dryRun && isPublished(spec)) {
    console.log(`${spec} is already published on npm; skipping.`);
    continue;
  }
  const sourceArchive = join(assetsDir, pkg.filename);
  const scratch = mkdtempSync(join(tmpdir(), "waffle-npm-program-"));
  try {
    execFileSync("tar", ["-xzf", sourceArchive, "-C", scratch], { stdio: "inherit" });
    const stageDir = join(scratch, "package");
    const pkgJsonPath = join(stageDir, "package.json");
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<string, unknown>;
    assert.equal(pkgJson.name, pkg.name);
    assert.equal(pkgJson.version, pkg.version);
    delete pkgJson.private;
    pkgJson.publishConfig = { access: "public", provenance: true };

    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
      const deps = pkgJson[field] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const [depName, depSpec] of Object.entries(deps)) {
        const version = publishedVersions.get(depName);
        if (version && /^https:\/\/github\.com\//.test(depSpec)) {
          deps[depName] = version;
        }
      }
    }

    writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
    const args = ["publish", "--provenance", "--access", "public"];
    if (dryRun) args.push("--dry-run");
    execFileSync("npm", args, { cwd: stageDir, stdio: "inherit" });
    console.log(`${dryRun ? "Dry-run verified" : "Published"} ${spec}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
