import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

// G0.2 baseline on Bun 1.4.4: display 3,051 B, guest 4,924 B, service 22,382 B gzip.
// Each gate allows 12% headroom; the existing core budget is unchanged.
export const GPU_BUDGETS = { display: 3418, guest: 5515, service: 25068 };
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
