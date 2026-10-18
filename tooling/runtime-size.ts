import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

// Same-realm intrinsic captures and private descriptor collections: 8,010 B gzip
// on Bun 1.4.2 (2026-10-18). Keep a bounded 182-byte margin, not an open-ended gate.
export const CORE_BUDGET_BYTES = 8_192;
export function checkCoreBudget(gzipBytes: number): void {
  if (gzipBytes > CORE_BUDGET_BYTES)
    throw new Error(
      `core exceeds ${CORE_BUDGET_BYTES} B gzip budget by ${gzipBytes - CORE_BUDGET_BYTES} B`,
    );
}

async function bundle(entrypoint: string): Promise<number> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  const output = result.outputs.find((output) => output.path.endsWith(".js"));
  if (!output) throw new Error(`Missing bundle for ${entrypoint}`);
  return gzipSync(Buffer.from(await output.arrayBuffer()), { level: 9 }).length;
}

export async function runtimeSize(): Promise<{
  coreGzip: number;
  fsGzip: number;
  procGzip: number;
}> {
  const root = resolve(import.meta.dir, "..");
  const [coreGzip, fsGzip, procGzip] = await Promise.all([
    bundle(resolve(root, "core/index.ts")),
    bundle(resolve(root, "fs/index.ts")),
    bundle(resolve(root, "proc/index.ts")),
  ]);
  checkCoreBudget(coreGzip);
  return { coreGzip, fsGzip, procGzip };
}

if (import.meta.main) console.log(JSON.stringify(await runtimeSize(), null, 2));
