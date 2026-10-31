import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import {
  validateProgramDerivation,
  programBytesIdentity,
} from "../../../tools/program-derivation.ts";
import {
  programLocaleImplementation,
  readProgramLocaleProof,
  verifyOwnedLocaleSource,
} from "../../../tools/program-locales/prepare.ts";
import { sha256 } from "../../../tools/program-locales/patch.ts";
import { packageRoot, releaseDirectory, workspaceRoot } from "./build-config.ts";
import { checksumRevision, checksumSource } from "./prepare-checksum-source.ts";
import { verifyWasiGuest } from "../../../tools/program-build-tools.ts";
import { checksumNames, verificationOptions, type ChecksumName } from "./programs.ts";

function selectedSource(name: ChecksumName, raw: string) {
  const proof = readProgramLocaleProof(raw, name);
  assert.ok(
    proof &&
      typeof proof === "object" &&
      "selection" in proof &&
      typeof proof.selection === "string",
  );
  const selection: unknown = JSON.parse(proof.selection);
  assert.ok(
    selection &&
      typeof selection === "object" &&
      "implementation" in selection &&
      "ownedSource" in selection,
  );
  assert.deepEqual(
    selection.implementation,
    programLocaleImplementation(),
    "Checksum locale implementation changed",
  );
  assert.deepEqual(
    selection.ownedSource,
    {
      directory: checksumSource,
      revision: checksumRevision,
      receiptSha256: sha256(readFileSync(resolve(checksumSource, "waffle-source.json"))),
    },
    "Checksum locale source receipt changed",
  );
}

export function readStrippedChecksumProgram({
  raw,
  stagedPath,
  derivationBytes,
}: {
  raw: Uint8Array;
  stagedPath: string;
  derivationBytes: Buffer;
}) {
  const final = readFileSync(stagedPath);
  const module = new WebAssembly.Module(final);
  assert.equal(
    WebAssembly.Module.customSections(module, "name").length,
    0,
    "Checksum final guest retains function names",
  );
  assert.ok(
    !WebAssembly.Module.imports(module).some((entry) => entry.kind === "memory"),
    "Checksum guest memory must not be imported",
  );
  const derivation: unknown = JSON.parse(derivationBytes.toString("utf8"));
  validateProgramDerivation(derivation, final);
  assert.ok(derivation && typeof derivation === "object" && "input" in derivation);
  assert.deepEqual(derivation.input, programBytesIdentity(raw), "Checksum compiler input changed");
  return final;
}

function guestAssets(name: ChecksumName) {
  const raw = resolve(releaseDirectory, `${name}.wasm`);
  const stagedPath = resolve(packageRoot, "dist", `${name}.wasm`);
  verifyWasiGuest(raw, verificationOptions(name));
  selectedSource(name, raw);
  const derivationBytes = readFileSync(resolve(packageRoot, "dist", `${name}-program.json`));
  const final = readStrippedChecksumProgram({
    raw: readFileSync(raw),
    stagedPath,
    derivationBytes,
  });
  const gzip = readFileSync(resolve(packageRoot, "dist", `${name}.wasm.gz`));
  const brotli = readFileSync(resolve(packageRoot, "dist", `${name}.wasm.br`));
  assert.deepEqual(gunzipSync(gzip), final, "Checksum gzip readback differs");
  assert.deepEqual(brotliDecompressSync(brotli), final, "Checksum Brotli readback differs");
  const staged = [
    { name: `${name}.wasm`, bytes: final },
    { name: `${name}.wasm.gz`, bytes: gzip },
    { name: `${name}.wasm.br`, bytes: brotli },
    { name: `${name}-program.json`, bytes: derivationBytes },
  ];
  for (const asset of staged)
    assert.deepEqual(
      asset.bytes,
      readFileSync(resolve(packageRoot, "public/programs", asset.name)),
      `${name}: public readback differs`,
    );
  return staged.concat([
    { name: `${name}.raw.wasm`, bytes: readFileSync(raw) },
    { name: `${name}.raw.wasm.locales.json`, bytes: readFileSync(`${raw}.locales.json`) },
  ]);
}

/** Reads the checksum-only producer closure, never a complete coreutils family package. */
export function admitChecksumArtifacts(outputDirectory: string) {
  const output = resolve(outputDirectory);
  assert.equal(
    output,
    resolve(workspaceRoot, ".build/checksum-artifact"),
    "Checksum readback requires its owned output directory",
  );
  const source = readFileSync(resolve(checksumSource, "waffle-source.json"));
  verifyOwnedLocaleSource(workspaceRoot, {
    directory: checksumSource,
    revision: checksumRevision,
    receiptSha256: sha256(source),
  });
  const assets = checksumNames
    .flatMap(guestAssets)
    .concat([{ name: "checksum-source.json", bytes: source }]);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  for (const asset of assets)
    writeFileSync(resolve(output, asset.name), asset.bytes, { flag: "wx" });
  writeFileSync(
    resolve(output, "SHA256SUMS"),
    assets.map((asset) => `${sha256(asset.bytes)}  ${asset.name}\n`).join(""),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const output = process.argv[2];
  if (!output || process.argv.length !== 3)
    throw new Error("Usage: node scripts/checksum-artifact.ts OUTPUT_DIRECTORY");
  admitChecksumArtifacts(output);
}
