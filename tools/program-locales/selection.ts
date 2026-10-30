import assert from "node:assert/strict";

const gitUtilities = new Set(["echo", "ls", "env", "cut", "tr", "wc", "touch", "rm", "cp", "mv"]);
const registryUtilities = new Set(["head", "sort", "uniq"]);
const commonOnly = new Set([
  "clear",
  "cat",
  "mkdir",
  "seq",
  "tail",
  "which",
  "find",
  "xargs",
  "sed",
]);

export function selectCatalogs(program: string, version: string): string[] {
  assert.ok(
    gitUtilities.has(program) || registryUtilities.has(program) || commonOnly.has(program),
    `Unknown program locale policy: ${program}`,
  );
  assert.ok(version === "0.12.0" || version === "0.13.0", `Unsupported uucore: ${version}`);
  const utilities = version === "0.13.0" ? gitUtilities : registryUtilities;
  const common = ["uucore/en-US.ftl", "uucore-errors/en-US.ftl"];
  return utilities.has(program) ? common.concat([`${program}/en-US.ftl`]) : common;
}

export function usesProgramCatalogs(program: string): boolean {
  return gitUtilities.has(program) || registryUtilities.has(program);
}
