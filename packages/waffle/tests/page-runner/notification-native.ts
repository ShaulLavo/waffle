import { commandAdapter } from "./command-suites.js";
import { nativeMain } from "../../testing/page-runner/native.js";

export function notificationNative(args: string[]): Promise<number> {
  return nativeMain(commandAdapter("notification"), args);
}
