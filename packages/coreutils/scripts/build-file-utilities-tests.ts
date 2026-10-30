import { verificationOptions } from "./programs.ts";
import { stageProgram } from "../../../tools/program-build-tools.ts";
import { build } from "esbuild";
import { resolve } from "node:path";
import { copyFile, writeFile } from "node:fs/promises";
import { fileUtilityNames } from "../tests/helpers/file-utility-cases.ts";

await build({
  entryPoints: ["tests/helpers/file-utilities-browser.ts"],
  outfile: "dist/file-utilities-tests.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "esnext",
});
const release = resolve(
  import.meta.dirname,
  "../../..",
  process.env.CARGO_TARGET_DIR ?? ".build/coreutils",
  "wasm32-wasip1/release",
);
for (const name of fileUtilityNames)
  stageProgram(resolve(release, `${name}.wasm`), `dist/${name}.wasm`, verificationOptions(name));
await copyFile(resolve(release, "shell-runtime.wasm"), "dist/shell-runtime.wasm");
await copyFile("scripts/serve.mjs", "dist/serve.mjs");
await writeFile(
  "dist/file-utilities-tests.html",
  '<!doctype html><meta charset="utf-8"><script type="module" src="/file-utilities-tests.js"></script>',
);
