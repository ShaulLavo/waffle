import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
import { test } from "node:test";

test("find source receipt covers the license, manifest, every source file and patch", async () => {
  const receipt: unknown = JSON.parse(await readFile(resolve(root, "provenance/find.source.json"), "utf8"));
  assert.ok(
    receipt &&
      typeof receipt === "object" &&
      "vendor" in receipt &&
      "files" in receipt &&
      "patch" in receipt &&
      "license" in receipt,
  );
  assert.equal(typeof receipt.vendor, "string");
  assert.ok(typeof receipt.vendor === "string");
  assert.ok(receipt.files && typeof receipt.files === "object");
  const actual = (await readdir(resolve(root, receipt.vendor), { recursive: true }))
    .filter((path) => path.endsWith(".rs") || path === "Cargo.toml" || path === "LICENSE")
    .sort();
  assert.deepEqual(actual, Object.keys(receipt.files).sort());
  for (const [path, digest] of Object.entries(receipt.files)) {
    const bytes: Uint8Array = await readFile(resolve(root, receipt.vendor, path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, path);
  }
  assert.ok(
    receipt.patch &&
      typeof receipt.patch === "object" &&
      "path" in receipt.patch &&
      "sha256" in receipt.patch,
  );
  assert.ok(typeof receipt.patch.path === "string");
  const patch = await readFile(resolve(root, receipt.patch.path));
  assert.equal(createHash("sha256").update(patch).digest("hex"), receipt.patch.sha256);
  assert.ok(receipt.license && typeof receipt.license === "object" && "sha256" in receipt.license);
  assert.ok("LICENSE" in receipt.files);
  assert.equal(receipt.files.LICENSE, receipt.license.sha256);
});
