import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { WASI } from "node:wasi";

const EFAULT = 21;

export function commandCwdImport(memory: () => WebAssembly.Memory, cwd: string) {
  if (!cwd.startsWith("/") || cwd.includes("\0")) throw new Error("Expected an absolute guest cwd");
  const bytes = new TextEncoder().encode(cwd);
  return (ptr: number, capacity: number): number => {
    ptr >>>= 0;
    capacity >>>= 0;
    const buffer = memory().buffer;
    if (ptr + capacity > buffer.byteLength) return -EFAULT;
    if (capacity >= bytes.length) new Uint8Array(buffer, ptr, bytes.length).set(bytes);
    return bytes.length;
  };
}

interface WasiCommandOptions {
  readonly cwd: string;
  readonly args: string[];
  readonly env: Readonly<Record<string, string>>;
  readonly preopens: Readonly<Record<string, string>>;
}

export function runWasiCommand(module: WebAssembly.Module, options: WasiCommandOptions): number {
  const { args, env, preopens, cwd } = options;
  const wasi = new WASI({ version: "preview1", args, env, preopens, returnOnExit: true });
  let memory: WebAssembly.Memory | undefined;
  const cwdImport = commandCwdImport(() => {
    if (!memory) throw new Error("WASI command memory is required before cwd");
    return memory;
  }, cwd);
  const instance = new WebAssembly.Instance(module, {
    ...wasi.getImportObject(),
    runtime_proc: { cwd: cwdImport },
  });
  if (!(instance.exports.memory instanceof WebAssembly.Memory))
    throw new Error("Expected a WASI command exporting memory");
  memory = instance.exports.memory;
  return wasi.start(instance);
}

function assignments(values: readonly string[], option: string): Record<string, string> {
  return Object.fromEntries(
    values.map((pair) => {
      const separator = pair.indexOf("=");
      if (separator < 1) throw new Error(`Expected ${option} NAME=VALUE`);
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    }),
  );
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: "string", default: "/" },
      argv0: { type: "string" },
      env: { type: "string", multiple: true, default: [] },
      dir: { type: "string", multiple: true, default: [] },
    },
  });
  const [path, ...args] = positionals;
  if (!path) throw new Error("Pass -- COMMAND.wasm [ARG ...]");
  const module = new WebAssembly.Module(readFileSync(path));
  process.exitCode = runWasiCommand(module, {
    cwd: values.cwd,
    args: [values.argv0 ?? path].concat(args),
    env: assignments(values.env, "--env"),
    preopens: assignments(values.dir, "--dir"),
  });
}
