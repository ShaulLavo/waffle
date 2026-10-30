import { readFile, writeFile } from "node:fs/promises";
import { brotliCompressSync, constants } from "node:zlib";

const script = await readFile("dist/gh-cli.js");
const brotli = brotliCompressSync(script, {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
});
const sizes = { scriptBytes: script.length, brotliBytes: brotli.length };
await writeFile("dist/gh.sizes.json", `${JSON.stringify(sizes, null, 2)}\n`);
console.log(`gh script: ${sizes.scriptBytes} bytes; Brotli: ${sizes.brotliBytes} bytes`);
