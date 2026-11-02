import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import source from "../provenance/sleep.source.json" with { type: "json" };
import { singleProgramBuilds } from "../../../tools/program-locales/prepare.ts";
import { selectCatalogs } from "../../../tools/program-locales/selection.ts";
import { packageRoot, workspaceRoot } from "./build-config.ts";
import { verifyGnuSleep } from "./sleep-oracle.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function upstreamRoot() {
  const data: unknown = JSON.parse(
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
        resolve(packageRoot, "crates/sleep/Cargo.toml"),
      ],
      { cwd: workspaceRoot, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  const packages = record(data).packages;
  assert.ok(Array.isArray(packages));
  const pkg = packages.map(record).find((entry) => entry.name === "uu_sleep");
  assert.ok(pkg);
  assert.equal(pkg.version, source.packages.uu_sleep.version);
  assert.equal(pkg.source, `git+${source.repository}?rev=${source.revision}#${source.revision}`);
  assert.equal(typeof pkg.manifest_path, "string");
  return resolve(dirname(String(pkg.manifest_path)), "../../..");
}

test(
  "sleep delegates to the unmodified pinned evaluator",
  { skip: !process.env.SLEEP_VERIFY_INTEGRATION },
  () => {
    const root = upstreamRoot();
    for (const [path, hash] of Object.entries(source.upstreamFiles))
      assert.equal(sha256(readFileSync(resolve(root, path))), hash, path);
    assert.equal(
      sha256(readFileSync(resolve(packageRoot, source.license.localPath))),
      source.license.sha256,
    );
  },
);

test("sleep entry contains no replacement timer or parser", () => {
  assert.equal(
    readFileSync(resolve(packageRoot, "crates/sleep/src/main.rs"), "utf8"),
    "uucore::bin!(uu_sleep);\n",
  );
  const manifest = readFileSync(resolve(packageRoot, "crates/sleep/Cargo.toml"), "utf8");
  assert.match(manifest, /name = "waffle-sleep"/);
  assert.equal(manifest.split(`rev = "${source.revision}"`).length - 1, 2);
});

test(
  "sleep build selects only the isolated package and binary",
  { skip: !process.env.SLEEP_VERIFY_INTEGRATION },
  () => {
    assert.deepEqual(singleProgramBuilds(["-p", "waffle-sleep", "--bin", "sleep"], ["sleep"]), [
      { program: "sleep", args: ["-p", "waffle-sleep", "--bin", "sleep"] },
    ]);
    assert.deepEqual(selectCatalogs("sleep", "0.13.0"), [
      "uucore/en-US.ftl",
      "uucore-errors/en-US.ftl",
      "sleep/en-US.ftl",
    ]);
    const adapter = readFileSync(resolve(packageRoot, "scripts/build-sleep.ts"), "utf8");
    assert.match(
      adapter,
      /buildFamilyPrograms\(\["-p", "waffle-sleep", "--bin", "sleep"\], \["sleep"\], options\)/,
    );
  },
);

test("GNU sleep is verified before any oracle comparison", () => {
  assert.equal(verifyGnuSleep().sha256, source.oracle.sha256);
});
