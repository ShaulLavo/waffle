import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { packProgramPackage } from "./program-package.ts";

const root = resolve(import.meta.dirname, "..");
const runtimeArchive = resolve(root, ".build/runtime-input/waffle-0.0.92.tgz");
const consumer = await mkdtemp("/work/tmp/waffle-optional-packed-");
try {
  const files: Record<string, string> = { waffle: `file:${runtimeArchive}` };
  for (const family of ["python", "git"]) {
    const directory = resolve(root, "packages", family);
    const pkg: unknown = await Bun.file(resolve(directory, "package.json")).json();
    assert.ok(pkg && typeof pkg === "object" && "name" in pkg && typeof pkg.name === "string");
    files[pkg.name] = `file:${packProgramPackage(directory)}`;
  }
  await writeFile(
    resolve(consumer, "package.json"),
    JSON.stringify(
      { private: true, type: "module", dependencies: files, overrides: { waffle: files.waffle } },
      null,
      2,
    ),
  );
  execFileSync("bun", ["install", "--ignore-scripts"], { cwd: consumer, stdio: "inherit" });
  const built = await Bun.build({
    entrypoints: [resolve(root, "tools/optional-packed-app.ts")],
    target: "bun",
    outdir: consumer,
    naming: "check.js",
    external: [
      "waffle",
      "waffle/*",
      "waffle-git",
      "waffle-git/*",
      "@waffle/python",
      "@waffle/python/*",
    ],
  });
  assert.ok(built.success, String(built.logs));
  execFileSync("bun", [resolve(consumer, "check.js")], {
    cwd: consumer,
    stdio: "inherit",
    timeout: 120_000,
  });
} finally {
  await rm(consumer, { recursive: true, force: true });
}
