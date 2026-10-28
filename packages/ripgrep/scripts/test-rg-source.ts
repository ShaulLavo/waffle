import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { patchRipgrepSource } from "./rg-source.ts";

function checkPatch(linked: boolean) {
  const root = mkdtempSync(resolve(tmpdir(), "rg-source-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const source = resolve(root, linked ? "cache/ripgrep" : ".sources/ripgrep");
    mkdirSync(source, { recursive: true });
    if (linked) symlinkSync(resolve(root, "cache"), resolve(root, ".sources"));
    writeFileSync(resolve(source, "stdin.txt"), "upstream stdin\n");
    const patch = resolve(root, "wasi.patch");
    writeFileSync(
      patch,
      "diff --git a/stdin.txt b/stdin.txt\n--- a/stdin.txt\n+++ b/stdin.txt\n@@ -1 +1 @@\n-upstream stdin\n+WASI stdin\n",
    );
    patchRipgrepSource(resolve(root, ".sources/ripgrep"), patch);
    assert.equal(readFileSync(resolve(source, "stdin.txt"), "utf8"), "WASI stdin\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const linked of [false, true]) {
  test(`ripgrep patch applies inside an enclosing Git repository with ${linked ? "linked" : "ordinary"} sources`, () =>
    checkPatch(linked));
}
