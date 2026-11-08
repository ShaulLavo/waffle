import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runner = join(import.meta.dir, "browser-controls-runner.ts");

async function invoke(root: string, args: string[], supervised = false) {
  const scratch = join(root, "scratch");
  await mkdir(scratch);
  const command = [process.execPath, runner].concat(args);
  const child = Bun.spawn(
    supervised
      ? [
          process.execPath,
          join(import.meta.dir, "../../scripts/browser-supervisor.ts"),
          "65000",
        ].concat(command)
      : command,
    {
      cwd: root,
      env: {
        ...process.env,
        STORAGE_SCRATCH_ROOT: scratch,
        BROWSER_CONTROLS_RESULT: supervised ? join(root, "ci-results.json") : undefined,
        WAFFLE_BROWSER_PARENT: undefined,
        PAGE_RUNNER_CONTROL_FILTER: "__no_browser_control__",
      },
      timeout: 4000,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
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

test.skipIf(process.platform !== "linux")(
  "CI results survive the outer browser supervisor's scratch teardown",
  async () => {
    await temporary(async (root) => {
      const { code } = await invoke(root, ["chromium"], true);
      expect(code).toBe(1);
      const summary = await Bun.file(join(root, "ci-results.json")).json();
      expect(summary.controls).toEqual([]);
      expect(summary.process.exitCode).toBe(code);
      expect(await Bun.file(summary.stderrPath).exists()).toBe(true);
      expect(await readdir(join(root, "scratch"))).toEqual([]);
    });
  },
);

const fixture = join(import.meta.dir, "browser-controls-process-fixture.ts");

async function synthetic(root: string, mode: string) {
  const resultPath = join(root, "result.json");
  const child = Bun.spawn([process.execPath, fixture, "supervise", mode, resultPath], {
    timeout: 4000,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const summary = await Bun.file(resultPath).json();
    expect(summary.process.exitCode).toBe(mode === "forwarded-signal" ? 0 : code);
    expect(summary.exitCode).toBe(code);
    expect(summary.supervisorError).toBeNull();
    expect(summary.signals).toEqual(mode === "forwarded-signal" ? ["SIGTERM"] : []);
    expect(await Bun.file(summary.stderrPath).text()).toBe(stderr);
    expect(await Bun.file(`${resultPath}.controls.json`).json()).toEqual(summary.controls);
    expect(summary.controls).toHaveLength(1);
    return { code, stdout, stderr, summary };
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

for (const [mode, expected] of [
  ["pass", 0],
  ["inherited", 23],
  ["top-level", 1],
  ["cleanup", 1],
  ["unhandled", 1],
  ["abrupt", 17],
  ["signal", 143],
  ["forwarded-signal", 1],
] as const) {
  test(`passing control verdicts do not hide ${mode} process outcome`, async () => {
    await temporary(async (root) => {
      const { code, stdout, stderr, summary } = await synthetic(root, mode);
      expect(code).toBe(expected);
      expect(summary.controls).toEqual([{ engine: "synthetic", control: mode, status: "pass" }]);
      if (mode === "top-level") {
        expect(stderr).toContain("CONTROL_TOP_LEVEL");
        expect(stderr).toContain("ORIGINAL_CAUSE");
      }
      if (mode === "cleanup") {
        expect(stderr).toContain("TypeError: CONTROL_PRIMARY");
        expect(stderr).toContain("RangeError: CONTROL_CLEANUP");
      }
      if (mode === "unhandled") {
        expect(stderr).toContain("CONTROL_UNHANDLED");
        expect(stderr).toContain("UNHANDLED_CAUSE");
        expect(stdout).toContain("CONTROL_EXIT_EVENT_");
      }
      if (mode === "signal") expect(summary.process.signalCode).toBe("SIGTERM");
      if (mode === "forwarded-signal") expect(stderr).toContain("CONTROL_SIGNAL_FORWARDED");
    });
  });
}

test("failed control verdict and its original error remain blocking", async () => {
  await temporary(async (root) => {
    const { code, summary } = await synthetic(root, "verdict-failure");
    expect(code).toBe(1);
    expect(summary.controls).toEqual([
      {
        engine: "synthetic",
        control: "verdict-failure",
        status: "fail",
        error: "TypeError: CONTROL_ASSERTION",
      },
    ]);
  });
});

test("a process spawn exception retains its original identity and a final report", async () => {
  await temporary(async (root) => {
    const resultPath = join(root, "result.json");
    const child = Bun.spawn([process.execPath, fixture, "supervise", "spawn-failure", resultPath], {
      timeout: 4000,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(1);
      const summary = await Bun.file(resultPath).json();
      expect(summary.controls).toEqual([]);
      expect(summary.exitCode).toBe(1);
      expect(summary.process).toEqual({ kind: "not-started" });
      expect(summary.supervisorError).toContain("ENOENT");
      expect(stderr).toContain("ENOENT");
      expect(stdout).toContain('"browserControls":');
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  });
});
