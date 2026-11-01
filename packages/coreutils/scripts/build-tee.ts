import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildFamilyPrograms,
  stageFamilyPrograms,
  type ProgramBuildOptions,
} from "./build-family.ts";

export function buildTee(options: ProgramBuildOptions = {}) {
  buildFamilyPrograms(["-p", "waffle-tee", "--bin", "tee"], ["tee"], options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildTee();
  stageFamilyPrograms(["tee"]);
}
