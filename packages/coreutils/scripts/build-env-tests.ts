import { stageProgram } from "../../../tools/program-build-tools.ts";
import { build } from "esbuild";
import { copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

await build({
  entryPoints: ["tests/helpers/env-browser.ts"],
  outfile: "dist/env-tests.js",
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
stageProgram(resolve(release, "env.wasm"), "dist/env.wasm");
await copyFile(resolve(release, "shell-runtime.wasm"), "dist/shell-runtime.wasm");
await copyFile("scripts/serve.mjs", "dist/serve.mjs");
await writeFile(
  "dist/env-tests.html",
  '<!doctype html><meta charset="utf-8"><script type="module" src="/env-tests.js"></script>',
);
