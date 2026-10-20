import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
writeFileSync(process.env.PROBE + "/scratch", process.env.TMPDIR + "\\n" + process.env.WAFFLE_BROWSER_SHM_ROOT);
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
