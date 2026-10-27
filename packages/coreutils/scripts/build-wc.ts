import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFamilyPrograms, type ProgramBuildOptions } from "./build-family.ts";

export function buildWc(options: ProgramBuildOptions = {}) {
  buildFamilyPrograms(["-p", "waffle-wc", "--bin", "wc"], ["wc"], {
    ...options,
    rustflags: ["-C", "target-feature=-simd128"],
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildWc();
