import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runOwned } from "../scripts/owned-command.ts";

const repo = resolve(import.meta.dir, "..");
// The SDK build script uses Linux setsid and GNU timeout.
const toolingTest = process.platform === "linux" ? test : test.skip;
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
function kill(pid: number): void {
  if (Math.abs(pid) <= 1) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}
async function ready(path: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error("stub did not start");
    await Bun.sleep(10);
  }
}
function fixture() {
  const root = mkdtempSync(
    join(
      process.env.WASI_LIBC_SCRATCH_ROOT ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()),
      "waffle-libc-tools-",
    ),
  );
  const bin = join(root, "bin"),
    sdk = join(root, "sdk"),
    scratch = join(root, "scratch");
  for (const directory of [bin, join(sdk, "bin"), scratch])
    mkdirSync(directory, { recursive: true });
  const script = (path: string, body: string) =>
    writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
  const marker = `waffle-tmp-probe-${root.split("/").at(-1)}`;
  writeFileSync(join(sdk, "VERSION"), "34.0\nwasi-libc: 2e6fb9d8ee0c\n");
  script(
    join(sdk, "bin/clang"),
    'printf "%s" "${TMPDIR:-/tmp}" > "$PROBE/tmpdir"; touch "${TMPDIR:-/tmp}/$MARKER"',
  );
  script(join(bin, "curl"), 'if [[ -n "${SETUP_DELAY:-}" ]]; then sleep "$SETUP_DELAY"; fi');
  script(join(bin, "tar"), ":");
  script(join(bin, "ninja"), ":");
  script(join(bin, "patch"), 'test -n "$(cat)"');
  script(join(bin, "sha256sum"), "cat >/dev/null");
  script(
    join(bin, "cmake"),
    `
if [[ "\${HANG:-0}" == 1 ]]; then
  sleep 60 &
  printf '%s %s' "$$" "$!" > "$PROBE/pids"
  ps -o pgid= -p $$ | tr -d ' ' > "$PROBE/group"
  touch "$PROBE/ready"
  wait "$!"
else
  "$WASI_SDK_PATH/bin/clang"
  if [[ "$1" == --build ]]; then mkdir -p "$2/sysroot"; fi
fi`,
  );
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    WASI_SDK_PATH: sdk,
    WASI_LIBC_SCRATCH_ROOT: scratch,
    PROBE: root,
    MARKER: marker,
    TMPDIR: undefined,
  };
  const command = ["bash", join(repo, "scripts/build-wasi-libc.sh"), join(root, "output")];
  const cleanup = () => {
    if (existsSync(join(root, "group"))) kill(-Number(readFileSync(join(root, "group"), "utf8")));
    if (existsSync(join(root, "pids")))
      for (const pid of readFileSync(join(root, "pids"), "utf8").split(" ")) kill(Number(pid));
    rmSync(join("/tmp", marker), { force: true });
    rmSync(root, { recursive: true, force: true });
  };
  return { root, scratch, env, command, marker, cleanup };
}

for (const mode of ["signal", "timeout"] as const)
  toolingTest(
    `standalone libc build ${mode} retires grandchildren before removing scratch`,
    async () => {
      const f = fixture();
      const child = Bun.spawn(f.command, {
        cwd: repo,
        env: {
          ...f.env,
          HANG: "1",
          ...(mode === "timeout" ? { WASI_LIBC_COMMAND_TIMEOUT_SECONDS: "0.2" } : {}),
        },
        stdout: "ignore",
        stderr: "inherit",
      });
      try {
        await ready(join(f.root, "ready"));
        if (mode === "signal") child.kill("SIGTERM");
        expect(await child.exited).not.toBe(0);
        const pids = readFileSync(join(f.root, "pids"), "utf8").split(" ").map(Number);
        for (const pid of pids) expect(alive(pid)).toBe(false);
        expect(readdirSync(f.scratch)).toEqual([]);
      } finally {
        child.kill("SIGKILL");
        await child.exited;
        f.cleanup();
      }
    },
    10_000,
  );

toolingTest("standalone libc build confines compiler intermediates to owned TMPDIR", async () => {
  const f = fixture();
  try {
    expect(existsSync(join("/tmp", f.marker))).toBe(false);
    const child = Bun.spawn(f.command, {
      cwd: repo,
      env: f.env,
      stdout: "ignore",
      stderr: "inherit",
    });
    expect(await child.exited).toBe(0);
    expect(
      readFileSync(join(f.root, "tmpdir"), "utf8").startsWith(`${f.scratch}/waffle-wasi-libc-`),
    ).toBe(true);
    expect(existsSync(join("/tmp", f.marker))).toBe(false);
    expect(readdirSync(f.scratch)).toEqual([]);
  } finally {
    f.cleanup();
  }
});

for (const mode of ["signal", "timeout"] as const)
  toolingTest(
    `owned test command ${mode} terminates its whole process group`,
    async () => {
      const f = fixture(),
        controller = new AbortController();
      // The direct shell waits for a real grandchild, rather than sleeping itself.
      const command = [
        "bash",
        "-c",
        'sleep 60 & printf "%s %s" "$$" "$!" > "$PROBE/pids"; ps -o pgid= -p $$ | tr -d " " > "$PROBE/group"; touch "$PROBE/ready"; wait',
      ];
      const started = ready(join(f.root, "ready"));
      const running = runOwned(command, {
        cwd: repo,
        env: f.env,
        signal: controller.signal,
        timeoutMs: mode === "timeout" ? 200 : 5000,
        timeoutStartsAfter: started,
      });
      // Attach rejection handling before waiting for the stub's readiness.
      const result = running.then(
        () => null,
        (error) => error,
      );
      try {
        await started;
        if (mode === "signal") controller.abort();
        expect(await result).toBeInstanceOf(Error);
        for (const pid of readFileSync(join(f.root, "pids"), "utf8").split(" ").map(Number))
          expect(alive(pid)).toBe(false);
      } finally {
        controller.abort();
        await result;
        f.cleanup();
      }
    },
    10_000,
  );

for (const mode of ["signal", "timeout"] as const)
  toolingTest(
    `test runner ${mode} also retires the standalone build's nested group`,
    async () => {
      const f = fixture(),
        controller = new AbortController();
      // Setup deliberately exceeds the deadline: only time after CMake readiness counts.
      const started = ready(join(f.root, "ready"));
      const result = runOwned(f.command, {
        cwd: repo,
        env: { ...f.env, HANG: "1", SETUP_DELAY: "0.35" },
        signal: controller.signal,
        timeoutMs: mode === "timeout" ? 200 : 5000,
        timeoutStartsAfter: started,
      }).then(
        () => null,
        (error) => error,
      );
      try {
        await started;
        if (mode === "signal") controller.abort();
        expect(await result).toBeInstanceOf(Error);
        for (const pid of readFileSync(join(f.root, "pids"), "utf8").split(" ").map(Number))
          expect(alive(pid)).toBe(false);
        expect(readdirSync(f.scratch)).toEqual([]);
      } finally {
        controller.abort();
        await result;
        f.cleanup();
      }
    },
    10_000,
  );

toolingTest(
  "owned command escalates when its process group ignores TERM",
  async () => {
    const f = fixture();
    const started = ready(join(f.root, "ready"));
    const result = runOwned(
      [
        "bash",
        "-c",
        'trap "" TERM; sleep 60 & printf "%s %s" "$$" "$!" > "$PROBE/pids"; ps -o pgid= -p $$ | tr -d " " > "$PROBE/group"; touch "$PROBE/ready"; wait',
      ],
      { cwd: repo, env: f.env, timeoutMs: 100, timeoutStartsAfter: started },
    ).then(
      () => null,
      (error) => error,
    );
    try {
      expect(await result).toBeInstanceOf(Error);
      for (const pid of readFileSync(join(f.root, "pids"), "utf8").split(" ").map(Number))
        expect(alive(pid)).toBe(false);
    } finally {
      await result;
      f.cleanup();
    }
  },
  10_000,
);

toolingTest("owned command retires a background descendant after its leader succeeds", async () => {
  const f = fixture();
  try {
    await runOwned(
      [
        "bash",
        "-c",
        'sleep 60 & printf "%s %s" "$$" "$!" > "$PROBE/pids"; ps -o pgid= -p $$ | tr -d " " > "$PROBE/group"',
      ],
      { cwd: repo, env: f.env },
    );
    for (const pid of readFileSync(join(f.root, "pids"), "utf8").split(" ").map(Number))
      expect(alive(pid)).toBe(false);
  } finally {
    f.cleanup();
  }
});
