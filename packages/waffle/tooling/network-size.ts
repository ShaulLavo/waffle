import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

export const NETWORK_BUDGET = {
  wasm: 78_000,
  wasmGzip: 28_000,
  loaderGzip: 800,
  generatedRaw: 375_000,
  chunkRaw: 133_000,
  chunkGzip: 40_000,
  bufferLoaderGzip: 900,
};
export function checkNetworkBudget(size: typeof NETWORK_BUDGET): void {
  for (const name of [
    "wasm",
    "wasmGzip",
    "loaderGzip",
    "generatedRaw",
    "chunkRaw",
    "chunkGzip",
    "bufferLoaderGzip",
  ] as const) {
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
  const generated = new Uint8Array(
    await Bun.file(resolve(root, "browser/net/network.buffer.js")).arrayBuffer(),
  );
  const chunk = await Bun.build({
    entrypoints: [resolve(root, "browser/net/network.buffer.js")],
    target: "browser",
    format: "esm",
    minify: true,
  });
  const buffer = await Bun.build({
    entrypoints: [resolve(root, "browser/net/buffer-module.ts")],
    target: "browser",
    format: "esm",
    minify: true,
    external: [resolve(root, "browser/net/network.buffer.js")],
  });
  if (!chunk.success || !chunk.outputs[0] || !buffer.success || !buffer.outputs[0])
    throw new Error("Network buffer size build failed");
  const chunkBytes = new Uint8Array(await chunk.outputs[0].arrayBuffer());
  const size = {
    generatedRaw: generated.length,
    chunkRaw: chunkBytes.length,
    chunkGzip: gzipSync(chunkBytes, { level: 9 }).length,
    bufferLoaderGzip: gzipSync(new Uint8Array(await buffer.outputs[0].arrayBuffer()), { level: 9 })
      .length,
    wasm: wasm.length,
    wasmGzip: gzipSync(wasm, { level: 9 }).length,
    loaderGzip: gzipSync(loader, { level: 9 }).length,
  };
  checkNetworkBudget(size);
  return size;
}
if (import.meta.main) console.log(JSON.stringify(await networkSize(), null, 2));
