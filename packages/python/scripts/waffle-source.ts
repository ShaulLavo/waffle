import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Identify the exact sibling sources used by the audit, before any producer work. */
export function auditWaffleSource(repository: string) {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository].concat(args), { encoding: "utf8" }).trim();
  const runtime = resolve(repository, "packages/waffle");
  assert.equal(realpathSync(runtime), runtime, "Runtime must be the actual sibling source");
  const pkg: unknown = JSON.parse(readFileSync(resolve(runtime, "package.json"), "utf8"));
  assert.ok(pkg && typeof pkg === "object" && "name" in pkg && "version" in pkg);
  assert.equal(pkg.name, "waffle");
  assert.equal(typeof pkg.version, "string");
  assert.equal(
    git("status", "--porcelain", "--untracked-files=all", "--", "packages/waffle"),
    "",
    "Commit runtime inputs before qualifying Python",
  );
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD:packages/waffle");
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.match(tree, /^[0-9a-f]{40}$/);
  return { commit, tree, path: "packages/waffle", version: pkg.version };
}
