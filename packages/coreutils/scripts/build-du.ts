import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildFamilyPrograms,
  stageFamilyPrograms,
  type ProgramBuildOptions,
} from "./build-family.ts";

export function buildDu(options: ProgramBuildOptions = {}) {
  buildFamilyPrograms(["-p", "waffle-du", "--bin", "du"], ["du"], options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildDu();
  stageFamilyPrograms(["du"]);
}
