import { resolve } from "node:path";
import { wasiTarget, type WasiBuildRecipe } from "../../../tools/program-build-tools.ts";

export const packageRoot = resolve(import.meta.dirname, "..");
export const workspaceRoot = resolve(packageRoot, "../..");
export const waffleSourceRoot = resolve(workspaceRoot, "packages/waffle");
export const targetDirectory = ".build/coreutils";
export const releaseDirectory = resolve(workspaceRoot, targetDirectory, wasiTarget, "release");
export const familyRecipe = {
  root: workspaceRoot,
  waffle: waffleSourceRoot,
} satisfies WasiBuildRecipe;
