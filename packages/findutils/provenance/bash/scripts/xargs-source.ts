import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export function verifyXargsSource(root: string) {
  const directory = resolve(root, "third-party/uutils-xargs");
  const receipt: unknown = JSON.parse(readFileSync(resolve(directory, "provenance.json"), "utf8"));
  assert.ok(
    receipt &&
      typeof receipt === "object" &&
      "repository" in receipt &&
      "revision" in receipt &&
      "files" in receipt,
  );
  assert.ok(receipt.files && typeof receipt.files === "object");
  assert.equal(receipt.repository, "https://github.com/uutils/findutils");
  assert.equal(receipt.revision, "505421d4e03586efeb7b9c55adf057599e192e0a");
  const sources = readdirSync(resolve(directory, "src"), { recursive: true, encoding: "utf8" });
  assert.deepEqual(sources, ["lib.rs"], "xargs source file set changed");
  assert.deepEqual(Object.keys(receipt.files).sort(), [
    "Cargo.toml",
    "LICENSE",
    "src/lib.rs",
    "wasi.patch",
  ]);
  for (const [path, hash] of Object.entries(receipt.files)) {
    assert.equal(
      createHash("sha256")
        .update(readFileSync(resolve(directory, path)))
        .digest("hex"),
      hash,
      path,
    );
  }
}
