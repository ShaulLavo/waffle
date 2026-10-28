import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildFamilyPrograms,
  stageFamilyPrograms,
  type ProgramBuildOptions,
} from "./build-family.ts";

export function buildEcho(options: ProgramBuildOptions = {}) {
  buildFamilyPrograms(["-p", "waffle-echo", "--bin", "echo"], ["echo"], options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildEcho();
  stageFamilyPrograms(["echo"]);
}
