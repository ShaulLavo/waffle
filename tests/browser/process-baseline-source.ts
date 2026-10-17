import { copyFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

/** Add the unchanged benchmark harness to an unpacked frozen source archive. */
export async function prepareBaselineSource(snapshot: string, harness: string): Promise<void> {
  await mkdir(join(snapshot, "web/tests"), { recursive: true });
  await mkdir(join(snapshot, "web/node_modules/@bun-wasm"), { recursive: true });
  await symlink(join(snapshot, "runtime"), join(snapshot, "web/node_modules/@bun-wasm/runtime"));
  await copyFile(join(harness, "process-bench-baseline.ts"), join(snapshot, "web/tests/process-bench-baseline.ts"));
  await copyFile(join(harness, "process-benchmark.ts"), join(snapshot, "web/tests/process-benchmark.ts"));
}
