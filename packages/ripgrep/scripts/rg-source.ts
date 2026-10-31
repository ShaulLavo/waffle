import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";

export function patchRipgrepSource(source: string, patch: string) {
  // Enclosing repository discovery makes Git silently skip archive-relative paths.
  execFileSync("git", ["apply", patch], {
    cwd: source,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(realpathSync(source)) },
  });
}
