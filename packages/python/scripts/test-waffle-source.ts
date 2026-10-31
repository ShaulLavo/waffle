import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { auditWaffleSource } from "./waffle-source.ts";

test("Python audits the actual committed sibling and rejects modified inputs before building", () => {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "runtime-audit-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root].concat(args), { encoding: "utf8" }).trim();
  try {
    mkdirSync(resolve(root, "packages/waffle"), { recursive: true });
    writeFileSync(
      resolve(root, "packages/waffle/package.json"),
      JSON.stringify({ name: "waffle", version: "0.0.99" }),
    );
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ devDependencies: { waffle: "workspace:*" } }),
    );
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    assert.deepEqual(auditWaffleSource(root), {
      commit: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD:packages/waffle"),
      path: "packages/waffle",
      version: "0.0.99",
    });
    writeFileSync(resolve(root, "packages/waffle/uncommitted.ts"), "changed");
    assert.throws(() => auditWaffleSource(root), /Commit runtime inputs/);
    rmSync(resolve(root, "packages/waffle/uncommitted.ts"));
    writeFileSync(
      resolve(root, "packages/waffle/package.json"),
      JSON.stringify({ name: "waffle", version: "changed" }),
    );
    assert.throws(() => auditWaffleSource(root), /Commit runtime inputs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
