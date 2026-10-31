import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertRuntimeManifest,
  assertSourceWaffleFamilyManifest,
  isWaffleFamilyManifest,
  type HostInterface,
  type PackageManifest,
} from "../packages/waffle/tooling/host-interface.ts";

function readManifest(path: string): PackageManifest {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as PackageManifest;
}

export function assertSourceWaffleMetadata(root: string): HostInterface {
  const runtime = assertRuntimeManifest(
    readManifest(resolve(root, "packages/waffle/package.json")),
    "packages/waffle/package.json",
  );
  const packages = resolve(root, "packages");
  for (const directory of readdirSync(packages).toSorted()) {
    const packageRoot = resolve(packages, directory);
    const packagePath = resolve(packageRoot, "package.json");
    if (!existsSync(packagePath)) continue;
    const manifest = readManifest(packagePath);
    if (!isWaffleFamilyManifest(manifest)) continue;
    assertSourceWaffleFamilyManifest(manifest, `packages/${directory}/package.json`, runtime);
  }
  return runtime;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    assertSourceWaffleMetadata(resolve(import.meta.dirname, ".."));
  } else {
    assert.equal(args[0], "--package", "Use --package <directory>");
    assert.equal(args.length, 2, "Use --package <directory>");
    const root = resolve(args[1]!);
    const manifest = readManifest(resolve(root, "package.json"));
    const runtime = assertRuntimeManifest(
      readManifest(resolve(root, "../waffle/package.json")),
      "packages/waffle/package.json",
    );
    assertSourceWaffleFamilyManifest(manifest, `${root}/package.json`, runtime);
  }
  console.log("Waffle host-interface metadata: pass");
}
