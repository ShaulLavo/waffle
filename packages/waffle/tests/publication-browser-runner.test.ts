import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

for (const mode of ["shutdown", "assigned", "confirmed"] as const)
  test(`publication persistent launch ${mode} preserves profile ownership`, () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        fileURLToPath(new URL("./fixtures/publication-launch-close.ts", import.meta.url)),
        mode,
      ],
      {
        env: {
          ...process.env,
          STORAGE_SCRATCH_ROOT:
            process.env.STORAGE_SCRATCH_ROOT ?? (process.platform === "win32" ? tmpdir() : "/tmp"),
        },
        timeout: 5_000,
      },
    );
    expect(result.exitCode).toBe(0);
    const recorded = JSON.parse(result.stdout.toString());
    expect(recorded.retained).toBe(mode !== "confirmed");
    expect(recorded.runnerRejected).toBe(true);
    expect(recorded.closeCalls).toBeGreaterThan(0);
  });
