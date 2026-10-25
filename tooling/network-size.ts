import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

export const NETWORK_BUDGET = { wasm: 88_000, wasmGzip: 28_000, loaderGzip: 800 };
export function checkNetworkBudget(size: typeof NETWORK_BUDGET): void {
  for (const name of ["wasm", "wasmGzip", "loaderGzip"] as const) {
    if (size[name] > NETWORK_BUDGET[name])
      throw new Error(`network ${name} exceeds ${NETWORK_BUDGET[name]} bytes`);
  }
}
export async function networkSize(): Promise<typeof NETWORK_BUDGET> {
  const root = resolve(import.meta.dir, "..");
  const wasm = new Uint8Array(
    await Bun.file(resolve(root, "browser/net/network.wasm")).arrayBuffer(),
  );
  const build = await Bun.build({
    entrypoints: [resolve(root, "browser/net/module.ts")],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!build.success || !build.outputs[0])
    throw new AggregateError(build.logs, "Network loader build failed");
  const loader = new Uint8Array(await build.outputs[0].arrayBuffer());
  const size = {
    wasm: wasm.length,
    wasmGzip: gzipSync(wasm, { level: 9 }).length,
    loaderGzip: gzipSync(loader, { level: 9 }).length,
  };
  checkNetworkBudget(size);
  return size;
}
if (import.meta.main) console.log(JSON.stringify(await networkSize(), null, 2));
