import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export function verifySedSource(root: string) {
  const directory = resolve(root, "third-party/uutils-sed");
  const receipt: unknown = JSON.parse(readFileSync(resolve(directory, "provenance.json"), "utf8"));
  assert.ok(receipt && typeof receipt === "object" && "files" in receipt);
  assert.ok(receipt.files && typeof receipt.files === "object");
  const actual = readdirSync(resolve(directory, "src"), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".rs"))
    .map((name) => `src/${name}`)
    .sort();
  assert.deepEqual(actual, Object.keys(receipt.files).sort(), "sed source file set changed");
  for (const [path, hash] of Object.entries(receipt.files)) {
    const bytes = readFileSync(resolve(directory, path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hash, path);
  }
}
