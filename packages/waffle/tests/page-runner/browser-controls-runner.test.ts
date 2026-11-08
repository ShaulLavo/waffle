import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runner = join(import.meta.dir, "browser-controls-runner.ts");

async function invoke(root: string, args: string[]) {
  const scratch = join(root, "scratch");
  await mkdir(scratch);
  const child = Bun.spawn([process.execPath, runner].concat(args), {
    cwd: root,
    env: {
      ...process.env,
      STORAGE_SCRATCH_ROOT: scratch,
      PAGE_RUNNER_CONTROL_FILTER: "__no_browser_control__",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await readdir(scratch)).toEqual([]);
    return { code, stdout, stderr };
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "w-bc-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("browser controls retain default results after removing owned scratch", async () => {
  await temporary(async (root) => {
    const { code } = await invoke(root, ["chromium"]);
    expect(code).toBe(1);
    const files = await readdir(join(root, ".browser-controls"));
    const result = files.find((file) => file.endsWith(".json") && !file.endsWith(".controls.json"));
    expect(result).toBeDefined();
    const summary = await Bun.file(join(root, ".browser-controls", result ?? "missing")).json();
    expect(summary.controls).toEqual([]);
    expect(summary.process.exitCode).toBe(code);
  });
});

test("browser controls retain the process failure and original top-level exception", async () => {
  await temporary(async (root) => {
    const resultPath = join(root, "result.json");
    const { code, stderr } = await invoke(root, ["firefox", "--result", resultPath]);
    expect(code).toBe(1);
    const summary = await Bun.file(resultPath).json();
    expect(summary.controls).toEqual([]);
    expect(summary.process.exitCode).toBe(code);
    expect(summary.process.signalCode).toBeNull();
    expect(await Bun.file(summary.stderrPath).text()).toBe(stderr);
    expect(stderr).toContain("Unsupported control engine firefox");
    expect(stderr).toContain("at engineControls");
  });
});
