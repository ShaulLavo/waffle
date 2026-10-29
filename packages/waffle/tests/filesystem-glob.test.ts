import { expect, test } from "bun:test";
import { compileGlob } from "../fs/glob.js";
import type { GlobPattern } from "../fs/walk.js";

const cases: readonly [GlobPattern["kind"], string, string, boolean][] = [
  ["basename", "*.ts", "src/a.ts", true],
  ["basename", "*.ts", "a.tsx", false],
  ["path", "*.ts", "src/a.ts", false],
  ["path", "**/*.ts", "a.ts", true],
  ["path", "**/*.ts", "src/deep/a.ts", true],
  ["path", "src/**/a.?s", "src/a.ts", true],
  ["path", "src/**/a.?s", "src/x/y/a.js", true],
  ["path", "{src,test}/**/*.{ts,tsx}", "test/a.tsx", true],
  ["basename", "file[0-9].ts", "file5.ts", true],
  ["basename", "file[!0-9].ts", "filea.ts", true],
  ["basename", "file[^0-9].ts", "file5.ts", false],
  ["path", "a?b", "a/b", false],
  ["basename", "a\\*b", "a*b", true],
  ["path", "a.b", "axb", false],
  ["path", "?", "💡", true],
  ["path", "💡", "💡", true],
];
for (const [kind, glob, path, matched] of cases) {
  test(`${kind} ${glob} matches ${path}: ${matched}`, () => {
    expect(compileGlob({ kind, glob })(path)).toBe(matched);
  });
}
for (const glob of ["[", "{a,b", "a}", "a\\", "[z-a]", "[/]", "{".repeat(10), "x".repeat(1025)]) {
  test(`reject malformed or excessive glob ${glob.slice(0, 30)}`, () => {
    expect(() => compileGlob({ kind: "path", glob })).toThrow();
  });
}
test("star matching has bounded state for repeated wildcard prefixes", () => {
  expect(compileGlob({ kind: "path", glob: "*a".repeat(64) + "b" })("a".repeat(4096))).toBe(false);
});
