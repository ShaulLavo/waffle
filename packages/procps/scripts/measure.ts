import { createHash } from "node:crypto";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const build = await Bun.build({
  entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
  target: "browser",
  minify: true,
});
if (!build.success || build.outputs.length !== 1)
  throw new Error("Expected one pure browser entry");
const artifact = build.outputs[0];
if (!artifact) throw new Error("Missing build artifact");
const bytes = new Uint8Array(await artifact.arrayBuffer());
const text = new TextDecoder().decode(bytes);
if (text.includes("createRuntime") || text.includes("new Worker") || text.includes("WebAssembly"))
  throw new Error("Pure command entry unexpectedly embeds a runtime or Wasm payload");
const report = {
  kind: "pure-browser-entry",
  runtimeAcceptance: "BLOCKED",
  rawBytes: bytes.byteLength,
  gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
  brotliBytes: brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  wasmBytes: null,
  stripping: "Not applicable. Original TypeScript with no Wasm payload.",
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
