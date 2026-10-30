import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import source from "../provenance/tee.source.json" with { type: "json" };
import { workspaceRoot, packageRoot } from "./build-config.ts";
import { singleProgramBuilds } from "../../../tools/program-locales/prepare.ts";
import { selectCatalogs } from "../../../tools/program-locales/selection.ts";
import { verifyGnuTee } from "./tee-oracle.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function upstreamRoot() {
  const metadata: unknown = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--offline",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        "wasm32-wasip1",
        "--manifest-path",
        resolve(packageRoot, "crates/tee/Cargo.toml"),
      ],
      { cwd: workspaceRoot, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  const packages = record(metadata).packages;
  assert.ok(Array.isArray(packages));
  const pkg = packages.map(record).find((entry) => entry.name === "uu_tee");
  assert.ok(pkg);
  assert.equal(pkg.version, source.packages.uu_tee.version);
  assert.equal(pkg.source, `git+${source.repository}?rev=${source.revision}#${source.revision}`);
  assert.equal(typeof pkg.manifest_path, "string");
  return resolve(dirname(String(pkg.manifest_path)), "../../..");
}

test("tee uses the unchanged pinned upstream and retained MIT notice", () => {
  const root = upstreamRoot();
  for (const [path, hash] of Object.entries(source.upstreamFiles))
    assert.equal(
      createHash("sha256")
        .update(readFileSync(resolve(root, path)))
        .digest("hex"),
      hash,
      path,
    );
  assert.equal(
    createHash("sha256")
      .update(readFileSync(resolve(packageRoot, source.license.localPath)))
      .digest("hex"),
    source.license.sha256,
  );
});

test("tee uses only its isolated single-program locale route", () => {
  assert.deepEqual(singleProgramBuilds(["-p", "waffle-tee", "--bin", "tee"], ["tee"]), [
    { program: "tee", args: ["-p", "waffle-tee", "--bin", "tee"] },
  ]);
  assert.deepEqual(selectCatalogs("tee", "0.13.0"), [
    "uucore/en-US.ftl",
    "uucore-errors/en-US.ftl",
    "tee/en-US.ftl",
  ]);
});

test("GNU oracle identity is pinned before parity comparisons", () => {
  const oracle = verifyGnuTee();
  assert.equal(oracle.version, source.oracle.version);
  assert.equal(oracle.sha256, createHash("sha256").update(readFileSync(oracle.path)).digest("hex"));
});
