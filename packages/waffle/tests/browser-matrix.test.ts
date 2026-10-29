import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
const continuity = "workspace-continuity";
const rootContinuity = "root-continuity";
const recovery = "recovery-r42";
const chromiumOnly = [continuity, rootContinuity];
const socket = "fs-socket";
const fixture = `
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
const names = ${JSON.stringify(runners)};
const name = process.argv[1].split("/").at(-1).replace("-browser-runner.ts", "");
const engines = process.argv.slice(2).join(",");
if (${JSON.stringify(chromiumOnly.concat([socket]))}.includes(name)) {
  appendFileSync(name + ".invocations", engines + "\\n");
  if (engines !== (name === "fs-socket" ? "firefox" : "chromium")) throw Error("isolated engine repeated or changed");
  if (existsSync(name + ".finished")) throw Error("continuity repeated");
  const scratch = process.env.STORAGE_SCRATCH_ROOT;
  if (scratch !== process.cwd() && !scratch?.startsWith(process.cwd() + "/wb-")) throw Error("scratch missing");
  if (process.platform === "linux" && process.env.PROCESS_SCRATCH_ROOT !== scratch) throw Error("supervised scratch missing");
  if (!statSync(scratch).isDirectory() || realpathSync(scratch) !== scratch) throw Error("scratch not an actual directory");
  if (process.platform === "linux") {
    if (!scratch.startsWith(process.cwd() + "/wb-")) throw Error("scratch not supervisor-owned");
    if (!readFileSync("/proc/" + process.ppid + "/cmdline", "utf8").includes("/scripts/browser-supervisor.ts")) throw Error("supervisor not running");
    if (!statSync(process.env.WAFFLE_BROWSER_SHM_ROOT).isDirectory()) throw Error("supervised shared scratch missing");
  }
  if (!names.every((entry) => existsSync(entry + ".webkit.finished"))) throw Error("early continuity");
  const predecessor = name === "workspace-continuity" ? "recovery-r42" : name === "root-continuity" ? "workspace-continuity" : "root-continuity";
  if (process.platform === "linux" && existsSync(readFileSync(predecessor + ".scratch", "utf8"))) throw Error("isolated predecessor scratch retained");
  appendFileSync("isolated.order", name + "\\n");
  writeFileSync(name + ".scratch", scratch);
  writeFileSync(name + ".finished", engines);
  if (process.env.MATRIX_FAIL.split("|").includes(name + ":" + engines)) throw Error("fixture failure");
  process.exit(0);
}
if (engines === "chromium,firefox") {
  writeFileSync(name + ".started", "");
  while (!names.every((entry) => existsSync(entry + ".started"))) await Bun.sleep(10);
} else if (engines === "webkit") {
  if (!names.every((entry) => existsSync(entry + ".parallel.finished"))) throw Error("early WebKit");
  if (!names.slice(0, names.indexOf(name)).every((entry) => existsSync(entry + ".webkit.finished"))) throw Error("overlapping WebKit");
} else throw Error("missing engine");
writeFileSync(name + (engines === "webkit" ? ".webkit.finished" : ".parallel.finished"), engines);
if (process.env.MATRIX_FAIL.split("|").includes(name + ":" + engines)) throw Error("fixture failure");
`;

const recoveryFixture = `
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
const names = ${JSON.stringify(runners)};
const engines = process.argv.slice(2);
const scratch = process.env.STORAGE_SCRATCH_ROOT;
const supervised = Boolean(process.env.WAFFLE_BROWSER_PARENT);
const ownedScratch = Boolean(scratch && existsSync(scratch) && scratch === process.env.PROCESS_SCRATCH_ROOT);
appendFileSync("recovery-r42.invocations", JSON.stringify({ engines, supervised, ownedScratch }) + "\\n");
if (!names.every((entry) => existsSync(entry + ".parallel.finished"))) throw Error("early recovery");
if (names.some((entry) => existsSync(entry + ".webkit.finished"))) throw Error("late recovery");
if (!scratch || !statSync(scratch).isDirectory() || realpathSync(scratch) !== scratch) throw Error("recovery scratch not an actual directory");
if (process.platform === "linux") {
  if (!scratch.startsWith(process.cwd() + "/wb-")) throw Error("recovery scratch not supervisor-owned");
  if (!readFileSync("/proc/" + process.ppid + "/cmdline", "utf8").includes("/scripts/browser-supervisor.ts")) throw Error("recovery supervisor not running");
  if (!statSync(process.env.WAFFLE_BROWSER_SHM_ROOT).isDirectory()) throw Error("recovery shared scratch missing");
}
writeFileSync("recovery-r42.scratch", scratch);
appendFileSync("isolated.order", "recovery-r42\\n");
if (process.env.MATRIX_FAIL?.split("|").includes("recovery-r42:chromium")) throw Error("recovery fixture failure");
`;

const matrixEntry = `
import { writeFileSync } from "node:fs";
let failures = [];
try {
  await import("./test-browser.ts");
} catch (error) {
  failures = error instanceof AggregateError ? error.errors.map((entry) => entry.message) : [String(error)];
  throw error;
} finally {
  writeFileSync("failures.json", JSON.stringify(failures));
}
`;

async function matrix(failing: readonly string[]): Promise<void> {
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
    await writeFile(join(root, "scripts/matrix-entry.ts"), matrixEntry);
    for (const runner of runners.concat(chromiumOnly, [socket]))
      await writeFile(join(root, "tests", `${runner}-browser-runner.ts`), fixture);
    await writeFile(join(root, "tests/recovery-r42-browser-runner.ts"), recoveryFixture);
    let failure: unknown;
    try {
      await runOwned([process.execPath, "scripts/matrix-entry.ts"], {
        cwd: root,
        env: { ...process.env, MATRIX_FAIL: failing.join("|"), STORAGE_SCRATCH_ROOT: root },
        timeoutMs: 5000,
      });
    } catch (error) {
      cleanupError = error instanceof CommandCleanupError ? error : undefined;
      failure = error;
    }
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
    const recoveryScratch = await readFile(join(root, "recovery-r42.scratch"), "utf8");
    expect(
      recoveryScratch.startsWith(root + "/wb-") ||
        (process.platform !== "linux" && recoveryScratch === root),
    ).toBe(true);
    expect(await readFile(join(root, "isolated.order"), "utf8")).toBe(
      [recovery].concat(chromiumOnly, [socket]).join("\n") + "\n",
    );
    for (const runner of chromiumOnly.concat([socket])) {
      const engine = runner === socket ? "firefox" : "chromium";
      expect(await readFile(join(root, `${runner}.finished`), "utf8")).toBe(engine);
      expect(await readFile(join(root, `${runner}.invocations`), "utf8")).toBe(engine + "\n");
      const scratch = await readFile(join(root, `${runner}.scratch`), "utf8");
      expect(
        scratch.startsWith(root + "/wb-") || (process.platform !== "linux" && scratch === root),
      ).toBe(true);
    }
    expect((await readdir(root)).filter((name) => name.startsWith("wb-"))).toEqual([]);
    expect(cleanupError).toBeUndefined();
    expect(failure instanceof Error).toBe(failing.length !== 0);
    const order = runners
      .map((runner) => `${runner}:chromium,firefox`)
      .concat(
        [`${recovery}:chromium`],
        runners.map((runner) => `${runner}:webkit`),
        chromiumOnly.map((runner) => `${runner}:chromium`),
        [`${socket}:firefox`],
      );
    expect(JSON.parse(await readFile(join(root, "failures.json"), "utf8"))).toEqual(
      order
        .filter((entry) => failing.includes(entry))
        .map((entry) => `tests/${entry.split(":")[0]}-browser-runner.ts failed`),
    );
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
  await matrix([]);
}, 15_000);

for (const runner of runners) {
  for (const phase of ["chromium,firefox", "webkit"]) {
    test(`${runner} ${phase} failure remains blocking without hiding other suites`, async () => {
      await matrix([`${runner}:${phase}`]);
    }, 15_000);
  }
}

test("continuity Chromium failure remains blocking in its single supervised invocation", async () => {
  await matrix([`${continuity}:chromium`]);
}, 15_000);

test("root continuity Chromium failure remains blocking in its single supervised invocation", async () => {
  await matrix([`${rootContinuity}:chromium`]);
}, 15_000);

test("browser matrix reports ordered failures after every other suite finishes", async () => {
  await matrix([
    `${rootContinuity}:chromium`,
    "storage:chromium,firefox",
    `${continuity}:chromium`,
    "safe-staging:chromium,firefox",
    "network:webkit",
  ]);
}, 15_000);

test("Chromium-only recovery failure blocks matrix without hiding later WebKit suites", async () => {
  await matrix([`${recovery}:chromium`]);
}, 15_000);

test("recovery failure preserves earlier and later suite failures in the aggregate", async () => {
  await matrix(["storage:chromium,firefox", `${recovery}:chromium`, "publication:webkit"]);
}, 15_000);

test("combined isolated Chromium failures retain supervised order and cleanup", async () => {
  await matrix([
    `${rootContinuity}:chromium`,
    "network:webkit",
    `${continuity}:chromium`,
    `${recovery}:chromium`,
    "storage:chromium,firefox",
  ]);
}, 15_000);

test("socket Firefox attachment failure remains blocking in its single invocation", async () => {
  await matrix([`${socket}:firefox`]);
}, 15_000);
