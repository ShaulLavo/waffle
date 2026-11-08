import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCleanupError, runOwned } from "../scripts/owned-command.ts";

const runners = [
  "browser-navigation",
  "safe-staging",
  "storage",
  "storage-lock",
  "process-recycling",
  "network",
  "publication",
  "publication-cross-tab",
  "search-executor",
  "guest-watch",
  "filesystem-transport",
  "gpu",
];
const continuity = "workspace-continuity";
const rootContinuity = "root-continuity";
const rootControls = "root-continuity-controls";
const networkControls = "network-controls";
const recovery = "recovery-r42";
const nativeGpu = "gpu-native";
const asyncGpu = "gpu-async";
const memoryGroup = "memory-group";
const chromiumOnly = [continuity, rootContinuity, rootControls, networkControls, memoryGroup];
const socket = "fs-socket";
const reporterControls = "reporter-controls";
const processControls = "process-recycling-controls";
const gpuAsyncControls = "gpu-async-controls";
function isolatedEngines(runner: string): string {
  if (runner === reporterControls) return "chromium,webkit";
  if (runner === gpuAsyncControls) return "--ci,chromium,webkit";
  if (runner === socket) return "firefox";
  if (runner === rootControls || runner === processControls || runner === networkControls)
    return "--page-controls,chromium";
  return "chromium";
}
const fixture = `
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
const names = ${JSON.stringify(runners)};
const file = process.argv[1].endsWith("/gpu-async-controls-runner.ts") ? "gpu-async-controls" : process.argv[1].includes("/page-runner/") ? "reporter-controls" : process.argv[1].split("/").at(-1).replace("-browser-runner.ts", "");
const modes = ${JSON.stringify({ "root-continuity": "root-continuity-controls", "process-recycling": "process-recycling-controls", network: networkControls })};
const name = process.argv[2] === "--page-controls" ? modes[file] : file;
const engines = process.argv.slice(2).join(",");
if (${JSON.stringify(chromiumOnly.concat([socket, reporterControls, processControls, gpuAsyncControls]))}.includes(name)) {
  appendFileSync(name + ".invocations", engines + "\\n");
  const expected = ${JSON.stringify(Object.fromEntries(chromiumOnly.concat([socket, reporterControls, processControls, gpuAsyncControls]).map((name) => [name, isolatedEngines(name)])))};
  if (engines !== expected[name]) throw Error("isolated engine repeated or changed");
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
  const predecessors = ${JSON.stringify(Object.fromEntries(chromiumOnly.concat([socket, reporterControls, processControls, gpuAsyncControls]).map((name, index, all) => [name, all[index - 1] ?? asyncGpu])))};
  const predecessor = predecessors[name];
  if (process.platform === "linux" && existsSync(readFileSync(predecessor + ".scratch", "utf8"))) throw Error("isolated predecessor scratch retained");
  appendFileSync("isolated.order", name + "\\n");
  writeFileSync(name + ".scratch", scratch);
  writeFileSync(name + ".finished", engines);
  if (process.env.MATRIX_FAIL.split("|").includes(name + ":" + engines)) throw Error("fixture failure");
  process.exit(0);
}
if (engines === "chromium,firefox") {
  const cohort = names.filter((entry) => entry !== "gpu");
  if (name === "gpu") {
    if (existsSync("gpu-async.parallel.finished")) throw Error("async ran before compiled draw");
    if (!cohort.every((entry) => existsSync(entry + ".parallel.finished"))) throw Error("GPU overlapped another browser suite");
  } else {
    writeFileSync(name + ".started", "");
    while (!cohort.every((entry) => existsSync(entry + ".started"))) await Bun.sleep(10);
  }
} else if (engines === "webkit") {
  if (!names.every((entry) => existsSync(entry + ".parallel.finished"))) throw Error("early WebKit");
  if (!existsSync("gpu-async.parallel.finished")) throw Error("early WebKit before async");
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

const nativeGpuFixture =
  recoveryFixture.replaceAll("recovery-r42", "gpu-native") +
  `
if (!existsSync("recovery-r42.scratch")) throw Error("native controls ran before recovery");
if (process.platform === "linux" && existsSync(readFileSync("recovery-r42.scratch", "utf8"))) throw Error("native controls overlap recovery scratch");
`;

const asyncGpuFixture = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const engines = process.argv.slice(2).join(",");
const scratch = process.env.STORAGE_SCRATCH_ROOT;
const phase = engines === "chromium,firefox" ? "parallel" : "webkit";
if (engines !== "chromium,firefox" && engines !== "webkit") throw Error("changed async engine group");
appendFileSync("gpu-async.invocations", engines + "\\n");
if (existsSync("gpu-async." + phase + ".finished")) throw Error("async repeated");
const predecessor = phase === "parallel" ? "gpu-native" : "gpu-async.parallel";
if (phase === "parallel" && !existsSync("gpu-native.scratch")) throw Error("async ran before native controls");
if (phase === "webkit" && !${JSON.stringify(runners)}.every((name) => existsSync(name + ".webkit.finished"))) throw Error("early async WebKit");
if (process.platform === "linux" && existsSync(readFileSync(predecessor + ".scratch", "utf8"))) throw Error("async overlapped predecessor scratch");
writeFileSync("gpu-async." + phase + ".scratch", scratch);
writeFileSync("gpu-async.scratch", scratch);
writeFileSync("gpu-async." + phase + ".finished", engines);
appendFileSync("isolated.order", "gpu-async:" + phase + "\\n");
if (process.env.MATRIX_FAIL.split("|").includes("gpu-async:" + engines)) throw Error("async fixture failure");
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
    for (const runner of runners
      .concat(chromiumOnly, [socket])
      .filter((name) => name !== rootControls && name !== networkControls))
      await writeFile(join(root, "tests", `${runner}-browser-runner.ts`), fixture);
    await writeFile(join(root, "tests/recovery-r42-browser-runner.ts"), recoveryFixture);
    await writeFile(join(root, "tests/gpu-native-browser-runner.ts"), nativeGpuFixture);
    await writeFile(join(root, "tests/gpu-async-browser-runner.ts"), asyncGpuFixture);
    await mkdir(join(root, "tests/page-runner"));
    await writeFile(join(root, "tests/page-runner/browser-controls-runner.ts"), fixture);
    await writeFile(join(root, "tests/page-runner/gpu-async-controls-runner.ts"), fixture);
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
    for (const runner of [recovery, nativeGpu]) {
      const discovery = Bun.file(join(root, `${runner}.invocations`));
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
      const recoveryScratch = await readFile(join(root, `${runner}.scratch`), "utf8");
      expect(
        recoveryScratch.startsWith(root + "/wb-") ||
          (process.platform !== "linux" && recoveryScratch === root),
      ).toBe(true);
    }
    expect(await readFile(join(root, "isolated.order"), "utf8")).toBe(
      [recovery, nativeGpu, "gpu-async:parallel", "gpu-async:webkit"]
        .concat(chromiumOnly, [socket, reporterControls, processControls, gpuAsyncControls])
        .join("\n") + "\n",
    );
    for (const runner of chromiumOnly.concat([
      socket,
      reporterControls,
      processControls,
      gpuAsyncControls,
    ])) {
      const engine = isolatedEngines(runner);
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
        [`${recovery}:chromium`, `${nativeGpu}:chromium`, `${asyncGpu}:chromium,firefox`],
        runners.map((runner) => `${runner}:webkit`),
        [`${asyncGpu}:webkit`],
        chromiumOnly.map((runner) => `${runner}:${isolatedEngines(runner)}`),
        [
          `${socket}:firefox`,
          `${reporterControls}:chromium,webkit`,
          `${processControls}:--page-controls,chromium`,
          `${gpuAsyncControls}:--ci,chromium,webkit`,
        ],
      );
    expect(JSON.parse(await readFile(join(root, "failures.json"), "utf8"))).toEqual(
      order
        .filter((entry) => failing.includes(entry))
        .map((entry) =>
          entry.startsWith(`${gpuAsyncControls}:`)
            ? "tests/page-runner/gpu-async-controls-runner.ts failed"
            : entry.startsWith(`${reporterControls}:`)
              ? "tests/page-runner/browser-controls-runner.ts failed"
              : entry.startsWith(`${processControls}:`)
                ? "tests/process-recycling-browser-runner.ts failed"
                : entry.startsWith(`${networkControls}:`)
                  ? "tests/network-browser-runner.ts failed"
                  : entry.startsWith(`${rootControls}:`)
                    ? `tests/${rootContinuity}-browser-runner.ts failed`
                    : `tests/${entry.split(":")[0]}-browser-runner.ts failed`,
        ),
    );
    expect(await readFile(join(root, "gpu-async.invocations"), "utf8")).toBe(
      "chromium,firefox\nwebkit\n",
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

test("root continuity hosted controls fail independently after the stock command", async () => {
  await matrix([`${rootControls}:--page-controls,chromium`]);
}, 15_000);

test("both root continuity modes retain their independent blocking failures", async () => {
  await matrix([`${rootContinuity}:chromium`, `${rootControls}:--page-controls,chromium`]);
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

test("page-owned reporter controls fail the matrix without changing existing engine groups", async () => {
  await matrix([`${reporterControls}:chromium,webkit`]);
}, 15_000);

test("native GPU failure remains blocking in its single supervised Chromium invocation", async () => {
  await matrix([`${nativeGpu}:chromium`]);
}, 15_000);

async function nativeDiscovery(
  group: "parallel" | "serial",
  failingRunner: "gpu-native" | "gpu-async" | "gpu-async-controls" | undefined,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "waffle-native-discovery-"));
  let cleanupError: CommandCleanupError | undefined;
  try {
    await mkdir(join(root, "scripts"));
    await copyFile(
      join(import.meta.dir, "../scripts/test-browser.ts"),
      join(root, "scripts/test-browser.ts"),
    );
    await writeFile(join(root, "scripts/matrix-entry.ts"), matrixEntry);
    await writeFile(
      join(root, "scripts/browser-command.ts"),
      `
import { appendFileSync } from "node:fs";
export async function runBrowserSuite(command) {
  appendFileSync("commands.jsonl", JSON.stringify(command.slice(1)) + "\\n");
  const failed = process.env.MATRIX_FAIL === "gpu-async-controls" ? "tests/page-runner/gpu-async-controls-runner.ts" : "tests/" + process.env.MATRIX_FAIL + "-browser-runner.ts";
  if (command[1] === failed) throw Error("GPU control failed");
}
`,
    );
    let failure: unknown;
    try {
      await runOwned([process.execPath, "scripts/matrix-entry.ts"], {
        cwd: root,
        env: { ...process.env, WAFFLE_BROWSER_GROUP: group, MATRIX_FAIL: failingRunner ?? "" },
      });
    } catch (error) {
      cleanupError = error instanceof CommandCleanupError ? error : undefined;
      failure = error;
    }
    expect(cleanupError).toBeUndefined();
    expect(failure instanceof Error).toBe(failingRunner !== undefined);
    const commands: string[][] = (await readFile(join(root, "commands.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      commands.filter((command) => command[0] === "tests/gpu-native-browser-runner.ts"),
    ).toEqual(group === "parallel" ? [["tests/gpu-native-browser-runner.ts", "chromium"]] : []);
    expect(
      commands.filter((command) => command[0] === "tests/gpu-async-browser-runner.ts"),
    ).toEqual(
      group === "parallel"
        ? [["tests/gpu-async-browser-runner.ts", "chromium", "firefox"]]
        : [["tests/gpu-async-browser-runner.ts", "webkit"]],
    );
    expect(
      commands.filter((command) => command[0] === "tests/page-runner/gpu-async-controls-runner.ts"),
    ).toEqual(
      group === "serial"
        ? [["tests/page-runner/gpu-async-controls-runner.ts", "--ci", "chromium", "webkit"]]
        : [],
    );
    const failed =
      failingRunner === "gpu-async-controls"
        ? "tests/page-runner/gpu-async-controls-runner.ts"
        : `tests/${failingRunner}-browser-runner.ts`;
    expect(JSON.parse(await readFile(join(root, "failures.json"), "utf8"))).toEqual(
      failingRunner ? [`${failed} failed`] : [],
    );
  } finally {
    if (cleanupError) console.error(`Retained native discovery scratch: ${root}`, cleanupError);
    else await rm(root, { recursive: true, force: true });
  }
}

for (const group of ["parallel", "serial"] as const)
  test(`native GPU executable discovery in CI ${group} group`, () =>
    nativeDiscovery(group, undefined));

test("native GPU error exits the designated CI group nonzero", () =>
  nativeDiscovery("parallel", "gpu-native"));
test("draw-heavy GPU work runs in its own batch without changing engine groups", async () => {
  await matrix([]);
}, 15_000);

test("process page controls fail separately after reporter controls without repeating the original desktop campaign", async () => {
  await matrix([`${processControls}:--page-controls,chromium`]);
}, 15_000);

test("both process modes retain their independent failures in normal discovery order", async () => {
  await matrix([
    "process-recycling:chromium,firefox",
    `${processControls}:--page-controls,chromium`,
  ]);
}, 15_000);

for (const engines of ["chromium,firefox", "webkit"])
  test(
    `compiled async ${engines} failure blocks without overlapping native controls`,
    () => matrix([`${asyncGpu}:${engines}`]),
    15_000,
  );

for (const group of ["parallel", "serial"] as const)
  test(`compiled async error exits the ${group} CI group nonzero`, () =>
    nativeDiscovery(group, "gpu-async"));

test("page-owned GPU async controls are a separate blocking supervised CI command", async () => {
  await matrix([`${gpuAsyncControls}:--ci,chromium,webkit`]);
}, 15_000);

test("stock and page-owned GPU async failures remain independently blocking", async () => {
  await matrix([`${asyncGpu}:chromium,firefox`, `${gpuAsyncControls}:--ci,chromium,webkit`]);
}, 15_000);

test("page-owned GPU async controls fail the serial CI group", () =>
  nativeDiscovery("serial", "gpu-async-controls"));

test("network controls fail independently without repeating the complete positive matrix", async () => {
  await matrix([`${networkControls}:--page-controls,chromium`]);
}, 15_000);
