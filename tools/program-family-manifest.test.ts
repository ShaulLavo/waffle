import assert from "node:assert/strict";
import { test } from "node:test";
import { coreutils } from "../packages/coreutils/src/index.ts";
import { findutils } from "../packages/findutils/src/index.ts";
import { grep } from "../packages/grep/src/index.ts";
import { ripgrep } from "../packages/ripgrep/src/index.ts";
import { sed } from "../packages/sed/src/index.ts";

const families = [coreutils, findutils, grep, ripgrep, sed];

test("base family sources cover 23 unique canonical programs", () => {
  const programs = families.flatMap((family) => family.programs);
  assert.equal(programs.length, 23);
  assert.equal(new Set(programs.map((program) => program.path)).size, 23);
  for (const program of programs) {
    assert.match(program.path, /^\/usr\/bin\/[^/]+$/);
    assert.deepEqual(program.aliases, [program.path.replace("/usr/", "/")]);
    assert.ok(program.wasm instanceof URL);
  }
});

test("family identities and program names are stable", () => {
  assert.deepEqual(
    families.map((family) => family.name),
    ["coreutils", "findutils", "grep", "ripgrep", "sed"],
  );
  assert.deepEqual(
    coreutils.programs.map((program) => program.path.slice("/usr/bin/".length)),
    [
      "env",
      "clear",
      "cat",
      "cut",
      "tr",
      "head",
      "which",
      "ls",
      "mkdir",
      "seq",
      "sort",
      "tail",
      "uniq",
      "wc",
      "touch",
      "rm",
      "cp",
      "mv",
    ],
  );
});

test("artifact admission lists every exported family guest and its notices", async () => {
  for (const family of families) {
    const recipe: unknown = await Bun.file(
      new URL(`../packages/${family.name}/package-artifacts.json`, import.meta.url),
    ).json();
    assert.ok(
      recipe && typeof recipe === "object" && "files" in recipe && Array.isArray(recipe.files),
    );
    const files: unknown[] = recipe.files;
    assert.deepEqual(
      files.filter((file) => typeof file === "string" && file.endsWith(".wasm")).sort(),
      family.programs.map((program) => `dist/${program.path.split("/").at(-1)}.wasm`).sort(),
    );
    assert.equal(
      files.filter((file) => typeof file === "string" && /NOTICES\.txt$/.test(file)).length,
      1,
    );
  }
});
