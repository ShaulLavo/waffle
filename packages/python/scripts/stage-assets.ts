import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stagePythonArtifact } from "./build-python.ts";
import { pythonSource } from "./python-source.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function verifyPythonReceipt(source: string, expectedSha256: string) {
  assert.match(expectedSha256, /^[a-f0-9]{64}$/, "Provide the accepted producer receipt SHA-256");
  const bytes = readFileSync(resolve(source, "python-build.json"));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    expectedSha256,
    "Producer receipt SHA-256",
  );
  const receipt: unknown = JSON.parse(bytes.toString());
  assert.ok(record(receipt));
  assert.equal(receipt.cpython, pythonSource.revision);
  assert.deepEqual(receipt.source, pythonSource, "Pinned CPython source identity");
  assert.deepEqual(receipt.sourcePatch, pythonSource.patch, "Pinned CPython startup patch");
  assert.equal(receipt.payloadFiles, 2650, "Full unpruned CPython payload");
  return receipt;
}

/** Stage an externally accepted artifact; retain its original producer receipt verbatim. */
export function stagePythonAssets(source: string, output: string, receiptSha256: string) {
  assert.ok(!existsSync(output), `Asset output already exists: ${output}`);
  verifyPythonReceipt(source, receiptSha256);
  const original = readFileSync(resolve(source, "python-build.json"));
  const manifest = stagePythonArtifact(source, output);
  assert.equal(manifest.files.length, 2650);
  assert.deepEqual(readFileSync(resolve(output, "python-build.json")), original);
  assert.deepEqual(readFileSync(resolve(source, "python-build.json")), original);
  return {
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    output,
    producerReceiptSha256: receiptSha256,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [flag, receiptSha256, source, destination] = process.argv.slice(2);
  assert.ok(
    flag === "--receipt-sha256" && receiptSha256 && source,
    "Usage: node scripts/stage-assets.ts --receipt-sha256 HEX ACCEPTED_ARTIFACT [OUTPUT]",
  );
  const output = resolve(destination ?? resolve(import.meta.dirname, "../assets"));
  console.log(JSON.stringify(stagePythonAssets(resolve(source), output, receiptSha256)));
}
