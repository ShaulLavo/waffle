import { nativeMain } from "@waffle-os/runtime/testing/page-runner";
import { crossTabAdapter } from "./publication-cross-tab-suite.js";

export function crossTabNative(args: string[], startedAt: number): Promise<number> {
  return nativeMain(crossTabAdapter, args, { startedAt });
}
