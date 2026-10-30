import { resolve } from "node:path";
import { wasiTarget, type WasiBuildRecipe } from "../../../tools/program-build-tools.ts";

export const packageRoot = resolve(import.meta.dirname, "..");
export const workspaceRoot = resolve(packageRoot, "../..");
export const targetDirectory = ".build/jq";
export const source = resolve(packageRoot, ".sources/jaq");
export const releaseDirectory = resolve(workspaceRoot, targetDirectory, wasiTarget, "release");
export const familyRecipe = {
  root: workspaceRoot,
  waffle: resolve(workspaceRoot, "packages/waffle"),
} satisfies WasiBuildRecipe;
