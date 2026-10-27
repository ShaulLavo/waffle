import { resolve } from "node:path";
import { stageCoreutilsArtifacts } from "./artifacts.ts";
import { buildFamilyPrograms, stageFamilyPrograms } from "./build-family.ts";
import { releaseDirectory, workspaceRoot } from "./build-config.ts";
import { buildWc } from "./build-wc.ts";
import { coreutilsNames, coreutilsPackageNames } from "./programs.ts";

const artifacts = process.env.COREUTILS_ARTIFACTS;
if (artifacts) {
  stageCoreutilsArtifacts(workspaceRoot, resolve(workspaceRoot, artifacts), releaseDirectory);
} else {
  buildFamilyPrograms(
    ["-p", "waffle-cut", "-p", "waffle-tr", "-p", "waffle-clear", "--bins"],
    ["cut", "tr", "clear"],
  );
  buildWc();
  buildFamilyPrograms(
    ["-p", "waffle-coreutils", "--bins", "--features", "cooperative-wasi,waffle-executable-query"],
    coreutilsPackageNames,
  );
}
stageFamilyPrograms(coreutilsNames);
