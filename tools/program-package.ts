import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  lstatSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { programBytesIdentity, validateProgramDerivation } from "./program-derivation.ts";
import { stripWasmNames } from "./program-build-tools.ts";
import { programSymbolsReference } from "./program-symbols.ts";
import { assertWaffleFamilyManifest } from "../packages/waffle/tooling/host-interface.ts";

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

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function optionalCompanion(root: string, name: string) {
  try {
    const path = localPath(root, name);
    assert.ok(lstatSync(path).isFile(), `Program companion is not a regular file: ${name}`);
    const bytes = readFileSync(path);
    assert.ok(bytes.length, `Empty program companion: ${name}`);
    return bytes;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

const companionDecoders = [
  [".gz", gunzipSync],
  [".br", brotliDecompressSync],
] as const;

function admitProgramCompanions(root: string, name: string, raw: Buffer) {
  const admitted: string[] = [];
  for (const [suffix, decode] of companionDecoders) {
    const companion = `${name}${suffix}`;
    const encoded = optionalCompanion(root, companion);
    if (!encoded) continue;
    const decoded = decode(encoded, { maxOutputLength: raw.length });
    assert.ok(decoded.equals(raw), `Program companion differs from final bytes: ${companion}`);
    admitted.push(companion);
  }
  return admitted;
}

/** Any symbol sidecar, reference module or compressed copy of either. */
const symbolFiles = /-symbols\.[^/]*$/;

/** Symbol files on disk beside the listed guests; Coreutils packs its whole `dist`. */
function symbolFilesBesideGuests(root: string, files: readonly string[]) {
  const directories = new Set(files.filter((name) => name.endsWith(".wasm")).map(dirname));
  return Array.from(directories).flatMap((directory) =>
    readdirSync(resolve(root, directory))
      .filter((name) => symbolFiles.test(name))
      .map((name) => (directory === "." ? name : `${directory}/${name}`)),
  );
}

/** Every symbol file listed, staged or packed must be one a receipt binds. */
function assertSymbolsBound(candidates: readonly string[], bound: ReadonlySet<string>) {
  const unbound = Array.from(new Set(candidates)).filter(
    (name) => symbolFiles.test(name) && !bound.has(name),
  );
  assert.equal(unbound.length, 0, `Program symbols are not declared: ${unbound.join(" ")}`);
}

/**
 * A declared sidecar ships with its reference module and validated companions; anything else
 * named like a sidecar is refused by the caller. `validate` binds the sidecar to the derivation
 * before its reference module is compared.
 */
function admitProgramSymbols(
  root: string,
  files: readonly string[],
  wasm: string,
  receipt: Record<string, unknown>,
  validate: (symbols?: Uint8Array) => void,
) {
  const base = wasm.replace(/\.wasm$/, "");
  const sidecar = `${base}-symbols.json`;
  const reference = `${base}-symbols.ts`;
  if (receipt.symbols === undefined) {
    validate();
    return { names: [], companions: [] };
  }
  for (const name of [sidecar, reference])
    assert.ok(files.includes(name), `Missing declared program symbols: ${name}`);
  const bytes = requiredFile(root, sidecar);
  validate(bytes);
  const expected = programSymbolsReference(basename(base), programBytesIdentity(bytes));
  assert.equal(
    requiredFile(root, reference).toString(),
    expected,
    `Program symbols reference differs: ${reference}`,
  );
  return {
    names: [sidecar, reference],
    companions: admitProgramCompanions(root, sidecar, bytes),
  };
}

/** Admission consumes prepared artifacts only; it never builds or fetches them. */
export function admitProgramPackage(root: string): string[] {
  const recipe = record(JSON.parse(readFileSync(resolve(root, "package-artifacts.json"), "utf8")));
  assert.ok(Array.isArray(recipe.files) && recipe.files.every((name) => typeof name === "string"));
  const files: string[] = recipe.files;
  const companions: string[] = [];
  const boundSymbols = new Set<string>();
  for (const name of files) {
    const bytes = requiredFile(root, name);
    if (!name.endsWith(".wasm")) continue;
    assert.ok(stripWasmNames(bytes) === bytes, `Program still contains a name section: ${name}`);
    const sidecar = name.replace(/\.wasm$/, "-program.json");
    assert.ok(files.includes(sidecar), `Missing declared program derivation: ${sidecar}`);
    const producer =
      name === "assets/python.wasm" ? requiredFile(root, "assets/python-build.json") : undefined;
    const receipt = record(JSON.parse(requiredFile(root, sidecar).toString()));
    const symbols = admitProgramSymbols(root, files, name, receipt, (symbolBytes) =>
      validateProgramDerivation(receipt, bytes, producer, symbolBytes),
    );
    for (const symbol of symbols.names.concat(symbols.companions)) boundSymbols.add(symbol);
    const discovered = admitProgramCompanions(root, name, bytes).concat(symbols.companions);
    companions.push(...discovered.filter((companion) => !files.includes(companion)));
  }
  assertSymbolsBound(files.concat(symbolFilesBesideGuests(root, files)), boundSymbols);
  if (recipe.dependencies !== undefined) {
    assert.ok(Array.isArray(recipe.dependencies));
    for (const name of recipe.dependencies) {
      assert.equal(typeof name, "string");
      admitProgramPackage(resolve(root, "..", name));
    }
  }
  if (recipe.payloadManifest === undefined) return files.concat(companions);
  assert.ok(typeof recipe.payloadManifest === "string");
  return files.concat(companions, payloadFiles(root, recipe.payloadManifest));
}

/** Check the actual archive, including files removed by package files/ignore rules. */
export function verifyProgramTarball(root: string, archive: string): void {
  const files = admitProgramPackage(root);
  if (!files.length) return;
  const members = execFileSync("tar", ["-tf", archive], { encoding: "utf8", stdio: "pipe" })
    .split("\n")
    .filter((member) => member.startsWith("package/"))
    .map((member) => member.slice("package/".length));
  assertSymbolsBound(members, new Set(files.filter((name) => symbolFiles.test(name))));
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
  assertWaffleFamilyManifest(manifest, `${root}/package.json`);
  const archive = resolve(
    root,
    ".build",
    `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`,
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
