import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { registerSourceContractTest } from "./source-contract-test.ts";
import { verifyXargsSource } from "./xargs-source.ts";

const root = resolve(import.meta.dirname, "..");

registerSourceContractTest(
  root,
  {
    name: "xargs source reverses to the surveyed upstream revision and rejects drift",
    scratchName: "xargs-source",
    sourceDirectory: "third-party/uutils-xargs",
    patch: "wasi.patch",
    verify: verifyXargsSource,
    verifyReversed(directory, receipt) {
      assert.equal(
        createHash("sha256")
          .update(readFileSync(resolve(directory, "src/lib.rs")))
          .digest("hex"),
        receipt.upstreamSha256,
      );
    },
    verifyDrift(scratch, directory) {
      assert.throws(() => verifyXargsSource(scratch), /src\/lib.rs/);
      cpSync(
        resolve(root, "third-party/uutils-xargs/src/lib.rs"),
        resolve(directory, "src/lib.rs"),
      );
      writeFileSync(resolve(directory, "src/invented.rs"), "");
      assert.throws(() => verifyXargsSource(scratch), /file set/);
    },
  },
  test,
);
