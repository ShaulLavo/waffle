import { buildFamilyPrograms, stageFamilyPrograms } from "./build-family.ts";

buildFamilyPrograms(["-p", "waffle-clear", "--bin", "clear"], ["clear"]);
stageFamilyPrograms(["clear"]);
