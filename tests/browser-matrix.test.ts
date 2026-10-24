import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCleanupError, runOwned } from "../scripts/owned-command.ts";

const runners = [
  "safe-staging",
  "storage",
  "storage-lock",
  "process-recycling",
  "network",
  "publication",
  "publication-cross-tab",
];
const fixture = `
import { existsSync, writeFileSync } from "node:fs";
const names = ${JSON.stringify(runners)};
const name = process.argv[1].split("/").at(-1).replace("-browser-runner.ts", "");
const engines = process.argv.slice(2).join(",");
if (engines === "chromium,firefox") {
  writeFileSync(name + ".started", "");
  while (!names.every((entry) => existsSync(entry + ".started"))) await Bun.sleep(10);
} else if (engines === "webkit") {
  if (!names.every((entry) => existsSync(entry + ".parallel.finished"))) throw Error("early WebKit");
  if (!names.slice(0, names.indexOf(name)).every((entry) => existsSync(entry + ".webkit.finished"))) throw Error("overlapping WebKit");
} else throw Error("missing engine");
writeFileSync(name + (engines === "webkit" ? ".webkit.finished" : ".parallel.finished"), engines);
if (process.env.MATRIX_FAIL === name + ":" + engines) throw Error("fixture failure");
`;

const recoveryFixture = `
import { appendFileSync, existsSync } from "node:fs";
const names = ${JSON.stringify(runners)};
const engines = process.argv.slice(2);
const scratch = process.env.STORAGE_SCRATCH_ROOT;
const supervised = Boolean(process.env.WAFFLE_BROWSER_PARENT);
const ownedScratch = Boolean(scratch && existsSync(scratch) && scratch === process.env.PROCESS_SCRATCH_ROOT);
appendFileSync("recovery-r42.invocations", JSON.stringify({ engines, supervised, ownedScratch }) + "\\n");
if (!names.every((entry) => existsSync(entry + ".parallel.finished"))) throw Error("early recovery");
if (names.some((entry) => existsSync(entry + ".webkit.finished"))) throw Error("late recovery");
if (process.env.MATRIX_FAIL === "recovery-r42:chromium") throw Error("recovery fixture failure");
`;

async function matrix(failing: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "waffle-browser-matrix-"));
  let cleanupError: CommandCleanupError | undefined;
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "tests"));
    await copyFile(
      join(import.meta.dir, "../scripts/test-browser.ts"),
      join(root, "scripts/test-browser.ts"),
    );
    await copyFile(
      join(import.meta.dir, "../scripts/owned-command.ts"),
      join(root, "scripts/owned-command.ts"),
    );
    for (const name of ["browser-command.ts", "browser-supervisor.ts"])
      await copyFile(join(import.meta.dir, "../scripts", name), join(root, "scripts", name));
    for (const runner of runners)
      await writeFile(join(root, "tests", `${runner}-browser-runner.ts`), fixture);
    await writeFile(join(root, "tests/recovery-r42-browser-runner.ts"), recoveryFixture);
    let failure: unknown;
    try {
      await runOwned([process.execPath, "scripts/test-browser.ts"], {
        cwd: root,
        env: { ...process.env, MATRIX_FAIL: failing },
        timeoutMs: 5000,
      });
    } catch (error) {
      cleanupError = error instanceof CommandCleanupError ? error : undefined;
      failure = error;
    }
    expect(cleanupError).toBeUndefined();
    expect(failure instanceof Error).toBe(failing !== "");
    const discovery = Bun.file(join(root, "recovery-r42.invocations"));
    expect(await discovery.exists()).toBe(true);
    const invocations: unknown[] = (await discovery.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(invocations).toEqual([
      {
        engines: ["chromium"],
        supervised: process.platform === "linux",
        ownedScratch: process.platform === "linux",
      },
    ]);
    for (const runner of runners) {
      expect(await readFile(join(root, `${runner}.parallel.finished`), "utf8")).toBe(
        "chromium,firefox",
      );
      expect(await readFile(join(root, `${runner}.webkit.finished`), "utf8")).toBe("webkit");
    }
  } finally {
    if (cleanupError) console.error(`Retained browser matrix scratch: ${root}`, cleanupError);
    else await rm(root, { recursive: true, force: true });
  }
}

test("browser matrix overlaps Chromium and Firefox suites before running WebKit suites alone", async () => {
  await matrix("");
}, 15_000);

for (const runner of runners) {
  for (const phase of ["chromium,firefox", "webkit"]) {
    test(`${runner} ${phase} failure remains blocking without hiding other suites`, async () => {
      await matrix(`${runner}:${phase}`);
    }, 15_000);
  }
}

test("Chromium-only recovery failure blocks matrix without hiding later WebKit suites", async () => {
  await matrix("recovery-r42:chromium");
}, 15_000);
