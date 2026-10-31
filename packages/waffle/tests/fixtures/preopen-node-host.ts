import { WASI } from "node:wasi";
import { readFileSync } from "node:fs";

const wasi = new WASI({
  version: "preview1",
  args: ["preopen-guest"],
  env: {},
  preopens: { "/": process.argv[3]! },
  returnOnExit: true,
});
const module = new WebAssembly.Module(readFileSync(process.argv[2]!));
const instance = new WebAssembly.Instance(module, wasi.getImportObject() as WebAssembly.Imports);
process.exitCode = wasi.start(instance);
