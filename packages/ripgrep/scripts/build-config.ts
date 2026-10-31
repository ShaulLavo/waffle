import { resolve } from "node:path";
import { wasiTarget, type WasiBuildRecipe } from "../../../tools/program-build-tools.ts";

export const packageRoot = resolve(import.meta.dirname, "..");
export const workspaceRoot = resolve(packageRoot, "../..");
export const waffleSourceRoot = resolve(workspaceRoot, "packages/waffle");
export const targetDirectory = ".build/ripgrep";
export const targetRoot = resolve(workspaceRoot, targetDirectory);
export const releaseDirectory = resolve(targetRoot, wasiTarget, "release");
export const familyRecipe = {
  root: workspaceRoot,
  waffle: waffleSourceRoot,
} satisfies WasiBuildRecipe;
