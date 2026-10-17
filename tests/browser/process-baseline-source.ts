import { mkdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";

/** Link the frozen runtime without changing that revision's own benchmark code. */
export async function prepareBaselineSource(snapshot: string): Promise<void> {
  for (const name of ["process-bench-baseline.ts", "process-benchmark.ts"]) {
    const path = join("web/tests", name);
    if (!await stat(join(snapshot, path)).then(entry => entry.isFile(), () => false)) {
      throw new Error(`Baseline archive is missing ${path}. Include its own harness: git archive REV web/src runtime web/tests/process-bench-baseline.ts web/tests/process-benchmark.ts`);
    }
  }
  await mkdir(join(snapshot, "web/node_modules/@bun-wasm"), { recursive: true });
  await symlink(join(snapshot, "runtime"), join(snapshot, "web/node_modules/@bun-wasm/runtime"));
}
