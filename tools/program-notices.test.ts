import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { rustDependencyNotices } from "./program-notices.ts";

test("notices include locked production dependencies and reject missing license text", () => {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "notices-"));
  try {
    for (const name of ["family", "dependency"]) {
      mkdirSync(resolve(root, name));
      writeFileSync(resolve(root, name, "LICENSE"), `${name} license`);
    }
    const packages = ["family", "dependency", "dev-only"].map((name) => ({
      id: name,
      name,
      version: "1.2.3",
      manifest_path: resolve(root, name, "Cargo.toml"),
    }));
    const metadata = {
      packages,
      resolve: {
        nodes: [
          {
            id: "family",
            deps: [
              { pkg: "dependency", dep_kinds: [{ kind: null }] },
              { pkg: "dev-only", dep_kinds: [{ kind: "dev" }] },
            ],
          },
          { id: "dependency", deps: [] },
        ],
      },
    };
    const notices = rustDependencyNotices(metadata, ["family"]);
    assert.match(notices, /dependency 1.2.3/);
    assert.match(notices, /dependency license/);
    assert.doesNotMatch(notices, /dev-only/);
    rmSync(resolve(root, "dependency/LICENSE"));
    assert.throws(() => rustDependencyNotices(metadata, ["family"]), /Missing license/);
    assert.throws(() => rustDependencyNotices(metadata, ["missing"]), /Missing family root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
