import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "bun:test";
import { programLocalePackages } from "./prepare.ts";

function localPackage(root: string, name: string, dependencies: string) {
  const directory = resolve(root, name);
  mkdirSync(resolve(directory, "src"), { recursive: true });
  writeFileSync(resolve(directory, "src/lib.rs"), "");
  writeFileSync(
    resolve(directory, "Cargo.toml"),
    `[package]\nname = "${name}"\nversion = "0.0.0"\nedition = "2024"\n[dependencies]\n${dependencies}`,
  );
}

test("locale metadata uses its isolated Cargo environment and only the selected dependency graph", () => {
  const root = mkdtempSync(resolve(tmpdir(), "waffle-locale-metadata-"));
  try {
    writeFileSync(
      resolve(root, "Cargo.toml"),
      '[workspace]\nmembers = ["selected", "selected-dependency", "unrelated", "unrelated-dependency"]\nresolver = "3"\n',
    );
    localPackage(root, "selected", 'selected-dependency = { path = "../selected-dependency" }\n');
    localPackage(root, "selected-dependency", "");
    localPackage(
      root,
      "unrelated",
      'unrelated-dependency = { path = "../unrelated-dependency" }\n',
    );
    localPackage(root, "unrelated-dependency", "");
    const env = { ...process.env, CARGO_HOME: resolve(root, "cargo-home") };
    const manifest = resolve(root, "selected/Cargo.toml");
    execFileSync("cargo", ["generate-lockfile", "--manifest-path", manifest], { env });
    const lock = readFileSync(resolve(root, "Cargo.lock"), "utf8");
    const names = programLocalePackages(manifest, env)
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(names, ["selected", "selected-dependency"]);
    assert.equal(readFileSync(resolve(root, "Cargo.lock"), "utf8"), lock);
    assert.throws(
      () => programLocalePackages(resolve(root, "Cargo.toml"), env),
      /package manifest/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
