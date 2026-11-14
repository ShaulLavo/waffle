import { join, resolve } from "node:path";
import { nativeMain } from "waffle/testing/page-runner";
import { assertRuntimeSafariPacket } from "../threads-runtime-safari-packet.js";
import { threadsRuntimeAdapter } from "./threads-runtime-suite.js";

export function threadsRuntimeNative(args: string[], startedAt: number): Promise<number> {
  return nativeMain(threadsRuntimeAdapter(process.env.THREAD_FIXTURE_DIR ?? ""), args, {
    startedAt,
    scratchRoot: process.env.PROCESS_SCRATCH_ROOT ?? process.env.STORAGE_SCRATCH_ROOT,
  });
}

if (import.meta.main) {
  const startedAt = performance.now();
  const [directory, ...args] = process.argv.slice(2);
  if (!directory) throw new Error("usage: ios-runner.mjs PACKET --result /absolute/result.json");
  const packet = resolve(directory);
  const manifest = await assertRuntimeSafariPacket(packet);
  const assets: Record<string, Blob | string> = {};
  for (const asset of manifest.assets)
    assets[`/${asset.path}`] = Bun.file(join(packet, asset.path));
  assets["/threads.wasm"] = Bun.file(join(packet, "threads.wasm"));
  process.exitCode = await nativeMain(
    threadsRuntimeAdapter("", { fixtureSha256: manifest.fixtureSha256, assets }),
    args,
    {
      startedAt,
      scratchRoot: process.env.PROCESS_SCRATCH_ROOT ?? process.env.STORAGE_SCRATCH_ROOT,
    },
  );
}
