import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePythonPayloadManifest } from "../src/python-payload.ts";

const qualified = {
  "python.wasm": "76453aaf80381c9e1a870bb26dde977d930f8ed767bcb803c5da5528d76a1ae9",
  "python-stdlib.json": "98d84f8c3645e471794a7537304af0aedac881b2485907211bc4d3d1a55d8c3c",
  "python-build.json": "d43db27f6e79ece3067a5d9823b30891aac58b9b6bd9bc2a9b73b86af6cfd46a",
  "python.NOTICES.txt": "9736494b741d59bcc7cef5b2ea8d2cf2701b36580514f1f2fb351776da749a81",
  "python-licenses.json": "cf6f81ec4651f5c18c7ed7f8cc755989d3487cebe7badd94bd60b2c3ceece5f1",
} as const;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifyQualifiedAssets(source: string): void {
  for (const [name, expected] of Object.entries(qualified)) {
    assert.equal(sha256(resolve(source, name)), expected, `Unqualified Python asset: ${name}`);
  }
}

function verifyPayload(source: string): { files: number; bytes: number } {
  const value: unknown = JSON.parse(readFileSync(resolve(source, "python-stdlib.json"), "utf8"));
  const manifest = parsePythonPayloadManifest(value);
  let bytes = 0;
  for (const file of manifest.files) {
    assert.equal(file.url, `python-files${file.path}`, `Non-relocatable URL: ${file.path}`);
    const path = resolve(source, file.url);
    assert.equal(readFileSync(path).byteLength, file.bytes, `Payload size: ${file.path}`);
    assert.equal(sha256(path), file.sha256, `Payload hash: ${file.path}`);
    bytes += file.bytes;
  }
  return { files: manifest.files.length, bytes };
}

/** Verify a complete qualified artifact before copying anything into the package. */
export function stagePythonAssets(source: string, output: string) {
  assert.ok(!existsSync(output), `Asset output already exists: ${output}`);
  verifyQualifiedAssets(source);
  const payload = verifyPayload(source);
  mkdirSync(output, { recursive: true });
  for (const name of Object.keys(qualified)) copyFileSync(resolve(source, name), resolve(output, name));
  cpSync(resolve(source, "python-files"), resolve(output, "python-files"), { recursive: true });
  return { ...payload, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = process.argv[2];
  const output = process.argv[3] ?? resolve(import.meta.dirname, "../assets");
  if (!source) throw new Error("Usage: node scripts/stage-assets.ts QUALIFIED_ARTIFACT [OUTPUT]");
  mkdirSync(dirname(output), { recursive: true });
  console.log(JSON.stringify(stagePythonAssets(resolve(source), resolve(output))));
}
