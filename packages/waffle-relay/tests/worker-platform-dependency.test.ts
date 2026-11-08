import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const fixture = new URL("../scripts/worker-platform.ts", import.meta.url);
const fixtureRequire = createRequire(fixture);

test("relay tooling owns its Miniflare development dependency", () => {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  expect(manifest).toHaveProperty("devDependencies.miniflare");
});

test("worker platform imports resolve through public package entry points", () => {
  const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(readFileSync(fixture, "utf8"));
  for (const { path } of imports) {
    expect(() => fixtureRequire.resolve(path), path).not.toThrow();
    expect(path).not.toContain("node_modules");
  }
  expect(imports.map(({ path }) => path)).toContain("miniflare");
});
