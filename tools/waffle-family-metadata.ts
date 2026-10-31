import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

function packageArgument(argv: readonly string[]): string {
  const index = argv.indexOf("--package");
  if (index < 0) return resolve(dirname(new URL(import.meta.url).pathname), "..");
  const path = argv[index + 1];
  assert.ok(path, "Use --package <directory>");
  return resolve(process.cwd(), path);
}

if (import.meta.main) {
  const root = packageArgument(process.argv.slice(2));
  const manifest = readManifest(resolve(root, "package.json"));
  if (isWaffleFamilyManifest(manifest)) {
    const runtime = assertRuntimeManifest(
      readManifest(resolve(root, "../../packages/waffle/package.json")),
      "packages/waffle/package.json",
    );
    assertSourceWaffleFamilyManifest(manifest, `${root}/package.json`, runtime);
  } else {
    assertSourceWaffleMetadata(root);
  }
  console.log("Waffle host-interface metadata: pass");
}
