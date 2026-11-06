import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { storageNativeMain } from "./storage-native.js";
test("native CLI rejects relative result paths before allocating anything", async () => {
  expect(await storageNativeMain(["--result", "relative.json"])).toBe(3);
  expect(await storageNativeMain(["chromium"])).toBe(3);
});
test("native precondition and result write failures have distinct exits without native operations", async () => {
  const root = await mkdtemp("/work/tmp/pr-native-cli-");
  const previous = process.env.IOS_UDID;
  delete process.env.IOS_UDID;
  try {
    const resultPath = join(root, "result.json");
    expect(await storageNativeMain(["--result", resultPath])).toBe(3);
    expect((await Bun.file(resultPath).json()).exit).toBe(3);
    expect(await storageNativeMain(["--result", join(resultPath, "cannot-create.json")])).toBe(2);
  } finally {
    if (previous === undefined) delete process.env.IOS_UDID;
    else process.env.IOS_UDID = previous;
    await rm(root, { recursive: true, force: true });
  }
});
