import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBrowserSuite } from "../scripts/browser-command.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
const repo = resolve(import.meta.dir, "..");
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}
function kill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {}
}
async function ready(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw Error("fixture readiness timeout");
    await Bun.sleep(10);
  }
}

linuxTest(
  "browser cancellation waits for bounded owner cleanup and retires detached children",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const controller = new AbortController();
    const suite = join(root, "suite.ts");
    writeFileSync(
      suite,
      `
import {writeFileSync} from "node:fs";
const browser = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {detached:true, stdout:"ignore", stderr:"ignore"});
writeFileSync(process.env.PROBE + "/browser", String(browser.pid));
process.once("SIGTERM", () => { setTimeout(() => { browser.kill("SIGKILL"); writeFileSync(process.env.PROBE + "/cleaned", ""); process.exit(1); }, 2500); });
writeFileSync(process.env.PROBE + "/ready", String(process.pid));
setInterval(() => {}, 1000);
`,
    );
    let execution: Promise<void> | undefined;
    try {
      execution = runBrowserSuite([process.execPath, suite], {
        cwd: root,
        env: { ...process.env, PROBE: root },
        signal: controller.signal,
      });
      // Attach immediately: cancellation must reject, not leak an unhandled rejection.
      const outcome = execution.then(
        () => false,
        () => true,
      );
      await ready(join(root, "ready"));
      controller.abort();
      expect(await outcome).toBe(true);
      expect(existsSync(join(root, "cleaned"))).toBe(true);
      expect(alive(Number(readFileSync(join(root, "browser"), "utf8")))).toBe(false);
    } finally {
      controller.abort();
      await execution?.catch(() => {});
      if (existsSync(join(root, "browser")))
        kill(Number(readFileSync(join(root, "browser"), "utf8")), "SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);

async function containedFixture(
  mode: "normal" | "fast-exit" | "killed-owner" | "hung-owner" | "killed-launcher" | "deadline",
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wc-"));
  const suite = join(root, "suite.ts");
  const supervisor = resolve(repo, "scripts/browser-supervisor.ts");
  writeFileSync(
    suite,
    `
import {writeFileSync} from "node:fs";
process.on("SIGTERM", () => {});
const browser = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {detached:true, stdout:"ignore", stderr:"ignore"});
writeFileSync(process.env.PROBE + "/browser", String(browser.pid));
writeFileSync(process.env.PROBE + "/scratch", process.env.STORAGE_SCRATCH_ROOT + "\\n" + process.env.WAFFLE_BROWSER_SHM_ROOT);
writeFileSync(process.env.PROBE + "/ready", String(process.pid));
if (process.env.MODE === "fast-exit") process.exit(0);
if (process.env.MODE === "normal") { browser.kill("SIGKILL"); await browser.exited; process.exit(0); }
setInterval(() => {}, 1000);
`,
  );
  const outer = join(root, "outer.ts");
  writeFileSync(
    outer,
    `
const supervisor = Bun.spawn([process.execPath, ${JSON.stringify(supervisor)}, "100", process.execPath, ${JSON.stringify(suite)}], {env:{...process.env, WAFFLE_BROWSER_PARENT:String(process.pid)}, detached:true, stdout:"ignore", stderr:"inherit"});
await supervisor.exited;
`,
  );
  const command =
    mode === "killed-launcher"
      ? [process.execPath, outer]
      : [process.execPath, supervisor, "100", process.execPath, suite];
  const child = Bun.spawn(command, {
    env: {
      ...process.env,
      PROBE: root,
      MODE: mode,
      WAFFLE_BROWSER_PARENT: String(process.pid),
      WAFFLE_BROWSER_TIMEOUT: mode === "deadline" ? "100" : "5000",
    },
    detached: true,
    stdout: "ignore",
    stderr: "inherit",
  });
  try {
    await ready(join(root, "ready"));
    if (mode === "killed-owner") kill(Number(readFileSync(join(root, "ready"), "utf8")), "SIGKILL");
    if (mode === "hung-owner") child.kill("SIGTERM");
    if (mode === "killed-launcher") child.kill("SIGKILL");
    const exit = await Promise.race([
      child.exited,
      Bun.sleep(5000).then(() => {
        throw Error("supervisor did not retire child");
      }),
    ]);
    expect(exit === 0).toBe(mode === "normal" || mode === "fast-exit");
    const browser = Number(readFileSync(join(root, "browser"), "utf8"));
    const scratch = readFileSync(join(root, "scratch"), "utf8").split("\n");
    const end = Date.now() + 5000;
    while (alive(browser) || scratch.some(existsSync)) {
      if (Date.now() >= end) throw Error("orphan supervisor did not finish cleanup");
      await Bun.sleep(10);
    }
    expect(alive(browser)).toBe(false);
    for (const directory of readFileSync(join(root, "scratch"), "utf8").split("\n"))
      expect(existsSync(directory)).toBe(false);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    if (existsSync(join(root, "browser")))
      kill(Number(readFileSync(join(root, "browser"), "utf8")), "SIGKILL");
    if (existsSync(join(root, "ready")))
      kill(Number(readFileSync(join(root, "ready"), "utf8")), "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
}
for (const mode of [
  "normal",
  "fast-exit",
  "killed-owner",
  "hung-owner",
  "killed-launcher",
  "deadline",
] as const)
  linuxTest(
    `browser containment retires detached children after ${mode}`,
    () => containedFixture(mode),
    10_000,
  );

for (const mode of ["success", "failure", "interrupted"] as const)
  linuxTest(
    `browser supervisor preserves dispatcher short TMPDIR after ${mode}`,
    async () => {
      const base = realpathSync(existsSync("/work/tmp") ? "/work/tmp" : "/tmp");
      const prefix = join(base, "wc-short-");
      const root = mkdtempSync(prefix + "x".repeat(47 - prefix.length - 6));
      const suite = join(root, "suite.ts");
      try {
        expect(realpathSync(root).length).toBe(47);
        mkdirSync(join(root, "unrelated"));
        writeFileSync(join(root, "unrelated", "keep"), "dispatcher-owned");
        writeFileSync(
          suite,
          `import { writeFileSync } from "node:fs";
import { BrowserRunnerLifecycle } from ${JSON.stringify(resolve(import.meta.dir, "browser-runner-lifecycle.ts"))};
writeFileSync(process.env.PROBE + "/state.json", JSON.stringify({
  tmp: process.env.TMPDIR, scratch: process.env.SCRATCH,
  owned: process.env.STORAGE_SCRATCH_ROOT, shm: process.env.WAFFLE_BROWSER_SHM_ROOT,
}));
const lifecycle = new BrowserRunnerLifecycle(5000);
try {
  await lifecycle.init();
  writeFileSync(process.env.PROBE + "/initialized", process.env.TMPDIR);
  if (${JSON.stringify(mode)} === "failure") throw Error("intentional suite failure");
  if (${JSON.stringify(mode)} === "interrupted") {
    process.kill(process.ppid, "SIGTERM");
    await Bun.sleep(10000);
  }
} finally { await lifecycle.close(); }
`,
        );
        const failure = await runBrowserSuite([process.execPath, suite], {
          cwd: repo,
          env: {
            ...process.env,
            PROBE: root,
            TMPDIR: root,
            SCRATCH: root,
            STORAGE_SCRATCH_ROOT: root,
            PROCESS_SCRATCH_ROOT: root,
          },
          timeoutMs: 5000,
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(readFileSync(join(root, "initialized"), "utf8")).toBe(root);
        expect(failure instanceof Error).toBe(mode !== "success");
        const state: unknown = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
        expect(state).toMatchObject({ tmp: root, scratch: root });
        expect(readdirSync(root).sort()).toEqual([
          "initialized",
          "state.json",
          "suite.ts",
          "unrelated",
        ]);
        expect(readFileSync(join(root, "unrelated", "keep"), "utf8")).toBe("dispatcher-owned");
        if (!state || typeof state !== "object" || !("owned" in state) || !("shm" in state))
          throw Error("Missing supervisor ownership report");
        expect(typeof state.owned).toBe("string");
        expect(typeof state.shm).toBe("string");
        if (typeof state.owned !== "string" || typeof state.shm !== "string")
          throw Error("Invalid supervisor ownership report");
        expect(state.owned.startsWith(root + "/wb-")).toBe(true);
        expect(state.shm.startsWith("/dev/shm/wb-")).toBe(true);
        expect(existsSync(state.owned)).toBe(false);
        expect(existsSync(state.shm)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

linuxTest(
  "browser supervisor falls back for a 47-character, 91-byte dispatcher TMPDIR",
  async () => {
    const base = realpathSync(existsSync("/work/tmp") ? "/work/tmp" : "/tmp");
    const root = mkdtempSync(join(base, "wc-byte-"));
    const dispatcher = join(root, "x".repeat(47 - root.length - 1 - 22) + "界".repeat(22));
    try {
      mkdirSync(dispatcher);
      writeFileSync(join(dispatcher, "keep"), "dispatcher-owned");
      expect(realpathSync(dispatcher).length).toBe(47);
      expect(Buffer.byteLength(realpathSync(dispatcher), "utf8")).toBe(91);
      const suite = join(root, "suite.ts");
      writeFileSync(
        suite,
        `import { writeFileSync } from "node:fs";
import { BrowserRunnerLifecycle } from ${JSON.stringify(resolve(import.meta.dir, "browser-runner-lifecycle.ts"))};
writeFileSync(process.env.PROBE + "/before", process.env.TMPDIR);
writeFileSync(process.env.PROBE + "/owned", process.env.STORAGE_SCRATCH_ROOT + "\\n" + process.env.WAFFLE_BROWSER_SHM_ROOT);
const lifecycle = new BrowserRunnerLifecycle(5000);
try {
  await lifecycle.init();
  writeFileSync(process.env.PROBE + "/initialized", process.env.TMPDIR);
} finally { await lifecycle.close(); }
`,
      );
      await runBrowserSuite([process.execPath, suite], {
        cwd: repo,
        env: {
          ...process.env,
          PROBE: root,
          TMPDIR: dispatcher,
          SCRATCH: dispatcher,
          STORAGE_SCRATCH_ROOT: root,
          PROCESS_SCRATCH_ROOT: root,
        },
        timeoutMs: 5000,
      });
      const before = readFileSync(join(root, "before"), "utf8");
      expect(before).not.toBe(dispatcher);
      expect(before.startsWith(root + "/wb-")).toBe(true);
      expect(Buffer.byteLength(before, "utf8")).toBeLessThanOrEqual(48);
      expect(
        Buffer.byteLength(readFileSync(join(root, "initialized"), "utf8"), "utf8"),
      ).toBeLessThanOrEqual(48);
      expect(readFileSync(join(dispatcher, "keep"), "utf8")).toBe("dispatcher-owned");
      expect(readdirSync(dispatcher)).toEqual(["keep"]);
      const owned = readFileSync(join(root, "owned"), "utf8").split("\n");
      expect(owned).toHaveLength(2);
      for (const directory of owned) expect(existsSync(directory)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
