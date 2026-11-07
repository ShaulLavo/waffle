import { nativeMain } from "waffle/testing/page-runner";
import { gpuAsyncAdapter } from "./gpu-async-suite.js";

export function gpuAsyncNative(args: string[], startedAt: number): Promise<number> {
  return nativeMain(gpuAsyncAdapter("ios-safari"), args, { startedAt });
}
