import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checksumNames } from "./programs.ts";

const packageRoot = resolve(import.meta.dirname, "..");

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Copies only the final staged checksum bytes into the acceptance readback directory. */
export function admitChecksumArtifacts(outputDirectory: string) {
  const output = resolve(outputDirectory);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const checksums: string[] = [];
  for (const name of checksumNames) {
    const staged = resolve(packageRoot, "dist", `${name}.wasm`);
    const published = resolve(packageRoot, "public/programs", `${name}.wasm`);
    const bytes = readFileSync(staged);
    assert.ok(bytes.byteLength > 0, `Missing staged checksum guest: ${staged}`);
    assert.deepEqual(bytes, readFileSync(published), `${name}: public readback differs`);
    const destination = resolve(output, `${name}.wasm`);
    writeFileSync(destination, bytes, { flag: "wx" });
    checksums.push(`${sha256(bytes)}  ${name}.wasm`);
  }
  writeFileSync(resolve(output, "SHA256SUMS"), `${checksums.join("\n")}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const output = process.argv[2];
  if (!output || process.argv.length !== 3)
    throw new Error("Usage: node scripts/checksum-artifact.ts OUTPUT_DIRECTORY");
  admitChecksumArtifacts(output);
}
