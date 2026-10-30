import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
import { sourceLock as lock } from "./source-lock.ts";

test("awk source receipt is pinned to the authoritative archive", () => {
  assert.equal(lock.upstream.revision, "5739fd79bcfc75ba7526773d0cf634521f8aca3c");
  assert.equal(
    lock.upstream.archiveSha256,
    "14b636bec87f5817012d883b9b318e808eee28881a7b4388f92ef6b5f940d7ef",
  );
  const license = readFileSync(resolve(root, "LICENSE"));
  assert.equal(createHash("sha256").update(license).digest("hex"), lock.upstream.licenseSha256);
});

test("WASI adaptation is an explicit patch", () => {
  const patch = readFileSync(resolve(root, "patches/wasi-unsupported-ops.patch"));
  assert.match(patch.toString(), /system is unavailable on the Waffle WASI guest/);
  assert.match(patch.toString(), /command pipes are unavailable on the Waffle WASI guest/);
  const recipe: unknown = JSON.parse(readFileSync(resolve(root, "build-recipe.json"), "utf8"));
  assert.ok(
    recipe &&
      typeof recipe === "object" &&
      "patch" in recipe &&
      recipe.patch &&
      typeof recipe.patch === "object" &&
      "sha256" in recipe.patch,
  );
  assert.equal(createHash("sha256").update(patch).digest("hex"), recipe.patch.sha256);
});

test("WASI build retains real setjmp and uses the shared verifier before name stripping", () => {
  const build = readFileSync(resolve(root, "scripts/build-awk.ts"), "utf8");
  for (const flag of ["-wasm-enable-sjlj", "-wasm-use-legacy-eh=false", "-lsetjmp"])
    assert.ok(build.includes(flag), flag);
  assert.ok(build.includes("verifyWasiGuest(guest"));
  assert.ok(build.includes("stageProgram(guest, output, { sdk: config.sdk })"));
});
