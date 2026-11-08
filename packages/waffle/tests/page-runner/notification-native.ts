import { commandAdapter } from "./command-suites.js";
import { nativeMain } from "./native.js";

export function notificationNative(args: string[]): Promise<number> {
  return nativeMain(commandAdapter("notification"), args);
}
