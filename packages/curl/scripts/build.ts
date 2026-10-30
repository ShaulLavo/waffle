import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { brotliCompressSync } from "node:zlib";

const root = resolve(import.meta.dir, "..");
if (Bun.version !== "1.4.4") throw new Error("curl producer requires Bun 1.4.4");
const result = await Bun.build({
  entrypoints: [resolve(root, "src/index.ts")],
  outdir: resolve(root, "dist"),
  naming: "curl.js",
  target: "browser",
  format: "esm",
  minify: true,
  splitting: false,
});
if (!result.success) throw new Error(result.logs.join("\n"));
const output = result.outputs[0];
if (!output) throw new Error("curl build emitted no script");
const bytes = new Uint8Array(await output.arrayBuffer());
const compressed = brotliCompressSync(bytes);
await mkdir(resolve(root, ".build"), { recursive: true });
await writeFile(resolve(root, "dist/curl.js.br"), compressed);
await writeFile(resolve(root, "dist/NOTICE"), await readFile(resolve(root, "NOTICE")));
const inputs: Record<string, string> = {};
for (const name of (await readdir(resolve(root, "src"))).sort()) {
  const input = await readFile(resolve(root, "src", name));
  inputs[`src/${name}`] = createHash("sha256").update(input).digest("hex");
}
const receipt = {
  inputs,
  producer: `Bun ${Bun.version}`,
  runtimeAdmission: "BLOCKED: no runtime-native host-command contract supplied",
  scriptBytes: bytes.length,
  brotliBytes: compressed.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
await writeFile(resolve(root, ".build/size.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
