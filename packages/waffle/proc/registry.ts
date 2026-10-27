import { objectFreeze } from "./intrinsics.ts";
import { ExecutableFormatError } from "./start-failure.js";
import { dirname, normalize } from "../core/path.js";

/** Metadata admission is separate from bounded script-prefix reads; neither owns a filesystem. */
export type ExecutableLookup = (
  path: string,
) =>
  | { readonly path: string; readonly kind: "file" | "dir" | "symlink" }
  | undefined
  | Promise<{ readonly path: string; readonly kind: "file" | "dir" | "symlink" } | undefined>;
export type ExecutableRead = (
  path: string,
) => Uint8Array | undefined | Promise<Uint8Array | undefined>;

const MAX_SHEBANG_DEPTH = 4;
const MAX_SHEBANG_BYTES = 256;
const MAX_SYMLINK_EXPANSIONS = 40;

function symlinkTarget(file: { readonly kind: "file" | "dir" | "symlink" }): string | undefined {
  if (file.kind !== "symlink" || !("target" in file) || typeof file.target !== "string") return;
  return file.target;
}

function symlinkExpansionBlocked(
  path: string,
  seen: ReadonlySet<string>,
  expansions: number,
): boolean {
  return seen.has(path) || expansions >= MAX_SYMLINK_EXPANSIONS;
}

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
  readonly argv?: readonly string[];
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
    readonly code: "EACCES" | "ENOTDIR" | "ELOOP" = "EACCES",
  ) {
    super(
      code === "ENOTDIR"
        ? `not a directory in executable path: ${name}`
        : code === "ELOOP"
          ? `too many interpreter levels: ${name}`
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
  constructor(
    private readonly lookup?: ExecutableLookup,
    private readonly read?: ExecutableRead,
  ) {}
  register(name: string, executable: Executable): void {
    if (!name || !executable.adapter)
      throw new TypeError("executable and adapter names are required");
    this.entries.set(
      name,
      objectFreeze({ ...executable, interruptible: executable.interruptible ?? false }),
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
    return (await this.admit(name, cwd, assertActive, undefined, "access")).entry;
  }
  async resolve(
    name: string,
    cwd = "/",
    assertActive: () => void = () => {},
    argv?: readonly string[],
  ): Promise<ResolvedExecutable> {
    const admitted = await this.admit(name, cwd, assertActive, argv, "execute");
    const entry = admitted.entry;
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
      if (this.modules.get(entry.module) === pending) this.modules.delete(entry.module);
      if (error instanceof WebAssembly.CompileError)
        throw new ExecutableFormatError(error.message, { cause: error });
      throw error;
    }
    assertActive();
    return {
      module,
      adapter: entry.adapter,
      interruptible: entry.interruptible,
      ...(admitted.argv ? { argv: admitted.argv } : {}),
    };
  }

  private async admit(
    name: string,
    cwd: string,
    assertActive: () => void,
    argv: readonly string[] | undefined,
    mode: "access" | "execute",
  ): Promise<{
    readonly entry: Readonly<Required<Executable>>;
    readonly argv?: readonly string[];
  }> {
    const seen = new Set<string>();
    return this.admitScript(name, cwd, assertActive, argv, mode, 0, seen, 0);
  }

  private async admitScript(
    name: string,
    cwd: string,
    assertActive: () => void,
    argv: readonly string[] | undefined,
    mode: "access" | "execute",
    depth: number,
    seen: Set<string>,
    symlinks: number,
    scriptName = name,
  ): Promise<{
    readonly entry: Readonly<Required<Executable>>;
    readonly argv?: readonly string[];
  }> {
    assertActive();
    if (!name) throw new ExecutableNotFound(name);
    const absolute = name.startsWith("/") ? name : `${cwd}/${name}`;
    // Predict the key only to snapshot its exact registration before yielding. The
    // filesystem must still walk the original path; lexical cancellation is not admission.
    const predicted = this.lookup ? normalize(absolute) : name;
    const registered = this.entries.get(predicted);
    if (!this.lookup) {
      if (!registered) throw new ExecutableNotFound(name);
      return { entry: registered, ...(argv ? { argv } : {}) };
    }
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
    if (file.kind === "dir") throw new ExecutableNotRunnable(file.path, true);
    const target = symlinkTarget(file);
    if (target) {
      if (symlinkExpansionBlocked(file.path, seen, symlinks))
        throw new ExecutableNotRunnable(file.path, false, "ELOOP");
      seen.add(file.path);
      return this.admitScript(
        target.startsWith("/") ? target : `${dirname(file.path)}/${target}`,
        cwd,
        assertActive,
        argv,
        mode,
        depth,
        seen,
        symlinks + 1,
        scriptName,
      );
    }
    const resolved = file.path === predicted ? registered : this.entries.get(file.path);
    if (resolved && file.kind === "file") return { entry: resolved, ...(argv ? { argv } : {}) };
    if (!this.read) throw this.notRunnable(file.path, mode);
    if (seen.has(file.path) || depth >= MAX_SHEBANG_DEPTH)
      throw new ExecutableNotRunnable(file.path, false, "ELOOP");
    seen.add(file.path);
    const bytes = await this.read(absolute);
    assertActive();
    if (!bytes) throw new ExecutableNotFound(absolute);
    const shebang = parseShebang(bytes);
    if (!shebang) throw this.notRunnable(file.path, mode, true);
    const nextArgv = argv
      ? shebang.argument
        ? [shebang.interpreter, shebang.argument, scriptName].concat(argv.slice(1))
        : [shebang.interpreter, scriptName].concat(argv.slice(1))
      : undefined;
    return this.admitScript(
      shebang.interpreter,
      cwd,
      assertActive,
      nextArgv,
      mode,
      depth + 1,
      seen,
      symlinks,
    );
  }

  private notRunnable(path: string, mode: "access" | "execute", invalid = false): Error {
    if (mode === "access") return new ExecutableNotRunnable(path, false);
    return invalid
      ? new ExecutableFormatError(`invalid executable: ${path}`)
      : new ExecutableNotRunnable(path, false);
  }
}

interface Shebang {
  readonly interpreter: string;
  readonly argument?: string;
}

function parseShebang(bytes: Uint8Array): Shebang | undefined {
  if (bytes.length < 2 || bytes[0] !== 35 || bytes[1] !== 33) return;
  const end = bytes.indexOf(10, 2);
  if (end < 0 && bytes.length - 2 > MAX_SHEBANG_BYTES) return;
  if (end >= 0 && end - 2 > MAX_SHEBANG_BYTES) return;
  const lineEnd = end < 0 ? Math.min(bytes.length, MAX_SHEBANG_BYTES) : end;
  let line: string;
  try {
    line = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(2, lineEnd));
  } catch {
    return;
  }
  const match = /^[ \t]*([^ \t]+)(?:[ \t]+([\s\S]*))?$/.exec(line.replace(/[ \t]+$/, ""));
  if (!match) return;
  const interpreter = match[1];
  if (!interpreter) return;
  return match[2] === undefined
    ? { interpreter }
    : { interpreter, argument: match[2] || undefined };
}
