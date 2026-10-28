import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Glob, YAML } from "bun";
import { test } from "bun:test";

const root = new URL("../../../", import.meta.url);
function read(path: string) {
  return readFileSync(new URL(path, root), "utf8");
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value;
}
function steps(job: unknown) {
  const value = record(job).steps;
  assert.ok(Array.isArray(value));
  return value.map(record);
}
function parse(path: string) {
  return record(YAML.parse(read(path)));
}
const jobs = record(parse(".github/workflows/ci.yml").jobs);
const producer = record(
  record(parse(".github/workflows/findutils-xargs.yml").jobs)["xargs-process"],
);
const consumer = record(record(parse(".github/workflows/coreutils-echo.yml").jobs)["echo-process"]);

test("echo-only changes select a same-run xargs producer without repeating its unchanged suite", () => {
  const paths = steps(jobs.changes).find((step) => step.id === "paths");
  const filters = record(YAML.parse(String(record(paths?.with).filters)));
  const patterns = filters.coreutils;
  assert.ok(Array.isArray(patterns));
  for (const path of [
    "Cargo.toml",
    "Cargo.lock",
    "bun.lock",
    "rust-toolchain.toml",
    "packages/coreutils/crates/echo/src/main.rs",
    "packages/coreutils/crates/echo/build.rs",
    "packages/findutils/scripts/xargs-artifact.ts",
    "packages/process-consumer/src/wasi.rs",
    "packages/program-support/src/runtime/wasi.rs",
    "tools/program-build-tools.ts",
    "tools/family-acceptance.ts",
  ])
    assert.ok(
      patterns.some((pattern) => new Glob(String(pattern)).match(path)),
      path,
    );
  assert.deepEqual(record(jobs["coreutils-echo"]).needs, [
    "changes",
    "network-wasm",
    "findutils-xargs",
  ]);
  assert.ok(
    String(record(jobs["findutils-xargs"]).if).includes(
      "needs.changes.outputs.coreutils == 'true'",
    ),
  );
  const selected = String(record(record(jobs["findutils-xargs"]).with)["test-process"]);
  assert.ok(selected.includes("needs.changes.outputs.findutils == 'true'"));
  assert.ok(!selected.includes("outputs.coreutils"));
  const suite = steps(producer).find(
    (step) => step.run === "bun run --cwd packages/findutils test:xargs:wasi",
  );
  assert.equal(suite?.if, "inputs.test-process");
});

test("consumer verifies the exact same-run artifact and never builds xargs or network", () => {
  const upload = steps(producer).find((step) => step.uses === "actions/upload-artifact@v4");
  const download = steps(consumer).find((step) => step.uses === "actions/download-artifact@v4");
  assert.equal(
    record(upload?.with).name,
    "xargs-process-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.equal(record(download?.with).name, record(upload?.with).name);
  assert.equal(record(upload?.with)["if-no-files-found"], "error");
  assert.equal(record(consumer.env).WAFFLE_NETWORK_PREBUILT, "1");
  const commands = steps(consumer)
    .map((step) => String(step.run))
    .join("\n");
  assert.ok(commands.includes("build:echo"));
  assert.ok(
    !commands.includes("build:xargs") &&
      !commands.includes("build:network") &&
      !commands.includes("test:native"),
  );
  const source = read("packages/findutils/scripts/xargs-artifact.ts");
  for (const check of [
    "GITHUB_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "dirty producer inputs",
    "assert.deepEqual(actual, expected",
    "verifyWasiGuest(path)",
  ])
    assert.ok(source.includes(check), check);
});

test("network and singular libc caches are shared exactly and native compilation stays one lane", () => {
  const network = steps(jobs["network-wasm"]).find((step) => step.id === "network-artifact");
  const libc = steps(producer).find((step) => step.id === "libc");
  for (const job of [producer, consumer]) {
    const restored = steps(job).find((step) => step.id === "network");
    assert.equal(record(restored?.with).key, record(network?.with).key);
    assert.equal(record(restored?.with).path, record(network?.with).path);
    assert.equal(record(restored?.with)["fail-on-cache-miss"], true);
    assert.deepEqual(steps(job).find((step) => step.id === "libc")?.with, libc?.with);
  }
  const native = steps(jobs.programs).filter((step) => String(step.run).startsWith("cargo test "));
  assert.equal(native.length, 1);
  assert.equal(String(native[0]?.run).split("-p waffle-echo").length, 2);
});

test("echo source, pin and copied upstream license are current and explicit", () => {
  const provenance = record(JSON.parse(read("packages/coreutils/provenance/echo.source.json")));
  const pin = "07763857f6b9a547742a994b58aef0ccd036198b";
  assert.equal(provenance.revision, pin);
  assert.equal(read("packages/coreutils/crates/echo/Cargo.toml").split(pin).length, 3);
  assert.equal(
    createHash("sha256").update(read("packages/coreutils/crates/echo/LICENSE")).digest("hex"),
    record(provenance.license).sha256,
  );
  assert.ok(!read("packages/coreutils/crates/echo/src/main.rs").includes("args_os"));
});
