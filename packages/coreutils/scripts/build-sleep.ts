import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildFamilyPrograms,
  stageFamilyPrograms,
  type ProgramBuildOptions,
} from "./build-family.ts";

export function buildSleep(options: ProgramBuildOptions = {}) {
  buildFamilyPrograms(["-p", "waffle-sleep", "--bin", "sleep"], ["sleep"], options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildSleep();
  stageFamilyPrograms(["sleep"]);
}
