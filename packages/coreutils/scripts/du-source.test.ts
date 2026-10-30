import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import source from "../provenance/du.source.json" with { type: "json" };
import { duCases } from "../fixtures/du-cases.ts";
import { verifyDuOracle } from "./du-oracle.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("du isolates the exact upstream pin without changing its implementation", () => {
  const manifest = readFileSync(resolve(packageRoot, "crates/du/Cargo.toml"), "utf8");
  assert.equal(manifest.split(`rev = "${source.revision}"`).length - 1, 2);
  assert.equal(
    sha256(readFileSync(resolve(packageRoot, source.license.localPath))),
    source.license.sha256,
  );
  const entry = readFileSync(resolve(packageRoot, "crates/du/src/main.rs"), "utf8");
  assert.match(entry, /uucore::bin!\(uu_du\);/);
  assert.match(entry, /cwd::initialize\("du"\);/);
  assert.equal(duCases.length, 28);
  assert.equal(new Set(duCases.map((item) => item.name)).size, duCases.length);
});

test(
  "du upstream files and checkout identity match the retained source receipt",
  {
    skip:
      !process.env.DU_UPSTREAM_ROOT && "Set DU_UPSTREAM_ROOT to verify the resolved Cargo source",
  },
  () => {
    const root = process.env.DU_UPSTREAM_ROOT;
    assert.ok(root);
    assert.equal(
      execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
        timeout: 10_000,
      }).trim(),
      source.revision,
    );
    for (const [path, hash] of Object.entries(source.upstreamFiles)) {
      assert.equal(sha256(readFileSync(resolve(root, path))), hash, path);
    }
  },
);

test("du native oracle rejects changed bytes before executing them", () => {
  assert.throws(
    () => verifyDuOracle(resolve(packageRoot, "crates/du/LICENSE")),
    /Unpinned native du oracle/,
  );
});

test(
  "du native oracle identity matches before comparisons",
  {
    skip:
      !process.env.DU_VERIFY_NATIVE_ORACLE && "Native oracle identity is an explicit local check",
  },
  () => {
    assert.deepEqual(verifyDuOracle(), source.nativeOracle);
  },
);
