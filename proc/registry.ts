import { normalize } from "../core/path";

/** Only metadata is needed for executable admission, never file contents or a filesystem owner. */
export type ExecutableLookup = (path: string) => { readonly kind: "file" | "dir" } | undefined | Promise<{ readonly kind: "file" | "dir" } | undefined>;

export interface Executable {
  /** The loader compiles asynchronously (normally in a compiler worker). Never instantiate here. */
  module: WebAssembly.Module | (() => WebAssembly.Module | Promise<WebAssembly.Module>);
  /** Opaque guest adapter key, interpreted by the host's worker launcher, not the registry. */
  adapter: string;
  /** True only when admission injected interruption imports. Trusted cooperative modules omit it. */
  readonly interruptible?: boolean;
}
export interface ResolvedExecutable { readonly module: WebAssembly.Module; readonly adapter: string; readonly interruptible: boolean }
export class ExecutableNotFound extends Error {
  readonly code = "ENOENT";
  constructor(name: string) { super(`executable not found: ${name}`); this.name = "ExecutableNotFound"; }
}
export class ExecutableNotRunnable extends Error {
  readonly code = "EACCES";
  constructor(name: string, directory: boolean) {
    super(directory ? `cannot execute directory: ${name}` : `file is not a registered executable: ${name}`);
    this.name = "ExecutableNotRunnable";
  }
}
/** Generic names -> compiled module + adapter, with one compilation per module source.
 * Instances and used workers are deliberately not cached.
 */
export class ExecutableRegistry {
  private readonly entries = new Map<string, Readonly<Required<Executable>>>();
  private readonly modules = new WeakMap<Executable["module"], Promise<WebAssembly.Module>>();
  /** A page runtime supplies its filesystem; standalone registries may use opaque names. */
  constructor(private readonly lookup?: ExecutableLookup) {}
  register(name: string, executable: Executable): void {
    if (!name || !executable.adapter) throw new TypeError("executable and adapter names are required");
    this.entries.set(name, Object.freeze({ ...executable, interruptible: executable.interruptible ?? false }));
  }
  unregister(name: string): boolean { return this.entries.delete(name); }
  has(name: string): boolean { return this.entries.has(name); }
  async resolve(name: string, cwd = "/"): Promise<ResolvedExecutable> {
    if (!name) throw new ExecutableNotFound(name);
    const path = this.lookup ? normalize(name, cwd) : name;
    // Capture the exact registration before yielding: replacing/releasing its lease must
    // not substitute another adapter or interruption policy into an accepted resolution.
    const entry = this.entries.get(path);
    if (this.lookup) {
      const file = await this.lookup(path);
      if (!file) throw new ExecutableNotFound(path);
      if (file.kind !== "file" || !entry) throw new ExecutableNotRunnable(path, file.kind === "dir");
    }
    if (!entry) throw new ExecutableNotFound(path);
    let pending = this.modules.get(entry.module);
    if (!pending) {
      pending = Promise.resolve().then(() => typeof entry.module === "function" ? entry.module() : entry.module).then(module => {
        if (!(module instanceof WebAssembly.Module)) throw new TypeError("executable loader did not return a compiled WebAssembly.Module");
        return module;
      });
      this.modules.set(entry.module, pending);
    }
    return { module: await pending, adapter: entry.adapter, interruptible: entry.interruptible };
  }
}
