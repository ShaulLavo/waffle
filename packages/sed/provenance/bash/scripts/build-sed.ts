import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildWasiShell, shellTargetDirectory } from "./wasi-build.ts";
import { verifySedSource } from "./sed-source.ts";

const root = resolve(import.meta.dirname, "..");
verifySedSource(root);
buildWasiShell(["-p", "shell-sed", "--bin", "sed"]);
for (const directory of ["dist", "public/programs"]) {
  mkdirSync(resolve(root, directory), { recursive: true });
  copyFileSync(
    resolve(shellTargetDirectory(root), "wasm32-wasip1/release/sed.wasm"),
    resolve(root, directory, "sed.wasm"),
  );
}
