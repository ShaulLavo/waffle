import { buildFamilyPrograms, stageFamilyPrograms } from "./build-family.ts";

buildFamilyPrograms(["-p", "waffle-coreutils", "--bin", "ls"], ["ls"]);
stageFamilyPrograms(["ls"]);
