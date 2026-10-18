import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteNodeImports } from "../build";

test("Node emission rewrites import syntax, never matching strings, comments or regexes", async () => {
  const root = await mkdtemp(
    join(
      process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()),
      "bun-wasm-emission-",
    ),
  );
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "thing.with.dots.ts"), "export const value = 1;");
    await mkdir(join(root, "directory"));
    await writeFile(join(root, "directory", "index.ts"), "export const value = 1;");
    const code = `import { value } from './nested/thing.with.dots';
export { value as other } from "./nested/thing.with.dots.ts";
const later = import('./directory');
const ordinary = './nested/thing.with.dots';
// import('./nested/thing.with.dots')
const pattern = /import('keep')/;`;
    const emitted = rewriteNodeImports(code, join(root, "index.ts"), root);
    expect(emitted).toContain('from "./nested/thing.with.dots.js"');
    expect(emitted).toContain('import("./directory/index.js")');
    expect(emitted).toContain("const ordinary = './nested/thing.with.dots'");
    expect(emitted).toContain("// import('./nested/thing.with.dots')");
    expect(emitted).toContain("const pattern = /import('keep')/");
    expect(() => rewriteNodeImports("import './missing';", join(root, "index.ts"), root)).toThrow(
      "Cannot resolve",
    );
    expect(() => rewriteNodeImports("import '../outside';", join(root, "index.ts"), root)).toThrow(
      "outside package",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
