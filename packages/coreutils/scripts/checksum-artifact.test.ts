import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { admitChecksumArtifacts } from "./checksum-artifact.ts";

test("checksum readback refuses a caller-owned directory before reads or removal", () => {
  const root = mkdtempSync(resolve(tmpdir(), "checksum-readback-"));
  try {
    const sentinel = resolve(root, "sentinel");
    writeFileSync(sentinel, "caller data");
    assert.throws(() => admitChecksumArtifacts(root), /owned output directory/);
    assert.equal(readFileSync(sentinel, "utf8"), "caller data");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
