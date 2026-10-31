import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { patchGitSource } from "./patch-git-source.ts";
patchGitSource();
const output = `.build/git-local-${randomUUID()}`;
try {
  await mkdir(output, { recursive: true });
  await build({
    entryPoints: ["tests/git-local.unit.ts"],
    outfile: `${output}/tests.mjs`,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node26",
  });
  const result = spawnSync(process.execPath, ["--test", `${output}/tests.mjs`], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(output, { recursive: true, force: true });
}
