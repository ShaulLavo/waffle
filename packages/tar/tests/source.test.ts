import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { brotliDecompressSync } from "node:zlib";
import { buildCommand, packageRoot, sha256, sourceIdentity } from "../scripts/build-tar.ts";
import lock from "../sources.lock.json" with { type: "json" };

const read = (name: string) => readFileSync(resolve(packageRoot, name), "utf8");
test("tar upstream, patch, producer lock, and attribution have immutable identities", () => {
  assert.match(lock.upstream.revision, /^[0-9a-f]{40}$/);
  assert.ok(lock.upstream.archive.endsWith(lock.upstream.revision));
  assert.match(lock.upstream.archiveSha256, /^[0-9a-f]{64}$/);
  assert.equal(sourceIdentity(), sha256(lock.upstream.archiveSha256 + lock.patch.sha256));
  assert.match(read("producer/Cargo.lock"), /name = "tar"\nversion = "0\.4\.46"/);
  assert.match(read("licenses/LICENSE.uutils-tar"), /Permission is hereby granted/);
});
test("single guest build is offline, locked, bounded and uses only the package manifest", () => {
  for (const kind of ["native", "wasi"] satisfies Array<"native" | "wasi">) {
    const command = buildCommand(kind, { INPUT_MARKER: "preserved" });
    assert.equal(command.command, "cargo");
    assert.equal(command.timeout, 300_000);
    assert.equal(command.env.INPUT_MARKER, "preserved");
    assert.ok(command.args.includes("--offline") && command.args.includes("--locked"));
    assert.ok(command.args.includes(resolve(packageRoot, "producer/Cargo.toml")));
    assert.equal(command.args.includes("wasm32-wasip1"), kind === "wasi");
    assert.deepEqual(
      command.args.slice(-2),
      kind === "wasi" ? ["--target", "wasm32-wasip1"] : ["--bin", "tar"],
    );
  }
});
test("unsupported metadata and helpers fail explicitly, never success stubs", () => {
  const patch = read(lock.patch.path);
  assert.match(patch, /create\/extract unavailable: WASI has no UID\/GID/);
  assert.match(patch, /member selection is not supported/);
  assert.match(patch, /no external compression helpers are run/);
  assert.match(patch, /MultiGzDecoder/);
  assert.match(patch, /Consume the compressor trailer/);
});
test(
  "staged Brotli readback and source/producer identities match the actual guest",
  { skip: !process.env.TAR_CHECK_ARTIFACTS },
  () => {
    const bytes = readFileSync(resolve(packageRoot, "dist/tar.wasm"));
    const receipt: unknown = JSON.parse(read("dist/tar.sizes.json"));
    assert.ok(receipt && typeof receipt === "object" && "strippedSha256" in receipt);
    assert.equal(sha256(bytes), receipt.strippedSha256);
    assert.deepEqual(
      brotliDecompressSync(readFileSync(resolve(packageRoot, "dist/tar.wasm.br"))),
      bytes,
    );
  },
);
