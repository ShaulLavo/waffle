import { isAbsolute } from "node:path";
import { SafariDriver } from "./safari-driver.js";
import { runStorage, writeResult } from "./storage-host.js";
export async function storageNativeMain(args: string[]): Promise<number> {
  const resultPath = args[args.indexOf("--result") + 1];
  if (args.length !== 2 || args[0] !== "--result" || !resultPath || !isAbsolute(resultPath)) {
    console.error("Usage: storage-browser-runner.ts ios-safari --result /absolute/result.json");
    return 3;
  }
  try {
    return await runNative(resultPath);
  } catch (error) {
    console.error(`Storage host failure: ${String(error)}`);
    return 2;
  }
}
async function runNative(resultPath: string): Promise<number> {
  const udid = process.env.IOS_UDID;
  if (
    process.platform !== "darwin" ||
    !udid ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(udid)
  ) {
    await writeResult(resultPath, {
      suite: "storage",
      exit: 3,
      precondition: "Darwin and exact IOS_UDID required; no native resources allocated",
    });
    return 3;
  }
  const result = await runStorage((scratch) => new SafariDriver(udid, scratch), {
    resultPath,
    filter: process.env.STORAGE_TEST_FILTER,
  });
  console.log(`Storage result: ${resultPath}, exit ${result.exit}`);
  return result.exit;
}
