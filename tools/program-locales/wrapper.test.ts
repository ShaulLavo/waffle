import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test("unrelated compiler calls retain their exact argument vector", () => {
  const args = ["first argument", "a'b", "--crate-name", "not_uucore"];
  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "rustc-wrapper.ts"), "/usr/bin/printf", "%s\\n"].concat(args),
    { env: { ...process.env, CARGO_PKG_NAME: "other" }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, args.join("\n") + "\n");
});

test("uucore version drift fails before an unpinned build script compiles", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "waffle-locale-wrapper-"));
  try {
    const source = resolve(directory, "build.rs");
    writeFileSync(source, "fn main() {}\n");
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "rustc-wrapper.ts"), "/usr/bin/false", source],
      {
        env: {
          ...process.env,
          CARGO_PKG_NAME: "uucore",
          CARGO_PKG_VERSION: "0.14.0",
          WAFFLE_PROGRAM_LOCALE_INPUTS: directory,
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported uucore version/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
