import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { webkit } from "playwright";

async function installFailingLauncher(root: string): Promise<void> {
  const executable = webkit.executablePath();
  const directory = join(root, basename(dirname(executable)));
  const launcher = join(directory, basename(executable));
  await mkdir(directory);
  await writeFile(
    launcher,
    `#!/bin/sh
for line in 1 2 3 4 5 6 7 8 9 10; do
  printf 'NATIVE_LINE_%s %016384d\\n' "$line" "$line" >&2
done
exit 42
`,
  );
  await chmod(launcher, 0o700);
}

for (const runner of ["link", "controls"] as const) {
  test.skipIf(process.platform === "win32")(
    `${runner} reports a real Playwright launch failure with bounded native output`,
    async () => {
      const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "wke-"));
      const scratch = join(root, "tmp");
      const result = join(root, "controls.json");
      try {
        await mkdir(scratch);
        await installFailingLauncher(root);
        const args =
          runner === "link"
            ? [join(import.meta.dir, "link-browser-runner.ts"), "webkit"]
            : [
                join(import.meta.dir, "page-runner/browser-controls-runner.ts"),
                "webkit",
                "--prepared",
                "--result",
                result,
              ];
        const child = Bun.spawn([process.execPath].concat(args), {
          env: {
            ...process.env,
            PLAYWRIGHT_BROWSERS_PATH: root,
            PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: "1",
            PAGE_RUNNER_CONTROL_FILTER: "worker-capability-success",
            PROCESS_SCRATCH_ROOT: scratch,
            STORAGE_SCRATCH_ROOT: scratch,
            TMPDIR: scratch,
          },
          timeout: 20_000,
          stdout: "pipe",
          stderr: "pipe",
        });
        await assertFailure(child, runner, result);
        expect(await readdir(scratch)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
}

async function assertFailure(
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
  runner: "link" | "controls",
  result: string,
): Promise<void> {
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stderr.includes("NATIVE_LINE_1 ")).toBe(true);
    expect(stderr.includes("native stdout/stderr truncated")).toBe(true);
    expect(stderr.includes("<process did exit: exitCode=42, signal=null>")).toBe(true);
    const failure =
      runner === "link"
        ? stderr.slice(stderr.indexOf("error: "))
        : await Bun.file(`${result}.controls.json`).text();
    expect(failure.includes("NATIVE_LINE_10 ")).toBe(false);
    expect(stdout.includes("NATIVE_LINE_10 ")).toBe(false);
    expect(failure.includes("NATIVE_LINE_1 ")).toBe(true);
    expect(failure.includes("native stdout/stderr truncated")).toBe(true);
    expect(failure.includes("<process did exit: exitCode=42, signal=null>")).toBe(true);
    expect(failure.includes("<launching>")).toBe(true);
    expect(
      failure.includes("Target page, context or browser has been closed") ||
        failure.includes("Failed to launch the browser process"),
      failure.replace(/\d{100,}/g, "[launcher payload]").slice(-2500),
    ).toBe(true);
    const bytes = Array.from(failure.matchAll(/NATIVE_LINE_\d+ \d+/g), ([line]) => line.length);
    expect(bytes.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(64 * 1024);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}
