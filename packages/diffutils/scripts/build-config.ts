import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WasiBuildRecipe } from "../../../tools/program-build-tools.ts";

export interface SourceLock {
  readonly upstream: {
    readonly version: string;
    readonly archive: string;
    readonly archiveSha256: string;
  };
}

export const packageRoot = resolve(import.meta.dirname, "..");
export const sourceLock: SourceLock = JSON.parse(
  readFileSync(resolve(packageRoot, "sources.lock.json"), "utf8"),
);
export const workspaceRoot = resolve(packageRoot, "../..");
export const source = resolve(packageRoot, ".sources/diffutils");
export const buildDirectory = resolve(packageRoot, ".build/build");
export const releaseDirectory = resolve(buildDirectory, "src");
export const familyRecipe = {
  root: workspaceRoot,
  waffle: resolve(workspaceRoot, "packages/waffle"),
} satisfies WasiBuildRecipe;
