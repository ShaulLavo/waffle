import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { nativeMain } from "../../testing/page-runner/native.js";
import { storageAdapter } from "../../testing/page-runner/storage-host.js";
test("native CLI rejects relative result paths before allocating anything", async () => {
  expect(await nativeMain(storageAdapter, ["--result", "relative.json"])).toBe(3);
  expect(await nativeMain(storageAdapter, ["chromium"])).toBe(3);
});
test("native precondition and result write failures have distinct exits without native operations", async () => {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "pr-native-cli-"));
  const previous = process.env.IOS_UDID;
  delete process.env.IOS_UDID;
  try {
    const resultPath = join(root, "result.json");
    expect(await nativeMain(storageAdapter, ["--result", resultPath])).toBe(3);
    expect((await Bun.file(resultPath).json()).exit).toBe(3);
    expect(
      await nativeMain(storageAdapter, ["--result", join(resultPath, "cannot-create.json")]),
    ).toBe(2);
  } finally {
    if (previous === undefined) delete process.env.IOS_UDID;
    else process.env.IOS_UDID = previous;
    await rm(root, { recursive: true, force: true });
  }
});

const entrypoints = [
  { runner: "storage", suite: "storage" },
  { runner: "storage-lock", suite: "storage-lock" },
  { runner: "guest-watch", suite: "guest-watch" },
  { runner: "fs-socket", suite: "fs-socket-attachment" },
  { runner: "search-executor", suite: "search-executor" },
];
// The storage runner is published, so it lives beside the other `./testing/*` helpers.
function runnerPath(runner: string): string {
  const directory = runner === "storage" ? "../../testing" : "..";
  return join(import.meta.dir, directory, `${runner}-browser-runner.ts`);
}
async function invoke(runner: string, resultPath: string, root: string): Promise<number> {
  const child = Bun.spawn(
    [process.execPath, runnerPath(runner), "ios-safari", "--result", resultPath],
    {
      env: {
        ...process.env,
        IOS_UDID: "",
        STORAGE_TEST_FILTER: "must-not-filter-commands",
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
for (const { runner, suite } of entrypoints) {
  test(`${runner} CLI branches before desktop allocation and reports ${suite}`, async () => {
    const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "pr-cli-"));
    try {
      const resultPath = join(root, "result.json");
      expect(await invoke(runner, resultPath, root)).toBe(3);
      expect(await Bun.file(resultPath).json()).toEqual({
        suite,
        exit: 3,
        precondition: "Darwin and exact IOS_UDID required; no native resources allocated",
      });
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(root)).toEqual(["result.json"]);
      expect(await invoke(runner, join(resultPath, "cannot-create.json"), root)).toBe(2);
      expect(await readdir(root)).toEqual(["result.json"]);
      const source = await Bun.file(runnerPath(runner)).text();
      expect(source.includes("process.env.STORAGE_TEST_FILTER")).toBe(runner === "storage");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
