import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const programToolSources = [
  "program-build-tools.ts",
  "program-optimize.ts",
  "program-derivation.ts",
] as const;

/** Package exact canonical sources, never a second hand-maintained implementation. */
export function packageProgramTools(root: string): void {
  const repository = resolve(root, "../..");
  const destination = join(root, "tooling/program");
  if (resolve(root) !== join(repository, "packages/waffle")) {
    assert.ok(
      existsSync(join(destination, "program-transformer.json")),
      "Missing packaged program tools",
    );
    return;
  }
  const source = join(repository, "tools");
  mkdirSync(destination, { recursive: true });
  for (const file of programToolSources) copyFileSync(join(source, file), join(destination, file));
  const hash = (file: string) =>
    createHash("sha256")
      .update(readFileSync(join(source, file)))
      .digest("hex");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  assert.match(commit, /^[a-f0-9]{40}$/);
  writeFileSync(
    join(destination, "program-transformer.json"),
    JSON.stringify({
      commit,
      buildToolsSha256: hash("program-build-tools.ts"),
      optimizerSourceSha256: hash("program-optimize.ts"),
    }) + "\n",
  );
}
