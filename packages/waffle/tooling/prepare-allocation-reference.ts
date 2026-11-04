import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
/** Public-main input for exact page-owned constructor comparisons. Never replace this with HEAD. */
export const ALLOCATION_REFERENCE_COMMIT = "fd1d23c223acbc854b8113fe1e37a7a183728697";
export function requireAllocationReference(repository: string): void {
  const result = spawnSync("git", ["cat-file", "-e", `${ALLOCATION_REFERENCE_COMMIT}^{tree}`], {
    cwd: repository,
    stdio: "pipe",
    timeout: 10000,
  });
  if (result.status !== 0)
    throw new Error(
      `Pinned allocation reference ${ALLOCATION_REFERENCE_COMMIT} is missing. Run bun packages/waffle/tooling/prepare-allocation-reference.ts before the tests.`,
    );
}
/** Explicit pre-test setup. Fetch one public commit at depth one, never during a runtime test. */
export function prepareAllocationReference(repository: string): void {
  const present = spawnSync("git", ["cat-file", "-e", `${ALLOCATION_REFERENCE_COMMIT}^{tree}`], {
    cwd: repository,
    stdio: "pipe",
    timeout: 10000,
  });
  if (present.status === 0) return;
  execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", ALLOCATION_REFERENCE_COMMIT], {
    cwd: repository,
    stdio: "inherit",
    timeout: 60000,
  });
  requireAllocationReference(repository);
}
if (import.meta.main)
  prepareAllocationReference(process.argv[2] ?? resolve(import.meta.dir, "../../.."));
