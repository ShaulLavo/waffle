import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runner = join(import.meta.dir, "browser-controls-runner.ts");

async function invoke(root: string, args: string[], supervised = false, resultBase?: string) {
  const scratch = join(root, "scratch");
  await mkdir(scratch, { recursive: true });
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
        BROWSER_CONTROLS_RESULT:
          resultBase ?? (supervised ? join(root, "ci-results.json") : undefined),
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

function expectStopped(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow();
}

test.skipIf(process.platform !== "linux")(
  "a descendant-held stderr pipe cannot block final results and outer cleanup",
  async () => {
    await temporary(async (root) => {
      const resultPath = join(root, "result.json");
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../../scripts/browser-supervisor.ts"),
          "500",
          process.execPath,
          fixture,
          "supervise",
          "orphan-stderr",
          resultPath,
        ],
        {
          env: {
            ...process.env,
            WAFFLE_BROWSER_TIMEOUT: "2000",
            WAFFLE_BROWSER_PARENT: String(process.pid),
            STORAGE_SCRATCH_ROOT: root,
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
        expect(code).toBe(1);
        const summary = await Bun.file(resultPath).json();
        expect(summary.process).toEqual({ kind: "exited", exitCode: 23, signalCode: null });
        expect(summary.exitCode).toBe(1);
        expect(summary.controls).toEqual([
          { engine: "synthetic", control: "orphan-stderr", status: "pass" },
        ]);
        expect(summary.supervisorError).toContain("stderr did not close");
        expect(stdout).toContain('"browserControls":');
        expect(stderr).toContain("CONTROL_ORPHAN_EXIT_23");
        expect(await Bun.file(summary.stderrPath).text()).toBe("CONTROL_ORPHAN_EXIT_23\n");
        const descendant = Number(await Bun.file(`${resultPath}.controls.json.orphan-pid`).text());
        expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
        expectStopped(descendant);
        expect((await readdir(root)).some((name) => name.startsWith("wb-"))).toBe(false);
      } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    });
  },
);

test("one-time control preparation remains a successful reported process", async () => {
  await temporary(async (root) => {
    const resultPath = join(root, "prepare.json");
    const { code, stderr } = await invoke(root, ["--prepare", "--result", resultPath]);
    expect(code, stderr).toBe(0);
    expect(await Bun.file(resultPath).json()).toMatchObject({
      controls: [],
      exitCode: 0,
      process: { kind: "exited", exitCode: 0, signalCode: null },
    });
  });
});

test("prepared control engines do not admit the dispatcher flag as an engine", async () => {
  await temporary(async (root) => {
    const resultPath = join(root, "prepared.json");
    const { code, stderr } = await invoke(root, ["chromium", "--prepared", "--result", resultPath]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("Unsupported control engine");
    expect(await Bun.file(resultPath).json()).toMatchObject({ controls: [], exitCode: 1 });
  });
});

test("split control phases retain separate preparation and engine evidence", async () => {
  await temporary(async (root) => {
    const base = join(root, "ci-results.json");
    const retained = new Map<string, string>();
    for (const phase of ["prepare", "chromium", "webkit"]) {
      const args = phase === "prepare" ? ["--prepare"] : [phase, "--prepared"];
      const { code, stderr } = await invoke(root, args, false, base);
      expect(code, stderr).toBe(phase === "prepare" ? 0 : 1);
      const path = `${base}.${phase}.json`;
      const summary = await Bun.file(path).json();
      expect(summary.process.exitCode).toBe(code);
      expect(await Bun.file(`${path}.controls.json`).json()).toEqual(summary.controls);
      expect(await Bun.file(summary.stderrPath).text()).toBe(stderr);
      retained.set(path, await Bun.file(path).text());
    }
    expect(await Bun.file(base).exists()).toBe(false);
    for (const [path, original] of retained) expect(await Bun.file(path).text()).toBe(original);
  });
});

for (const signal of ["SIGINT", "SIGTERM"])
  test(`retained control results cannot turn forwarded ${signal} into a negative pass`, async () => {
    await temporary(async (root) => {
      const resultPath = join(root, "interrupted.json");
      const mode = `interrupted-${signal}`;
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
        expect(code).toBe(1);
        const summary = await Bun.file(resultPath).json();
        expect(summary.signals).toEqual([signal]);
        expect(summary.process).toEqual({ kind: "exited", exitCode: 1, signalCode: null });
        expect(summary.supervisorError).toBeNull();
        expect(summary.controls).toEqual([
          {
            engine: "synthetic",
            control: mode,
            status: "fail",
            error: "Error: Browser controls interrupted",
          },
        ]);
        expect(await Bun.file(`${resultPath}.controls.json`).json()).toEqual(summary.controls);
        expect(await Bun.file(summary.stderrPath).text()).toBe(stderr);
        expect(stderr).toContain("Browser controls interrupted");
        expect(stdout).not.toContain('"control":"later"');
      } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    });
  });
