import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { stageProgram } from "./program-build-tools.ts";
import { programBytesIdentity, validateProgramDerivation } from "./program-derivation.ts";
import { cappedWasiFixture } from "../packages/python/scripts/wasi-artifact-fixture.ts";

function fixture(
  run: (receipt: ReturnType<typeof stageProgram>, bytes: Buffer, producer: Buffer) => void,
) {
  const parent =
    process.env.PROGRAM_OPTIMIZER_TEST_ROOT ?? resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(resolve(parent, "derivation-test-"));
  try {
    const source = resolve(directory, "input.wasm");
    const output = resolve(directory, "python.wasm");
    writeFileSync(source, cappedWasiFixture);
    const producer = Buffer.from(
      JSON.stringify({
        assets: { "python.wasm": programBytesIdentity(cappedWasiFixture).sha256 },
        interpreterBytes: cappedWasiFixture.length,
      }),
    );
    const producerPath = resolve(directory, "python-build.json");
    writeFileSync(producerPath, producer);
    const receipt = stageProgram(source, output, {}, producerPath);
    run(receipt, readFileSync(output), producer);
    assert.deepEqual(readFileSync(producerPath), producer, "Original producer stays immutable");
    assert.deepEqual(readFileSync(source), Buffer.from(cappedWasiFixture));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("strict Python derivation binds producer, optimizer, strip and actual final bytes", () => {
  fixture((receipt, bytes, producer) => {
    validateProgramDerivation(receipt, bytes, producer);
    assert.throws(() => validateProgramDerivation({}, bytes, producer));
    assert.throws(() => validateProgramDerivation(receipt, Uint8Array.of(0), producer));
    assert.throws(() => validateProgramDerivation(receipt, bytes));
    assert.throws(() => validateProgramDerivation(receipt, bytes, Buffer.from("{}")));
  });
});

test("transformer commit is provenance, while actual transformation hashes govern currentness", () => {
  fixture((receipt, bytes, producer) => {
    receipt.transformer.commit = "a".repeat(40);
    validateProgramDerivation(receipt, bytes, producer);
    receipt.transformer.optimizerSourceSha256 = "b".repeat(64);
    assert.throws(
      () => validateProgramDerivation(receipt, bytes, producer),
      /Optimizer source changed/,
    );
  });
});

const corruptions: readonly [string, (value: Record<string, unknown>) => void][] = [
  [
    "wrong operation",
    (value) => {
      value.operation = "strip-wasm-name-sections";
    },
  ],
  [
    "missing chain",
    (value) => {
      value.operations = [];
    },
  ],
  [
    "stale final",
    (value) => {
      value.output = { bytes: 8, sha256: "0".repeat(64) };
    },
  ],
  [
    "nonfinite size",
    (value) => {
      value.input = { bytes: Infinity, sha256: "0".repeat(64) };
    },
  ],
  [
    "oversized size",
    (value) => {
      value.input = { bytes: 2 ** 32, sha256: "0".repeat(64) };
    },
  ],
  [
    "fractional size",
    (value) => {
      value.input = { bytes: 8.5, sha256: "0".repeat(64) };
    },
  ],
  [
    "invalid hash",
    (value) => {
      value.input = { bytes: 8, sha256: "xyz" };
    },
  ],
  [
    "stale producer",
    (value) => {
      value.producerReceiptSha256 = "0".repeat(64);
    },
  ],
];
for (const [description, corrupt] of corruptions) {
  test(`derivation rejects ${description}`, () => {
    fixture((receipt, bytes, producer) => {
      const changed: Record<string, unknown> = JSON.parse(JSON.stringify(receipt));
      corrupt(changed);
      assert.throws(() => validateProgramDerivation(changed, bytes, producer));
    });
  });
}

test("every optimizer policy and chain field is checked, not just nonempty receipt JSON", () => {
  fixture((receipt, bytes, producer) => {
    for (const field of ["policy", "version", "sha256", "flags", "environment"]) {
      const optimized = receipt.operations[0];
      assert.ok(optimized && "optimizer" in optimized);
      const changed = {
        ...receipt,
        operations: [
          { ...optimized, optimizer: { ...optimized.optimizer, [field]: null } },
          receipt.operations[1],
        ],
      };
      assert.throws(() => validateProgramDerivation(changed, bytes, producer));
    }
    const strip = receipt.operations[1];
    assert.ok(strip);
    assert.throws(() =>
      validateProgramDerivation(
        { ...receipt, operations: [receipt.operations[0], { ...strip, input: receipt.output }] },
        bytes,
        producer,
      ),
    );
    const wrongSize = Buffer.from(
      JSON.stringify({
        assets: { "python.wasm": receipt.input.sha256 },
        interpreterBytes: receipt.input.bytes + 1,
      }),
    );
    const optimized = receipt.operations[0];
    assert.ok(optimized);
    const changed = {
      ...receipt,
      producerReceiptSha256: programBytesIdentity(wrongSize).sha256,
      operations: [{ ...optimized, producerReceipt: programBytesIdentity(wrongSize) }, strip],
    };
    assert.throws(
      () => validateProgramDerivation(changed, bytes, wrongSize),
      /Original Python interpreter size/,
    );
  });
});

test("one stage operation publishes deterministic final outputs to multiple destinations", () => {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(resolve(parent, "stage-twins-"));
  try {
    const source = resolve(directory, "source.wasm");
    writeFileSync(source, cappedWasiFixture);
    const first = resolve(directory, "first.wasm");
    const second = resolve(directory, "second.wasm");
    for (const path of [first, second]) {
      writeFileSync(`${path}.gz`, "stale gzip");
      writeFileSync(`${path}.br`, "stale Brotli");
    }
    const receipt = stageProgram(source, [first, second]);
    const readOutputs = (path: string) => ({
      bytes: readFileSync(path),
      gzip: readFileSync(`${path}.gz`),
      brotli: readFileSync(`${path}.br`),
      receipt: readFileSync(path.replace(/\.wasm$/, "-program.json")),
    });
    const firstOutputs = readOutputs(first);
    assert.deepEqual(readOutputs(second), firstOutputs);
    assert.ok(gunzipSync(firstOutputs.gzip).equals(firstOutputs.bytes));
    assert.ok(brotliDecompressSync(firstOutputs.brotli).equals(firstOutputs.bytes));
    validateProgramDerivation(receipt, firstOutputs.bytes);
    stageProgram(source, [first, second]);
    assert.deepEqual(readOutputs(first), firstOutputs, "repeat staging is deterministic");
    assert.deepEqual(readOutputs(second), firstOutputs, "repeat twin staging is deterministic");
    assert.throws(() => stageProgram(source, source), /must differ|aliases compiler input/);
    assert.deepEqual(readFileSync(source), Buffer.from(cappedWasiFixture));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
