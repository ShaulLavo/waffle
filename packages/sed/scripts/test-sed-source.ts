import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { registerSourceContractTest } from "../../../tools/source-contract-test.ts";
import { verifySedSource } from "./sed-source.ts";

const root = resolve(import.meta.dirname, "..");

registerSourceContractTest(
  root,
  {
    name: "sed source matches its receipt and reverses to the pinned upstream source",
    scratchName: "sed-source",
    sourceDirectory: "third-party/uutils-sed",
    patch: "wasi.patch",
    verify: verifySedSource,
    verifyReversed(directory, receipt) {
      for (const [path, hash] of Object.entries(receipt.upstreamFiles as Record<string, string>)) {
        const bytes = readFileSync(resolve(directory, path));
        assert.equal(createHash("sha256").update(bytes).digest("hex"), hash, path);
      }
    },
    verifyDrift(scratch, directory) {
      assert.throws(() => verifySedSource(scratch), /compiler.rs/);
      cpSync(resolve(root, "third-party/uutils-sed/src"), resolve(directory, "src"), {
        recursive: true,
      });
      writeFileSync(resolve(directory, "src/invented.rs"), "");
      assert.throws(() => verifySedSource(scratch), /file set/);
    },
  },
  test,
);
