import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const programToolSources = [
  "program-build-tools.ts",
  "program-optimize.ts",
  "program-derivation.ts",
] as const;

function canonicalRepository(repository: string): boolean {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("name" in manifest) ||
      manifest.name !== "waffle-monorepo"
    )
      return false;
    const git = (args: readonly string[]) =>
      execFileSync("git", args, {
        cwd: repository,
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    if (realpathSync(git(["rev-parse", "--show-toplevel"])) !== realpathSync(repository))
      return false;
    return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)ShaulLavo\/waffle(?:\.git)?$/i.test(
      git(["remote", "get-url", "origin"]),
    );
  } catch {
    return false;
  }
}

/** Package exact canonical sources, never a second hand-maintained implementation. */
export function packageProgramTools(root: string): void {
  const repository = resolve(root, "../..");
  const destination = join(root, "tooling/program");
  if (resolve(root) !== join(repository, "packages/waffle") || !canonicalRepository(repository)) {
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
