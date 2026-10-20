import { expect, test } from "bun:test";
import {
  copyFileSync,
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

const realTest =
  process.platform === "linux" && process.env.WAFFLE_REAL_BROWSER_CLEANUP === "1"
    ? test
    : test.skip;
function signal(pid: number, kind: NodeJS.Signals): void {
  try {
    process.kill(pid, kind);
  } catch {}
}
function parentAndGroup(pid: number): { parent: number; group: number; state: string } | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { parent: Number(fields[1]), group: Number(fields[2]), state: fields[0]! };
  } catch {
    return undefined;
  }
}
async function waitReady(file: string): Promise<void> {
  const end = Date.now() + 15_000;
  while (!existsSync(file)) {
    if (Date.now() >= end) throw Error("real browser not ready");
    await Bun.sleep(20);
  }
}
for (const forced of [false, true])
  realTest(
    `stopped real Chromium cleanup ${forced ? "survives killed owner" : "waits for bounded context closure"}`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "wr-"));
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, "tests"));
      for (const file of [
        "test-browser.ts",
        "browser-command.ts",
        "browser-supervisor.ts",
        "owned-command.ts",
      ])
        copyFileSync(resolve(import.meta.dir, "../scripts", file), join(root, "scripts", file));
      for (const runner of ["storage-lock", "process-recycling"])
        writeFileSync(
          join(root, "tests", `${runner}-browser-runner.ts`),
          'process.once("SIGTERM", () => process.exit(1)); setInterval(() => {}, 1000);',
        );
      const suite = join(root, "tests/storage-browser-runner.ts");
      const dependencies = resolve(import.meta.dir, "../node_modules/playwright/index.mjs");
      const control = resolve(import.meta.dir, "process-recycling-browser-runner-control.ts");
      writeFileSync(
        suite,
        `
import {writeFileSync} from "node:fs";
import {chromium} from ${JSON.stringify(dependencies)};
import {closeBrowserResources} from ${JSON.stringify(control)};
const contexts = new Set(), browsers = new Set();
const owner = {creation: chromium.launch({headless:true}), stopped:false}; browsers.add(owner);
let cleaning;
const cleanup = () => cleaning ??= closeBrowserResources(contexts, browsers);
process.once("SIGTERM", () => { void cleanup().catch(console.error).finally(() => {writeFileSync(process.env.PROBE + "/cleaned", ""); process.exit(1);}); });
const browser = await owner.creation;
const context = {creation: browser.newContext(), stopped:false}; contexts.add(context);
await (await context.creation).newPage();
writeFileSync(process.env.PROBE + "/ready", String(process.pid));
setInterval(() => {}, 1000);
`,
      );
      let group: number | undefined;
      const launcher = Bun.spawn([process.execPath, "scripts/test-browser.ts"], {
        cwd: root,
        env: { ...process.env, PROBE: root },
        detached: true,
        stdout: "ignore",
        stderr: "inherit",
      });
      const result = launcher.exited;
      try {
        await waitReady(join(root, "ready"));
        const suitePid = Number(readFileSync(join(root, "ready"), "utf8"));
        const browser = readdirSync("/proc")
          .map(Number)
          .filter(Number.isFinite)
          .find((pid) => parentAndGroup(pid)?.parent === suitePid);
        if (!browser) throw Error("missing owned Chromium child");
        group = parentAndGroup(browser)!.group;
        signal(-group, "SIGSTOP");
        const start = Date.now();
        if (forced) signal(suitePid, "SIGKILL");
        launcher.kill("SIGTERM");
        expect(await result).not.toBe(0);
        const elapsed = Date.now() - start;
        console.log(`real Chromium interruption: ${elapsed}ms, group ${group}`);
        expect(elapsed).toBeGreaterThan(forced ? 0 : 9000);
        expect(elapsed).toBeLessThan(forced ? 2000 : 20_000);
        expect(existsSync(join(root, "cleaned"))).toBe(!forced);
        const survivors = readdirSync("/proc")
          .map(Number)
          .filter(Number.isFinite)
          .filter((pid) => {
            const info = parentAndGroup(pid);
            return info !== undefined && info.group === group && info.state !== "Z";
          });
        expect(survivors).toEqual([]);
      } finally {
        launcher.kill("SIGTERM");
        if (group !== undefined) signal(-group, "SIGKILL");
        await result;
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
