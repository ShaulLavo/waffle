import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  programOptimizationEnvironment,
  programOptimizationFlags,
  programOptimizationPolicy,
  programOptimizer,
} from "./program-optimize.ts";

export const programBytesIdentity = (bytes: Uint8Array) => ({
  bytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

export function transformationSourceIdentity() {
  const hash = (path: string) =>
    programBytesIdentity(readFileSync(new URL(path, import.meta.url))).sha256;
  return {
    buildToolsSha256: hash("./program-build-tools.ts"),
    optimizerSourceSha256: hash("./program-optimize.ts"),
  };
}

export function transformationProvenance() {
  const packaged = new URL("./program-transformer.json", import.meta.url);
  if (
    existsSync(packaged) ||
    new URL(".", import.meta.url).pathname.endsWith("/tooling/program/")
  ) {
    const provenance = record(JSON.parse(readFileSync(packaged, "utf8")));
    assert.ok(typeof provenance.commit === "string");
    assert.match(provenance.commit, /^[a-f0-9]{40}$/);
    const sources = transformationSourceIdentity();
    assert.equal(digest(provenance.buildToolsSha256), sources.buildToolsSha256);
    assert.equal(digest(provenance.optimizerSourceSha256), sources.optimizerSourceSha256);
    return { commit: provenance.commit, ...sources };
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  }).trim();
  assert.match(commit, /^[a-f0-9]{40}$/);
  return { commit, ...transformationSourceIdentity() };
}

function record(input: unknown): Record<string, unknown> {
  assert.ok(
    input !== null && typeof input === "object" && !Array.isArray(input),
    "Expected derivation object",
  );
  return Object.fromEntries(Object.entries(input));
}

function digest(input: unknown) {
  assert.ok(typeof input === "string" && /^[a-f0-9]{64}$/.test(input), "Invalid derivation digest");
  return input;
}

function identity(input: unknown) {
  const value = record(input);
  assert.ok(
    typeof value.bytes === "number" &&
      Number.isInteger(value.bytes) &&
      value.bytes >= 8 &&
      value.bytes <= 0xffff_ffff,
    "Invalid Wasm derivation size",
  );
  return { bytes: value.bytes, sha256: digest(value.sha256) };
}

function producerIdentity(input: unknown) {
  const value = record(input);
  assert.ok(
    typeof value.bytes === "number" &&
      Number.isInteger(value.bytes) &&
      value.bytes > 0 &&
      value.bytes <= 0xffff_ffff,
    "Invalid producer receipt size",
  );
  return { bytes: value.bytes, sha256: digest(value.sha256) };
}

export function validateProgramDerivation(
  input: unknown,
  finalBytes: Uint8Array,
  producerBytes?: Uint8Array,
) {
  const receipt = record(input);
  assert.equal(
    receipt.operation,
    "optimize-and-strip-program",
    "Unexpected program derivation operation",
  );
  const original = identity(receipt.input);
  const final = identity(receipt.output);
  assert.deepEqual(final, programBytesIdentity(finalBytes), "Final program derivation identity");
  const transformer = record(receipt.transformer);
  assert.ok(
    typeof transformer.commit === "string" && /^[a-f0-9]{40}$/.test(transformer.commit),
    "Invalid transformer commit",
  );
  const sources = transformationSourceIdentity();
  assert.equal(
    digest(transformer.buildToolsSha256),
    sources.buildToolsSha256,
    "Program staging source changed",
  );
  assert.equal(
    digest(transformer.optimizerSourceSha256),
    sources.optimizerSourceSha256,
    "Optimizer source changed",
  );
  assert.ok(
    Array.isArray(receipt.operations) && receipt.operations.length === 2,
    "Expected optimize then strip chain",
  );
  const optimized = record(receipt.operations[0]);
  assert.equal(optimized.format, 1);
  assert.equal(optimized.stage, "wasm-opt-before-name-strip");
  assert.deepEqual(identity(optimized.input), original, "Optimizer input differs from original");
  const tool = record(optimized.optimizer);
  assert.deepEqual(
    tool,
    {
      policy: programOptimizationPolicy,
      version: programOptimizer.version,
      sha256: programOptimizer.linuxX64Sha256,
      flags: Array.from(programOptimizationFlags),
      environment: programOptimizationEnvironment,
    },
    "Unpinned optimizer policy",
  );
  const stripped = record(receipt.operations[1]);
  assert.equal(stripped.operation, "strip-wasm-name-sections");
  assert.deepEqual(
    identity(optimized.output),
    identity(stripped.input),
    "Optimizer/strip chain differs",
  );
  assert.deepEqual(identity(stripped.output), final, "Strip/final chain differs");
  validateProducer(receipt, optimized, original, producerBytes);
}

function validateProducer(
  receipt: Record<string, unknown>,
  optimized: Record<string, unknown>,
  original: ReturnType<typeof identity>,
  producerBytes?: Uint8Array,
) {
  if (producerBytes === undefined) {
    assert.equal(receipt.producerReceiptSha256, undefined, "Unexpected producer receipt");
    assert.equal(optimized.producerReceipt, null, "Missing original producer receipt bytes");
    return;
  }
  const actual = programBytesIdentity(producerBytes);
  assert.equal(
    digest(receipt.producerReceiptSha256),
    actual.sha256,
    "Original producer receipt hash",
  );
  assert.deepEqual(
    producerIdentity(optimized.producerReceipt),
    actual,
    "Optimizer producer receipt identity",
  );
  const producer = record(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(producerBytes)),
  );
  const assets = record(producer.assets);
  assert.equal(digest(assets["python.wasm"]), original.sha256, "Original Python interpreter hash");
  if (producer.interpreterBytes !== undefined)
    assert.equal(producer.interpreterBytes, original.bytes, "Original Python interpreter size");
}
