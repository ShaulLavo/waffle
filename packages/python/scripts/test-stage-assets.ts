import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { pythonSource } from "./python-source.ts";
import { verifyPythonReceipt } from "./stage-assets.ts";

test("staging requires an accepted receipt and exact source/patch identity", () => {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "receipt-test-"));
  const put = (source: unknown) => {
    const bytes = JSON.stringify(source);
    writeFileSync(resolve(root, "python-build.json"), bytes);
    return createHash("sha256").update(bytes).digest("hex");
  };
  try {
    const receipt = {
      cpython: pythonSource.revision,
      source: pythonSource,
      sourcePatch: pythonSource.patch,
      payloadFiles: 2650,
      waffle: "original-producer-runtime",
    };
    const accepted = put(receipt);
    assert.equal(verifyPythonReceipt(root, accepted).waffle, "original-producer-runtime");
    assert.throws(() => verifyPythonReceipt(root, "0".repeat(64)), /receipt SHA-256/);
    const different = put({ ...receipt, sourcePatch: { ...pythonSource.patch, sha256: "wrong" } });
    assert.throws(() => verifyPythonReceipt(root, different), /startup patch/);
    const pruned = put({ ...receipt, payloadFiles: 2649 });
    assert.throws(() => verifyPythonReceipt(root, pruned), /unpruned/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
