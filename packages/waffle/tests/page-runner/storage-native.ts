import { isAbsolute } from "node:path";
import { SafariDriver } from "./safari-driver.js";
import { runStorage, writeResult } from "./storage-host.js";
export async function storageNativeMain(args: string[]): Promise<number> {
  const resultPath = args[args.indexOf("--result") + 1];
  if (args.length !== 2 || args[0] !== "--result" || !resultPath || !isAbsolute(resultPath)) {
    console.error("Usage: storage-browser-runner.ts ios-safari --result /absolute/result.json");
    return 3;
  }
  const udid = process.env.IOS_UDID;
  if (process.platform !== "darwin" || !udid || !/^[A-Fa-f0-9-]{36}$/.test(udid)) {
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
