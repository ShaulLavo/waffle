import { afterEach, expect } from "bun:test";
import { FilesystemError } from "../../core/filesystem.js";
import { Wasi } from "../../core/wasi.js";
import type { MemFS } from "../../fs/memory.js";
import { guestFunction, guestModule } from "./publication-wasm.js";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

/** A symbolic link at absolute `path` with `target`. */
export function link(fs: MemFS, path: string, target: string): void {
  const resolved = fs.resolveAbsolute(path);
  if (typeof resolved === "number") throw new FilesystemError(resolved);
  expect(fs.symlink(resolved, target)).toBe(0);
}

/** A started guest whose only import is `runtime_fs.<name>` over `fs`, with `/` preopened at fd 3
 * (its rights replaced by `rights` when given). Disposed after the test. */
export function runtimeFsGuest(fs: MemFS, name: string, parameters: number, rights?: bigint) {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  stops.push(() => wasi.descriptors.dispose());
  const types = Array.from({ length: parameters }, () => "i32" as const);
  const module = guestModule("runtime_fs", [{ name, parameters: types }]);
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  wasi.start(instance);
  if (rights !== undefined) {
    const entry = wasi.descriptors.get(3)!;
    (entry as { rightsBase: bigint }).rightsBase = rights;
  }
  return { memory, call: guestFunction(instance, name) };
}
