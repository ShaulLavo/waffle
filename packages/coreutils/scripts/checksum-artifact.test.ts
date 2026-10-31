import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { admitChecksumArtifacts, readStrippedChecksumProgram } from "./checksum-artifact.ts";
import {
  programBytesIdentity,
  transformationSourceIdentity,
} from "../../../tools/program-derivation.ts";
import {
  programOptimizationEnvironment,
  programOptimizationFlags,
  programOptimizationPolicy,
  programOptimizer,
} from "../../../tools/program-optimize.ts";

test("checksum readback refuses a caller-owned directory before reads or removal", () => {
  const root = mkdtempSync(resolve(tmpdir(), "checksum-readback-"));
  try {
    const sentinel = resolve(root, "sentinel");
    writeFileSync(sentinel, "caller data");
    assert.throws(() => admitChecksumArtifacts(root), /owned output directory/);
    assert.equal(readFileSync(sentinel, "utf8"), "caller data");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function strippedProgramFixture(
  run: (input: Parameters<typeof readStrippedChecksumProgram>[0]) => void,
) {
  const root = mkdtempSync(resolve(tmpdir(), "checksum-stripped-"));
  try {
    const encodeName = (value: string) =>
      [value.length].concat(Array.from(new TextEncoder().encode(value)));
    const imports = [1].concat(
      encodeName("wasi_snapshot_preview1"),
      encodeName("path_open"),
      [0, 0],
    );
    const final = Buffer.from(
      [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, imports.length].concat(
        imports,
        [5, 5, 1, 1, 1, 128, 32],
      ),
    );
    const raw = Buffer.concat([final, Buffer.from([0, 5, 4, 110, 97, 109, 101])]);
    const original = programBytesIdentity(raw);
    const output = programBytesIdentity(final);
    const derivationBytes = Buffer.from(
      JSON.stringify({
        operation: "optimize-and-strip-program",
        transformer: { commit: "a".repeat(40), ...transformationSourceIdentity() },
        input: original,
        operations: [
          {
            format: 1,
            stage: "wasm-opt-before-name-strip",
            input: original,
            output: original,
            producerReceipt: null,
            optimizer: {
              policy: programOptimizationPolicy,
              version: programOptimizer.version,
              sha256: programOptimizer.linuxX64Sha256,
              flags: Array.from(programOptimizationFlags),
              environment: programOptimizationEnvironment,
            },
          },
          { operation: "strip-wasm-name-sections", input: original, output },
        ],
        output,
      }),
    );
    const stagedPath = resolve(root, "sha256sum.wasm");
    writeFileSync(stagedPath, final);
    run({ raw, stagedPath, derivationBytes });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("stripped checksum readback accepts filesystem imports without requiring removed scanner names", () => {
  strippedProgramFixture((input) => {
    const final = readStrippedChecksumProgram(input);
    const module = new WebAssembly.Module(final);
    assert.equal(WebAssembly.Module.customSections(module, "name").length, 0);
    assert.ok(WebAssembly.Module.imports(module).some((entry) => entry.name === "path_open"));
    assert.deepEqual(final, readFileSync(input.stagedPath));
  });
});

test("stripped checksum readback still binds the compiler input and final output", () => {
  strippedProgramFixture((input) => {
    assert.throws(
      () => readStrippedChecksumProgram({ ...input, raw: Uint8Array.of(0) }),
      /compiler input changed/,
    );
    writeFileSync(input.stagedPath, input.raw);
    assert.throws(() => readStrippedChecksumProgram(input));
  });
});
