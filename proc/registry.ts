import { ExecutableFormatError } from "./start-failure.js";
import { normalize } from "../core/path.js";

/** Only metadata is needed for executable admission, never file contents or a filesystem owner. */
export type ExecutableLookup = (
  path: string,
) =>
  | { readonly path: string; readonly kind: "file" | "dir" }
  | undefined
  | Promise<{ readonly path: string; readonly kind: "file" | "dir" } | undefined>;

export interface Executable {
  /** The loader compiles asynchronously (normally in a compiler worker). Never instantiate here. */
  module: WebAssembly.Module | (() => WebAssembly.Module | Promise<WebAssembly.Module>);
  /** Opaque guest adapter key, interpreted by the host's worker launcher, not the registry. */
  adapter: string;
  /** True only when admission injected interruption imports. Trusted cooperative modules omit it. */
  readonly interruptible?: boolean;
}
export interface ResolvedExecutable {
  readonly module: WebAssembly.Module;
  readonly adapter: string;
  readonly interruptible: boolean;
}
export class ExecutableNotFound extends Error {
  readonly code = "ENOENT";
  constructor(name: string) {
    super(`executable not found: ${name}`);
    this.name = "ExecutableNotFound";
  }
}
export class ExecutableNotRunnable extends Error {
  constructor(
    name: string,
    directory: boolean,
    readonly code: "EACCES" | "ENOTDIR" = "EACCES",
  ) {
    super(
      code === "ENOTDIR"
        ? `not a directory in executable path: ${name}`
        : directory
          ? `cannot execute directory: ${name}`
          : `file is not a registered executable: ${name}`,
    );
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
    if (!name || !executable.adapter)
      throw new TypeError("executable and adapter names are required");
    this.entries.set(
      name,
      Object.freeze({ ...executable, interruptible: executable.interruptible ?? false }),
    );
  }
  unregister(name: string): boolean {
    return this.entries.delete(name);
  }
  has(name: string): boolean {
    return this.entries.has(name);
  }
  /** Validate live metadata and registration without loading or compiling a module. */
  async check(
    name: string,
    cwd = "/",
    assertActive: () => void = () => {},
  ): Promise<Readonly<Required<Executable>>> {
    assertActive();
    if (!name) throw new ExecutableNotFound(name);
    const absolute = name.startsWith("/") ? name : `${cwd}/${name}`;
    // Predict the key only to snapshot its exact registration before yielding. The
    // filesystem must still walk the original path; lexical cancellation is not admission.
    let path = this.lookup ? normalize(absolute) : name;
    const admitted = { path, entry: this.entries.get(path) };
    if (this.lookup) {
      let file;
      try {
        file = await this.lookup(absolute);
      } catch (error) {
        assertActive();
        const errno =
          error !== null && typeof error === "object" && "errno" in error ? error.errno : undefined;
        if (errno === 44) throw new ExecutableNotFound(absolute);
        if (errno === 54) throw new ExecutableNotRunnable(absolute, false, "ENOTDIR");
        throw error;
      }
      assertActive();
      if (!file) throw new ExecutableNotFound(absolute);
      path = file.path;
      if (file.kind !== "file" || path !== admitted.path || !admitted.entry)
        throw new ExecutableNotRunnable(path, file.kind === "dir");
    }
    const entry = admitted.entry;
    if (!entry) throw new ExecutableNotFound(path);
    return entry;
  }
  async resolve(
    name: string,
    cwd = "/",
    assertActive: () => void = () => {},
  ): Promise<ResolvedExecutable> {
    const entry = await this.check(name, cwd, assertActive);
    assertActive();
    let pending = this.modules.get(entry.module);
    if (!pending) {
      let complete!: (module: WebAssembly.Module | PromiseLike<WebAssembly.Module>) => void;
      let reject!: (error: unknown) => void;
      pending = new Promise<WebAssembly.Module>((yes, no) => {
        complete = yes;
        reject = no;
      });
      // Publish before invoking a loader that can reenter. Invoke on this same stack,
      // so cancellation cannot slip between the liveness check and starting new work.
      this.modules.set(entry.module, pending);
      try {
        const loaded = typeof entry.module === "function" ? entry.module() : entry.module;
        complete(
          Promise.resolve(loaded).then((module) => {
            if (!(module instanceof WebAssembly.Module))
              throw new TypeError("executable loader did not return a compiled WebAssembly.Module");
            return module;
          }),
        );
      } catch (error) {
        reject(error);
      }
    }
    let module: WebAssembly.Module;
    try {
      module = await pending;
    } catch (error) {
      if (error instanceof WebAssembly.CompileError)
        throw new ExecutableFormatError(error.message, { cause: error });
      throw error;
    }
    assertActive();
    return { module, adapter: entry.adapter, interruptible: entry.interruptible };
  }
}
