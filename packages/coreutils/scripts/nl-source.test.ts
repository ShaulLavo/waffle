import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import source from "../provenance/nl.source.json" with { type: "json" };
import { packageRoot, workspaceRoot } from "./build-config.ts";
import { coreutilsNames, verificationOptions } from "./programs.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function upstreamRoot(): string {
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
      ],
      { cwd: workspaceRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ),
  );
  const packages = record(metadata).packages;
  assert.ok(Array.isArray(packages));
  const upstream = packages.map(record).find((pkg) => pkg.name === "uu_nl");
  assert.ok(upstream);
  assert.equal(upstream.version, source.packages.uu_nl.version);
  assert.equal(
    upstream.source,
    `git+${source.repository}?rev=${source.revision}#${source.revision}`,
  );
  assert.equal(typeof upstream.manifest_path, "string");
  return resolve(dirname(String(upstream.manifest_path)), "../../..");
}

test("nl uses the pinned unmodified upstream source and retained MIT notice", () => {
  const root = upstreamRoot();
  for (const [path, hash] of Object.entries(source.upstreamFiles)) {
    assert.equal(
      createHash("sha256")
        .update(readFileSync(resolve(root, path)))
        .digest("hex"),
      hash,
      path,
    );
  }
  const license = resolve(packageRoot, source.license.localPath);
  assert.equal(
    createHash("sha256").update(readFileSync(license)).digest("hex"),
    source.license.sha256,
  );
});

test("nl is an ordinary independently verified WASI family member", () => {
  assert.ok(coreutilsNames.includes("nl"));
  assert.deepEqual(verificationOptions("nl"), {});
});
