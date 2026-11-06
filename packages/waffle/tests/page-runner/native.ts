import { isAbsolute } from "node:path";
import { SafariDriver } from "./safari-driver.js";
import { runPageSuite, writeResult, type RunOptions, type SuiteAdapter } from "./suite-host.js";
export type NativeOptions = Pick<RunOptions, "filter" | "startedAt" | "port">;
export async function nativeMain<R>(
  adapter: SuiteAdapter<R>,
  args: string[],
  options: NativeOptions = {},
): Promise<number> {
  const resultPath = args[args.indexOf("--result") + 1];
  if (args.length !== 2 || args[0] !== "--result" || !resultPath || !isAbsolute(resultPath)) {
    console.error(`Usage: ${adapter.suite} ios-safari --result /absolute/result.json`);
    return 3;
  }
  try {
    return await runNative(adapter, resultPath, options);
  } catch (error) {
    console.error(`${adapter.suite} host failure: ${String(error)}`);
    return 2;
  }
}
async function runNative<R>(
  adapter: SuiteAdapter<R>,
  resultPath: string,
  options: NativeOptions,
): Promise<number> {
  const udid = process.env.IOS_UDID;
  if (
    process.platform !== "darwin" ||
    !udid ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(udid)
  ) {
    await writeResult(resultPath, {
      suite: adapter.suite,
      exit: 3,
      precondition: "Darwin and exact IOS_UDID required; no native resources allocated",
    });
    return 3;
  }
  const result = await runPageSuite(adapter, (scratch) => new SafariDriver(udid, scratch), {
    resultPath,
    ...options,
  });
  console.log(`${adapter.suite} result: ${resultPath}, exit ${result.exit}`);
  return result.exit;
}
