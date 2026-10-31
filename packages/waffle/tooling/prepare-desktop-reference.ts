import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
/** Public-main input for exact page-owned constructor comparisons. Never replace this with HEAD. */
export const DESKTOP_REFERENCE_COMMIT = "9b66e3aa2462771f65ca263745a23c80e2c8fea3";
export function requireDesktopReference(repository: string): void {
  const result = spawnSync("git", ["cat-file", "-e", `${DESKTOP_REFERENCE_COMMIT}^{tree}`], {
    cwd: repository,
    stdio: "pipe",
    timeout: 10000,
  });
  if (result.status !== 0)
    throw new Error(
      `Pinned desktop reference ${DESKTOP_REFERENCE_COMMIT} is missing. Run bun packages/waffle/tooling/prepare-desktop-reference.ts before the tests.`,
    );
}
/** Explicit pre-test setup. Fetch one public commit at depth one, never during a runtime test. */
export function prepareDesktopReference(repository: string): void {
  const present = spawnSync("git", ["cat-file", "-e", `${DESKTOP_REFERENCE_COMMIT}^{tree}`], {
    cwd: repository,
    stdio: "pipe",
    timeout: 10000,
  });
  if (present.status === 0) return;
  execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", DESKTOP_REFERENCE_COMMIT], {
    cwd: repository,
    stdio: "inherit",
    timeout: 60000,
  });
  requireDesktopReference(repository);
}
if (import.meta.main)
  prepareDesktopReference(process.argv[2] ?? resolve(import.meta.dir, "../../.."));
