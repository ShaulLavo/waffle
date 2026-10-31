import { createHash } from "node:crypto";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const result = await Bun.build({
  entrypoints: [new URL("../src/catalog.ts", import.meta.url).pathname],
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
});
if (!result.success) throw new Error("Command catalog build failed");
const records = [];
for (const output of result.outputs) {
  const bytes = new Uint8Array(await output.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  if (text.includes("createRuntime") || text.includes("new Worker") || text.includes("WebAssembly"))
    throw new Error("Optional command catalog embeds a runtime or Wasm payload");
  records.push({
    kind: output.kind,
    rawBytes: bytes.length,
    gzipBytes: gzipSync(bytes, { level: 9 }).length,
    brotliBytes: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
      .length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
if (records.filter((record) => record.kind === "entry-point").length !== 1 || records.length < 2)
  throw new Error("Expected a metadata entry and separately loaded command implementation");
console.log(JSON.stringify({ kind: "optional-host-commands", artifacts: records }, null, 2));
