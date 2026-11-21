import { buildFamilyPrograms, stageFamilyPrograms } from "./build-family.ts";

buildFamilyPrograms(["-p", "@waffle-os/coreutils", "--bin", "ls"], ["ls"]);
stageFamilyPrograms(["ls"]);
