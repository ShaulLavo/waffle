import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { patchGitSource } from "./patch-git-source.ts";

/** Ship the patched dependency inside the lazy JS asset, including in npm tarballs. */
export async function buildGit() {
  patchGitSource();
  const bundle = await build({
    entryPoints: ["src/git-command.ts"],
    outfile: "dist/git-command.js",
    bundle: true,
    minify: true,
    platform: "browser",
    format: "esm",
    target: "es2024",
    metafile: true,
  });
  // The `git` program: same backend, process stdio and the interpreter's node:fs (Waffle's FS under Bun).
  const program = await build({
    entryPoints: ["src/cli.ts"],
    outfile: "dist/git-cli.js",
    bundle: true,
    minify: true,
    platform: "node",
    mainFields: ["module", "main"],
    format: "esm",
    target: "es2024",
    metafile: true,
  });
  const inputs = new Set(Object.keys(bundle.metafile.inputs).concat(Object.keys(program.metafile.inputs)));
  await mkdir(".build", { recursive: true });
  await writeFile(".build/git-inputs.json", JSON.stringify(Array.from(inputs)));
  await writeFile(
    "dist/git-command.d.ts",
    'export { runGit } from "../src/git-command";\n',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildGit();
