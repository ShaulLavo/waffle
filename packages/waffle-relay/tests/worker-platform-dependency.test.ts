import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const fixture = new URL("../scripts/worker-platform.ts", import.meta.url);
const fixtureRequire = createRequire(fixture);

test("relay tooling owns its Miniflare development dependency", () => {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  expect(manifest).toHaveProperty("devDependencies.miniflare");
});

test("worker platform imports resolve through public package entry points", () => {
  const imports = ts.preProcessFile(readFileSync(fixture, "utf8")).importedFiles;
  for (const { fileName } of imports) {
    expect(() => fixtureRequire.resolve(fileName), fileName).not.toThrow();
    expect(fileName).not.toContain("node_modules");
  }
  expect(imports.map(({ fileName }) => fileName)).toContain("miniflare");
});
