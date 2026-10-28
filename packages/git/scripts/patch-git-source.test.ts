import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { replacePatchedFile } from "./patch-git-source.ts";

test("patch replacement preserves the shared cache's hard-linked bytes", () => {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "cache-isolation-"));
  try {
    const cache = resolve(root, "cache.js"),
      installed = resolve(root, "installed.js");
    writeFileSync(cache, "original");
    linkSync(cache, installed);
    replacePatchedFile(installed, "patched");
    assert.equal(readFileSync(cache, "utf8"), "original");
    assert.equal(readFileSync(installed, "utf8"), "patched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
