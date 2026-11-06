import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

// G0.2 display/guest baselines: 3,068 B and 4,932 B gzip. G1 scene service: 25,324 B.
// Bun 1.4.4, 12% headroom. Creation/upload/binding descriptors justify the service increase.
// Display, guest and the existing core budget are unchanged.
export const GPU_BUDGETS = { display: 3437, guest: 5524, service: 28363 };
const entries = {
  display: "browser/display/owner.ts",
  guest: "browser/gpu/guest.ts",
  service: "browser/gpu/service-worker.ts",
};
export function checkGpuBudget(name: keyof typeof GPU_BUDGETS, measured: number): void {
  if (measured > GPU_BUDGETS[name])
    throw new Error(
      `${name} GPU gzip exceeds ${GPU_BUDGETS[name]} bytes by ${measured - GPU_BUDGETS[name]}`,
    );
}
export async function gpuSize() {
  const sizes: Partial<Record<keyof typeof GPU_BUDGETS, number>> = {};
  for (const name of Object.keys(entries) as (keyof typeof entries)[]) {
    const result = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "..", entries[name])],
      target: "browser",
      format: "esm",
      minify: true,
    });
    if (!result.success || !result.outputs[0])
      throw new Error(`GPU bundle failed: ${result.logs.join("\n")}`);
    const measured = gzipSync(Buffer.from(await result.outputs[0].arrayBuffer()), {
      level: 9,
    }).byteLength;
    checkGpuBudget(name, measured);
    sizes[name] = measured;
  }
  return sizes;
}
if (import.meta.main) console.log(JSON.stringify(await gpuSize()));
