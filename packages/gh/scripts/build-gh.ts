import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/entry.ts"],
  outfile: "dist/gh-cli.js",
  bundle: true,
  minify: true,
  platform: "node",
  format: "esm",
  target: "es2024",
  metafile: true,
});
const inputs = Object.keys(result.metafile.inputs);
assert.ok(
  !inputs.some((input) => input.includes("node_modules/")),
  "Unexpected bundled dependency",
);
await mkdir(".build", { recursive: true });
await mkdir("dist", { recursive: true });
await writeFile(".build/gh-inputs.json", JSON.stringify(inputs));
await writeFile("dist/THIRD_PARTY_NOTICES.txt", await readFile("NOTICE", "utf8"));
