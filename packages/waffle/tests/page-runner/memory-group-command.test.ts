import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMemoryGroupResult, memoryGroupAdapter } from "./memory-group-command.js";
import { checkedMemoryGroupControl } from "./memory-group-controls-runner.js";
import { FakeDriver, type FakeCommand } from "./fake-driver.js";
import { runPageSuite } from "./suite-host.js";
import { retireCommandGroup } from "../../scripts/owned-command.js";

const disposal = "memory group members | guard: A live page runtime already owns this page";
const ids = memoryGroupAdapter.inventory().map((entry) => entry.id);

test("memory-group selects the entire original entry with the original outer bound", () => {
  expect(memoryGroupAdapter.suite).toBe("memory-group");
  expect(ids).toEqual(["memory-group: memoryGroupBrowser"]);
  expect(memoryGroupAdapter.inventory()[0]?.request("run")).toEqual({
    entry: "/memory-group-browser.js",
    exportName: "memoryGroupBrowser",
    args: [],
  });
  expect(memoryGroupAdapter.budgets(1)).toEqual({
    hello: 20_000,
    heartbeat: 10_000,
    case: 600_000,
    group: 600_000,
    run: 600_000,
  });
  expect(memoryGroupAdapter.policy.allocation).toBeUndefined();
});

for (const result of [
  null,
  {},
  [],
  "resolved",
  { disposal: "memory group members" },
  { disposal: "A live page runtime already owns this page" },
]) {
  test(`original disposal assertion rejects ${JSON.stringify(result)}`, () => {
    expect(() => checkMemoryGroupResult(result)).toThrow("disposal released the page");
  });
}
test("original disposal assertion accepts retained unsettled debt", () => {
  expect(() => checkMemoryGroupResult({ disposal })).not.toThrow();
});

async function host(command: Partial<FakeCommand>) {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "mg-host-"));
  const driver = new FakeDriver("pass", { list: { ids }, ...command });
  try {
    const resultPath = join(root, "result.json");
    const result = await runPageSuite(memoryGroupAdapter, () => driver, {
      assets: {},
      resultPath,
      scratchRoot: root,
      budgets: { hello: 500, heartbeat: 500, case: 600, group: 800, run: 6000 },
    });
    expect(await Bun.file(resultPath).json()).toEqual(result);
    expect(result.selected).toEqual(ids);
    expect(result.omitted).toEqual([]);
    expect(result.cleanup.storage.status).toBe("not-created");
    expect(result.ledger).toEqual([]);
    expect(driver.stopCalls).toBe(1);
    expect(await readdir(root)).toEqual(["result.json"]);
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("memory-group returns actual host-checked results after all documents retire", async () => {
  const actual = { disposal, churn: { rounds: [1, 1, 1, 1, 1, 1] } };
  const result = await host({ result: actual });
  expect(result.exit).toBe(0);
  expect(result.results).toEqual({ [ids[0]!]: actual });
  expect(result.documents.map((doc) => doc.group)).toEqual(["list", ids[0]!, "finish"]);
  expect(result.documents.every((doc) => doc.doc && doc.cutoff !== null)).toBe(true);
});
test("wrong original disposal is a retained case failure and the next result passes", async () => {
  const actual = { disposal: "resolved | guard: released" };
  const failed = await host({ result: actual });
  expect(failed.exit).toBe(1);
  expect(failed.failures).toEqual([]);
  expect(failed.results).toEqual({ [ids[0]!]: actual });
  expect(failed.outcomes[ids[0]!]).toMatchObject({
    status: "fail",
    detail: expect.stringContaining("disposal released the page"),
  });
  expect((await host({ result: { disposal } })).exit).toBe(0);
});
test("an absent memory-group entry or result cannot pass", async () => {
  expect((await host({ list: { ids: [] }, result: { disposal } })).exit).toBe(2);
  expect((await host({})).exit).toBe(2);
});

async function invoke(resultPath: string, root: string): Promise<number> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../memory-group-browser-runner.ts"),
      "ios-safari",
      "--result",
      resultPath,
    ],
    {
      env: {
        ...process.env,
        IOS_UDID: "",
        MEMORY_GROUP_FIXTURE_DIR: "",
        WASI_SDK_PATH: "",
        PROCESS_SCRATCH_ROOT: "",
        STORAGE_SCRATCH_ROOT: root,
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  try {
    return await child.exited;
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

test("ios-safari branches before original fixture and desktop allocation", async () => {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "mg-cli-"));

  try {
    const resultPath = join(root, "result.json");
    expect(await invoke(resultPath, root)).toBe(3);
    expect(await Bun.file(resultPath).json()).toEqual({
      suite: "memory-group",
      exit: 3,
      precondition: "Darwin and exact IOS_UDID required; no native resources allocated",
    });
    expect(await readdir(root)).toEqual(["result.json"]);
    expect(await invoke(join(resultPath, "cannot-create.json"), root)).toBe(2);
    expect(await readdir(root)).toEqual(["result.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser control checker rejects a disposal-only fake result as full coverage", async () => {
  const result = await host({ result: { disposal } });
  expect(() => checkedMemoryGroupControl(result, "complete")).toThrow(
    "original phase results are missing",
  );
});

function restoreVariable(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function retireTestProducer(parentFile: string): Promise<void> {
  if (!(await Bun.file(parentFile).exists())) return;
  const pid = Number(await Bun.file(parentFile).text());
  if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) await retireCommandGroup(pid);
}

test("automatic fixture cancellation remains live and joins its producer before scratch removal", async () => {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "mg-cancel-"));
  const sdk = join(root, "sdk");
  const parentFile = join(root, "compiler-parent");
  const finishedFile = join(root, "compiler-finished");
  const previousSDK = process.env.WASI_SDK_PATH;
  const previousFixture = process.env.MEMORY_GROUP_FIXTURE_DIR;
  const controller = new AbortController();
  let abortedBeforeFinish = false;
  let driverAllocations = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await mkdir(join(sdk, "bin"), { recursive: true });
    const compiler = join(sdk, "bin", "clang");
    await writeFile(
      compiler,
      `#!/bin/sh
printf '%s' "$PPID" > ${JSON.stringify(parentFile)}
sleep 3
printf finished > ${JSON.stringify(finishedFile)}
exit 1
`,
    );
    await chmod(compiler, 0o755);
    process.env.WASI_SDK_PATH = sdk;
    delete process.env.MEMORY_GROUP_FIXTURE_DIR;
    timer = setInterval(() => {
      if (!existsSync(parentFile)) return;
      abortedBeforeFinish = !existsSync(finishedFile);
      controller.abort(new Error("cancel fixture producer"));
      clearInterval(timer);
    }, 5);
    guard = setTimeout(() => controller.abort(new Error("compiler did not start")), 2000);
    const result = await runPageSuite(
      memoryGroupAdapter,
      () => {
        driverAllocations++;
        return new FakeDriver("pass");
      },
      {
        resultPath: join(root, "result.json"),
        scratchRoot: root,
        signal: controller.signal,
        budgets: { hello: 1000, heartbeat: 1000, case: 1000, group: 1000, run: 5000 },
      },
    );
    expect(abortedBeforeFinish).toBe(true);
    expect(await Bun.file(finishedFile).exists()).toBe(false);
    expect(driverAllocations).toBe(0);
    expect(result.exit).toBe(2);
    expect(result.cleanup.scratch.status).toBe("confirmed");
    expect((await readdir(root)).filter((name) => name.startsWith("w-pr-"))).toEqual([]);
  } finally {
    clearInterval(timer);
    clearTimeout(guard);
    controller.abort(new Error("test cleanup"));
    restoreVariable("WASI_SDK_PATH", previousSDK);
    restoreVariable("MEMORY_GROUP_FIXTURE_DIR", previousFixture);
    await retireTestProducer(parentFile);
    await rm(root, { recursive: true, force: true });
  }
});
