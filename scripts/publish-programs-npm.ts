import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ReleasedPackage, ReleaseManifest } from "./program-release.ts";

const registry = "https://registry.npmjs.org";
const commandTimeout = 120_000;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertArchive(path: string, receipt: { bytes: number; sha256: string }) {
  const bytes = readFileSync(path);
  assert.equal(bytes.length, receipt.bytes, `${path}: archive size differs`);
  assert.equal(sha256(bytes), receipt.sha256, `${path}: archive hash differs`);
}

export function packNpmProgram(
  source: string,
  pkg: ReleasedPackage,
  closure: ReadonlyMap<string, ReleasedPackage>,
  scratch: string,
): { archive: string; receipt: ReleasedPackage } {
  assertArchive(source, pkg);
  const slug = /^@waffle-os\/([a-z0-9-]+)$/.exec(pkg.name)?.[1];
  assert.ok(slug, `Invalid program package name ${pkg.name}`);
  assert.match(pkg.version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  const filename = `${slug}-${pkg.version}.tgz`;
  const sourceDirectory = join(scratch, "source");
  mkdirSync(sourceDirectory);
  execFileSync("tar", ["-xzf", source, "-C", sourceDirectory], { timeout: commandTimeout });
  const stage = join(sourceDirectory, "package");
  const manifestPath = join(stage, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  delete manifest.private;
  manifest.publishConfig = { access: "public", provenance: true, registry };

  const closureDependencies: Record<string, string> = {};
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    const dependencies = manifest[field] as Record<string, string> | undefined;
    if (!dependencies) continue;
    for (const [name, spec] of Object.entries(dependencies)) {
      const target = closure.get(name);
      if (!target) continue;
      assert.equal(spec, target.url, `${pkg.name}: unexpected staged edge for ${name}`);
      dependencies[name] = target.version;
      closureDependencies[name] = target.version;
    }
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const packed = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", scratch], {
    cwd: stage,
    encoding: "utf8",
    timeout: commandTimeout,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  assert.equal(packed, `waffle-os-${filename}`, `${pkg.name}: unexpected npm pack filename`);
  const archive = join(scratch, packed);
  const bytes = readFileSync(archive);
  const unpacked = join(scratch, "npm");
  mkdirSync(unpacked);
  execFileSync("tar", ["-xzf", archive, "-C", unpacked], { timeout: commandTimeout });
  for (const artifact of pkg.artifacts) {
    assertArchive(join(unpacked, "package", artifact.path), artifact);
  }
  return {
    archive,
    receipt: {
      ...pkg,
      filename,
      url: `${registry}/${pkg.name}/-/${filename}`,
      bytes: bytes.length,
      sha256: sha256(bytes),
      closureDependencies,
    },
  };
}

async function alreadyPublished(receipt: ReleasedPackage): Promise<boolean> {
  const response = await fetch(receipt.url, { signal: AbortSignal.timeout(commandTimeout) });
  if (response.status === 404) {
    await response.body?.cancel();
    return false;
  }
  assert.equal(response.status, 200, `Cannot read ${receipt.url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.length, receipt.bytes, `${receipt.url}: existing npm archive size differs`);
  assert.equal(sha256(bytes), receipt.sha256, `${receipt.url}: existing npm archive hash differs`);
  return true;
}

async function publishPrograms(
  assets: string,
  output: string,
  dryRun: boolean,
  existingReceipt: string | undefined,
) {
  const manifest = JSON.parse(
    readFileSync(join(assets, "program-release.json"), "utf8"),
  ) as ReleaseManifest;
  const closure = new Map(manifest.packages.map((pkg) => [pkg.name, pkg]));
  const scratch = mkdtempSync(join(tmpdir(), "waffle-npm-program-"));
  try {
    const staged = manifest.packages.map((pkg) => {
      const directory = mkdtempSync(join(scratch, "package-"));
      return packNpmProgram(join(assets, pkg.filename), pkg, closure, directory);
    });
    const packages = staged.map(({ receipt }) => receipt);
    const receipt: ReleaseManifest = { ...manifest, assetBase: registry, packages };
    const contents = `${JSON.stringify(receipt, null, 2)}\n`;
    if (existingReceipt !== undefined) {
      assert.ok(
        readFileSync(existingReceipt, "utf8") === contents,
        `Existing npm receipt differs for ${manifest.tag}`,
      );
    }
    if (dryRun) return;
    const pending: typeof staged = [];
    for (const item of staged) {
      if (!(await alreadyPublished(item.receipt))) pending.push(item);
    }
    for (const { archive } of pending) {
      execFileSync("npm", ["publish", archive, "--provenance", "--access", "public"], {
        cwd: scratch,
        stdio: "inherit",
        timeout: commandTimeout,
      });
    }
    writeFileSync(output, contents);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      "existing-receipt": { type: "string" },
    },
  });
  const [assets, output] = positionals;
  const dryRun = values["dry-run"];
  assert.ok(assets && (output || dryRun), "Expected assets directory and npm receipt output path");
  await publishPrograms(
    resolve(assets),
    resolve(output ?? assets),
    dryRun,
    values["existing-receipt"],
  );
}
