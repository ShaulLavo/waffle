import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  lstatSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function localPath(root: string, name: string) {
  const path = resolve(root, name);
  assert.ok(path.startsWith(resolve(root) + sep), `Nonlocal package asset: ${name}`);
  return path;
}

function requiredFile(root: string, name: string, allowEmpty = false) {
  const path = localPath(root, name);
  assert.ok(statSync(path).isFile(), `Missing package asset: ${name}`);
  const bytes = readFileSync(path);
  assert.ok(allowEmpty || bytes.length, `Empty package asset: ${name}`);
  return bytes;
}

function payloadFiles(root: string, path: string): string[] {
  const manifest = record(JSON.parse(requiredFile(root, path).toString()));
  assert.ok(Array.isArray(manifest.files));
  return manifest.files.map((input: unknown) => {
    const file = record(input);
    assert.ok(typeof file.url === "string" && typeof file.sha256 === "string");
    assert.equal(typeof file.bytes, "number");
    const name = `${dirname(path)}/${file.url}`;
    const bytes = requiredFile(root, name, true);
    assert.equal(bytes.length, file.bytes, `Payload size: ${name}`);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      file.sha256,
      `Payload hash: ${name}`,
    );
    return name;
  });
}

/** Admission consumes prepared artifacts only; it never builds or fetches them. */
export function admitProgramPackage(root: string): string[] {
  const recipe = record(JSON.parse(readFileSync(resolve(root, "package-artifacts.json"), "utf8")));
  assert.ok(Array.isArray(recipe.files) && recipe.files.every((name) => typeof name === "string"));
  const files: string[] = recipe.files;
  for (const name of files) requiredFile(root, name);
  if (recipe.dependencies !== undefined) {
    assert.ok(Array.isArray(recipe.dependencies));
    for (const name of recipe.dependencies) {
      assert.equal(typeof name, "string");
      admitProgramPackage(resolve(root, "..", name));
    }
  }
  if (recipe.payloadManifest === undefined) return files;
  assert.ok(typeof recipe.payloadManifest === "string");
  return files.concat(payloadFiles(root, recipe.payloadManifest));
}

/** Check the actual archive, including files removed by package files/ignore rules. */
export function verifyProgramTarball(root: string, archive: string): void {
  const files = admitProgramPackage(root);
  if (!files.length) return;
  const parent = resolve(root, ".build");
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(resolve(parent, "pack-readback-"));
  try {
    const list = resolve(scratch, "members");
    writeFileSync(list, files.map((name) => `package/${name}`).join("\0") + "\0");
    // Extract requested files once; Python has thousands of payload entries.
    execFileSync("tar", ["-xf", archive, "-C", scratch, "--null", "-T", list], { stdio: "pipe" });
    for (const name of files) {
      const packed = localPath(resolve(scratch, "package"), name);
      assert.ok(lstatSync(packed).isFile(), `Packed asset is not a regular file: ${name}`);
      assert.deepEqual(
        readFileSync(packed),
        requiredFile(root, name, true),
        `Packed asset differs: ${name}`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function packProgramPackage(root: string): string {
  admitProgramPackage(root);
  const manifest = record(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")));
  assert.ok(typeof manifest.name === "string" && typeof manifest.version === "string");
  const archive = resolve(
    root,
    ".build",
    `${manifest.name.replaceAll(/[@/]/g, "-")}-${manifest.version}.tgz`,
  );
  mkdirSync(dirname(archive), { recursive: true });
  try {
    execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--filename", archive], {
      cwd: root,
      stdio: "pipe",
    });
    verifyProgramTarball(root, archive);
    return archive;
  } catch (error) {
    rmSync(archive, { force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const action = process.argv[2];
  assert.ok(action === "check" || action === "pack", "Use check|pack [PACKAGE_ROOT]");
  const root = resolve(process.argv[3] ?? process.cwd());
  if (action === "check") admitProgramPackage(root);
  else console.log(packProgramPackage(root));
}
