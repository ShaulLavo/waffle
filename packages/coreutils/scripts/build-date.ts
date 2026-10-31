import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildFamilyPrograms,
  stageFamilyPrograms,
  type ProgramBuildOptions,
} from "./build-family.ts";

export function buildDate(options: ProgramBuildOptions = {}) {
  buildFamilyPrograms(["-p", "waffle-date", "--bin", "date"], ["date"], options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildDate();
  stageFamilyPrograms(["date"]);
}
