import { nativeMain } from "waffle/testing/page-runner";
import { filesystemTransportAdapter } from "./filesystem-transport-suite.js";

export function filesystemTransportNative(args: string[], startedAt: number): Promise<number> {
  return nativeMain(
    filesystemTransportAdapter(Number(process.env.FS_TRANSPORT_ROUNDS ?? 60)),
    args,
    {
      startedAt,
      scratchRoot: process.env.FS_TRANSPORT_SCRATCH_ROOT ?? process.env.STORAGE_SCRATCH_ROOT,
    },
  );
}
