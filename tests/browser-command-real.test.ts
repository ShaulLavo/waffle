import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBrowserSuite } from "../scripts/browser-command.ts";

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
realTest(
  "stopped real Chromium context completes bounded owner cleanup before launcher exits",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "wr-"));
    const controller = new AbortController();
    const suite = join(root, "suite.ts");
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
    const execution = runBrowserSuite([process.execPath, suite], {
      cwd: root,
      env: { ...process.env, PROBE: root },
      signal: controller.signal,
    });
    const result = execution.then(
      () => false,
      () => true,
    );
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
      controller.abort();
      expect(await result).toBe(true);
      const elapsed = Date.now() - start;
      console.log(`real Chromium interruption: ${elapsed}ms, group ${group}`);
      expect(elapsed).toBeGreaterThan(9000);
      expect(elapsed).toBeLessThan(20_000);
      expect(existsSync(join(root, "cleaned"))).toBe(true);
      const survivors = readdirSync("/proc")
        .map(Number)
        .filter(Number.isFinite)
        .filter((pid) => {
          const info = parentAndGroup(pid);
          return info?.group === group && info.state !== "Z";
        });
      expect(survivors).toEqual([]);
    } finally {
      controller.abort();
      if (group !== undefined) signal(-group, "SIGKILL");
      await result;
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
