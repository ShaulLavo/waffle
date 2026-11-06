import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { nativeMain } from "./native.js";
import { storageAdapter } from "./storage-host.js";
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
