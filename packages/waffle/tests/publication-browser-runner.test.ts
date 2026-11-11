import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const mode of ["shutdown", "assigned", "confirmed"] as const)
  test(`publication persistent launch ${mode} preserves profile ownership`, () => {
    const result = Bun.spawnSync(
      [process.execPath, resolve(import.meta.dir, "fixtures/publication-launch-close.ts"), mode],
      {
        env: { ...process.env, STORAGE_SCRATCH_ROOT: "/work/tmp", TMPDIR: "/work/tmp" },
        timeout: 5_000,
      },
    );
    expect(result.exitCode).toBe(0);
    const recorded = JSON.parse(result.stdout.toString());
    expect(recorded.retained).toBe(mode !== "confirmed");
    expect(recorded.runnerRejected).toBe(true);
    expect(recorded.closeCalls).toBeGreaterThan(0);
  });
