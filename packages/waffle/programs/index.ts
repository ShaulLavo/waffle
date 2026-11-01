// Install program packages (coreutils, sed, python, ...) on a page Runtime. Installing writes one
// small marker file per path and registers it; nothing is fetched, prepared or compiled until
// the first exec.
import type { GuestLauncher, Runtime, ProgramLoadState } from "../runtime.js";
import { packageIdentity } from "./catalog.js";
import type { HostCommandDefinition } from "../proc/command.js";
import type { RegisteredCommand } from "../proc/registry.js";
import type { ProcessHandle } from "../proc/types.js";

/** One program package: its WASI programs and the absolute paths they are installed at. */
export interface ProgramPackage {
  /** Package name, recorded in each marker file, for example "coreutils". */
  readonly name: string;
  readonly programs: readonly PackageProgram[];
  /** Aggregate membership retains the original families and their payload ownership. */
  readonly packages?: readonly ProgramPackage[];
  /** Release what the package prepared itself, such as a standard library on the filesystem.
   * Runs once per installation, after its markers are gone and every process that loaded or
   * launched one of its programs has physically stopped. */
  readonly dispose?: () => Promise<void>;
}

export interface SignalDelegation {
  readonly packages: readonly ProgramPackage[];
}

export type ProgramLaunch = (
  context: Parameters<GuestLauncher>[0],
  service: Parameters<GuestLauncher>[1],
  fallback: GuestLauncher,
) => ReturnType<GuestLauncher>;

export { defineProgramPackage, type ProgramCatalog } from "./catalog.js";
export type {
  ProgramHandle,
  ProgramMode,
  ProgramState,
  RuntimePrograms,
  ProgramsOptions,
} from "./collection.js";

export type PackageProgram = {
  /** Canonical absolute path, for example /usr/bin/ls. */
  readonly path: string;
  /** More absolute paths that run the same program, for example /bin/ls. */
  readonly aliases?: readonly string[];
  /** Replaces only argv[0] at launch; the rest of argv, env, cwd and descriptors pass through. */
  readonly argv0?: string;
} & (
  | {
      /** The program's WASI preview1 module, fetched on first exec. Write it as
       * `new URL("./ls.wasm", import.meta.url)` so bundlers emit the asset. */
      readonly launch?: ProgramLaunch;
      readonly command?: never;
      readonly wasm: URL;
      readonly source?: never;
      readonly script?: never;
    }
  | {
      /** Called on first exec, not at install, and again only after a failure. It may prepare
       * files the program needs before returning its Wasm bytes. */
      readonly launch?: ProgramLaunch;
      readonly command?: never;
      readonly source: () => Promise<Uint8Array>;
      readonly wasm?: never;
      readonly script?: never;
    }
  | {
      readonly launch?: ProgramLaunch;
      readonly command?: never;
      readonly script: { readonly interpreter: string; readonly source: () => Promise<string> };
      readonly wasm?: never;
      readonly source?: never;
    }
  | {
      readonly command: HostCommandDefinition;
      readonly wasm?: never;
      readonly source?: never;
      readonly script?: never;
      readonly launch?: never;
    }
);

export interface InstallProgramsOptions {
  /** Cancels new loads and launches immediately, including while marker writes are pending. */
  readonly signal?: AbortSignal;
  /** Starts a process for each exec, for example a launcher using Waffle's preview1 worker.
   * The installation registers its own adapters around it. */
  readonly launcher: GuestLauncher;
  readonly onLoad?: (program: PackageProgram, state: ProgramLoadState) => void;
  readonly launchInterpreter?: (
    interpreter: string,
    context: Parameters<GuestLauncher>[0],
    service: Parameters<GuestLauncher>[1],
  ) => ReturnType<GuestLauncher>;
}

export interface ProgramInstallation {
  /** Directories holding the installed programs, in manifest order. Put these on PATH. */
  readonly path: readonly string[];
  /** Every installed executable path, canonical paths and aliases. */
  readonly executables: readonly string[];
  /** Uninstall. New execs fail at once: markers are removed and new loads refused. It then waits
   * for running processes of these programs to stop (it doesn't stop them), runs each package's
   * dispose hook, and only then releases the paths, so a reinstall can't race the cleanup.
   * Runtime.dispose stops the processes but doesn't run package hooks. */
  dispose(): Promise<void>;
}

export class ProgramConflictError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Cannot install program at ${path}: ${reason}`);
    this.name = "ProgramConflictError";
  }
}

interface Entry {
  readonly path: string;
  marker: Uint8Array;
  readonly program: PackageProgram;
  readonly source: (() => Promise<Uint8Array>) | undefined;
  readonly command: RegisteredCommand | undefined;
  readonly argv0: string | undefined;
  readonly launch: ProgramLaunch | undefined;
}

interface Installed {
  readonly runtime: Runtime;
  readonly packages: readonly ProgramPackage[];
  readonly activity: Activity;
  readonly admission: AbortController;
  readonly leases: Array<() => void>;
  readonly created: Entry[];
}

/** Loads and launched processes of one installation, and the fence that waits them out. */
class Activity {
  closing = false;
  fenced = false;
  private active = 0;
  private failure: { readonly error: unknown } | undefined;
  private readonly idle: Array<() => void> = [];

  enter(): () => void {
    this.active++;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      if (--this.active === 0) for (const resolve of this.idle.splice(0)) resolve();
    };
  }

  fail(error: unknown): never {
    this.failure ??= { error };
    for (const resolve of this.idle.splice(0)) resolve();
    throw error;
  }

  async fence(): Promise<void> {
    while (this.active && !this.failure)
      await new Promise<void>((resolve) => this.idle.push(resolve));
    if (this.failure) throw this.failure.error;
    this.fenced = true;
  }
}

const encoder = new TextEncoder();
let installs = 0;

/** Install every program of the given packages. Fails before any change when two programs
 * claim one path; rolls back fully when a path is taken or a filesystem write fails. */
export async function installPrograms(
  runtime: Runtime,
  packages: readonly ProgramPackage[],
  options: InstallProgramsOptions,
): Promise<ProgramInstallation> {
  if (runtime.disposed) throw new Error("Runtime is disposed");
  const activity = new Activity();
  const admission = new AbortController();
  const entries = programEntries(packages, activity, { ...options, signal: admission.signal });
  const installed: Installed = { runtime, packages, activity, admission, leases: [], created: [] };
  const signal = options.signal;
  if (signal?.aborted) throw new Error("Program installation was cancelled");
  if (signal) {
    const close = () => {
      activity.closing = true;
      admission.abort();
    };
    signal.addEventListener("abort", close, { once: true });
    installed.leases.push(() => signal.removeEventListener("abort", close));
  }
  try {
    const adapters = registerAdapters(installed, entries, options);
    const preparations = new Map<PackageProgram, () => Promise<void>>();
    const observations = new Map<PackageProgram, (state: ProgramLoadState) => void>();
    for (const entry of entries) {
      const onLoad =
        observations.get(entry.program) ?? observeLoad(entry.program, activity, options.onLoad);
      observations.set(entry.program, onLoad);
      if (entry.command) {
        installed.leases.push(
          runtime.registerProgram(entry.path, { command: entry.command, onLoad }),
        );
        continue;
      }
      const adapter = adapters.get(entry.launch)!.get(entry.argv0)!;
      const script = entry.program.script;
      const definition = script
        ? {
            adapter,
            script: {
              interpreter: script.interpreter,
              prepare: scriptPreparation(
                runtime,
                entry,
                entries,
                installed.created,
                activity,
                preparations,
              ),
            },
            onLoad,
          }
        : { adapter, source: entry.source!, onLoad };
      installed.leases.push(runtime.registerProgram(entry.path, definition));
    }
    await provision(runtime, entries, installed.created);
  } catch (error) {
    return rollback(installed, error);
  }
  let disposal: Promise<void> | undefined;
  return {
    path: Array.from(new Set(entries.map((entry) => parentDirectory(entry.path)))),
    executables: entries.map((entry) => entry.path),
    dispose() {
      disposal ??= uninstall(installed).then((errors) => {
        if (errors.length) throw new AggregateError(errors, "Program uninstall failed");
      });
      return disposal;
    },
  };
}

function programEntries(
  packages: readonly ProgramPackage[],
  activity: Activity,
  options: InstallProgramsOptions,
): Entry[] {
  const entries = packages.flatMap((pkg) =>
    pkg.programs.flatMap((program) => programPaths(pkg, program, activity, options)),
  );
  const claimed = new Set<string>();
  for (const { path } of entries) {
    if (claimed.has(path))
      throw new ProgramConflictError(path, "two programs in this install claim it");
    claimed.add(path);
  }
  return entries;
}

function programPaths(
  pkg: ProgramPackage,
  program: PackageProgram,
  activity: Activity,
  options: InstallProgramsOptions,
): Entry[] {
  if (program.argv0 !== undefined && typeof program.argv0 !== "string")
    throw new TypeError(`Program ${program.path} argv0 must be a string`);
  const source =
    program.script || program.command ? undefined : trackedSource(programLoader(program), activity);
  const marker = encoder.encode(`waffle program: ${pkg.name} ${program.path}\n`);
  const command = program.command
    ? trackedCommand(
        program.command,
        packageIdentity(pkg),
        activity,
        options.signal,
        marker,
        program.argv0,
      )
    : undefined;
  const argv0 = program.argv0;
  const launch = program.script ? scriptLaunch(program, options) : program.launch;
  return [program.path]
    .concat(program.aliases ?? [])
    .map((path) => ({ path, marker, source, command, argv0, launch, program }));
}

function programLoader(program: PackageProgram): () => Promise<Uint8Array> {
  if (program.wasm instanceof URL) return fetchWasm(new URL(program.wasm.href));
  if (program.wasm === undefined && typeof program.source === "function") return program.source;
  throw new TypeError(`Program ${program.path} must give its wasm as a URL or a source loader`);
}

// The registry shares concurrent loads and retries after a failure; this only owns the fetch.
function fetchWasm(url: URL): () => Promise<Uint8Array> {
  return async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Program fetch failed: ${url.href} (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  };
}

// One function per program, shared by its aliases, so the runtime compiles it once.
function trackedSource(load: () => Promise<Uint8Array>, activity: Activity) {
  return async () => {
    if (activity.closing) throw new Error("Program is being uninstalled");
    const leave = activity.enter();
    try {
      return await load();
    } finally {
      leave();
    }
  };
}

function trackedCommand(
  definition: HostCommandDefinition,
  owner: object,
  activity: Activity,
  admission: AbortSignal | undefined,
  marker: Uint8Array,
  argv0: string | undefined,
): RegisteredCommand {
  if (typeof definition.load !== "function") throw new TypeError("Command loader is required");
  return {
    owner,
    signals: definition.signals,
    admission,
    marker,
    retain: () => {
      if (activity.closing || activity.fenced) throw new Error("Program was uninstalled");
      return activity.enter();
    },
    load: async () => {
      if (activity.closing) throw new Error("Program is being uninstalled");
      const run = await definition.load();
      if (typeof run !== "function") throw new TypeError("Command loader must return a function");
      if (argv0 === undefined) return run;
      return (context) =>
        run(
          Object.freeze({
            ...context,
            request: Object.freeze({
              ...context.request,
              argv: Object.freeze([argv0].concat(context.request.argv.slice(1))),
            }),
          }),
        );
    },
  };
}

function registerAdapters(
  installed: Installed,
  entries: readonly Entry[],
  options: InstallProgramsOptions,
) {
  const launch = options.launcher;
  if (typeof launch !== "function") throw new TypeError("Program launcher is required");
  const install = ++installs;
  const adapters = new Map<ProgramLaunch | undefined, Map<string | undefined, string>>();
  let serial = 0;
  for (const { argv0, launch: hook, command } of entries) {
    if (command) continue;
    let group = adapters.get(hook);
    if (!group) adapters.set(hook, (group = new Map()));
    if (group.has(argv0)) continue;
    const name = `waffle:programs:${install}:${serial++}`;
    const launcher = trackedLauncher(launch, argv0, installed.activity, hook);
    installed.leases.push(installed.runtime.registerAdapter(name, launcher));
    group.set(argv0, name);
  }
  return adapters;
}

function trackedLauncher(
  launch: GuestLauncher,
  argv0: string | undefined,
  activity: Activity,
  hook: ProgramLaunch | undefined,
): GuestLauncher {
  return async (context, service) => {
    if (activity.closing || activity.fenced) throw new Error("Program was uninstalled");
    const leave = activity.enter();
    let handle: ProcessHandle;
    try {
      const argv = argv0 === undefined ? undefined : [argv0].concat(context.request.argv.slice(1));
      const launched = argv ? { ...context, request: { ...context.request, argv } } : context;
      handle = await (hook ? hook(launched, service, launch) : launch(launched, service));
      if (!handle || typeof handle.terminate !== "function")
        throw new TypeError("Program launcher must return a process handle");
    } catch (error) {
      leave();
      throw error;
    }
    let stopping: Promise<void> | undefined;
    // The supervisor terminates every handle after the process's outcome is safe; that
    // physical stop, not the exit status, ends this process's hold on the package.
    return {
      terminate: () =>
        (stopping ??= Promise.resolve()
          .then(() => handle.terminate())
          .then(leave, (error: unknown) => activity.fail(error))),
    };
  };
}

async function provision(runtime: Runtime, entries: readonly Entry[], created: Entry[]) {
  const directories = new Set<string>();
  for (const entry of entries) {
    const existing = await runtime.filesystem.lookup(entry.path);
    if (existing) {
      // A matching marker survives from an earlier page on persistent storage. Reuse it,
      // but it never becomes this installation's to remove.
      if (existing.kind === "file" && (await isMarker(runtime, entry))) continue;
      throw new ProgramConflictError(entry.path, "another entry already exists");
    }
    const directory = parentDirectory(entry.path);
    if (!directories.has(directory)) await runtime.filesystem.mkdirp(directory);
    directories.add(directory);
    await runtime.filesystem.writeFile(entry.path, entry.marker, { exclusive: true });
    created.push(entry);
  }
}

async function isMarker(runtime: Runtime, entry: Entry): Promise<boolean> {
  const bytes = await runtime.filesystem.readFile(entry.path);
  return bytes?.length === entry.marker.length && bytes.every((b, i) => b === entry.marker[i]);
}

// The filesystem compares and removes in one step, so a file replaced after the marker was
// written survives.
async function removeMarker(runtime: Runtime, entry: Entry): Promise<void> {
  if (runtime.disposed) return;
  await runtime.filesystem.remove(entry.path, { ifContent: entry.marker });
}

/** Shared by rollback and dispose. Paths stay registered until every step has finished. */
async function uninstall(installed: Installed): Promise<unknown[]> {
  const { runtime, activity } = installed;
  const errors: unknown[] = [];
  const collect = (failure: unknown) => {
    errors.push(failure);
  };
  activity.closing = true;
  installed.admission.abort();
  if (!runtime.disposed) {
    // Consume a failed install write's queued error before reading the tree back.
    await runtime.filesystem.drain().catch(collect);
    for (const entry of installed.created.toReversed())
      await removeMarker(runtime, entry).catch(collect);
    await runtime.filesystem.drain().catch(collect);
  }
  await activity.fence();
  for (const { dispose } of installed.packages) {
    if (dispose) await Promise.resolve().then(dispose).catch(collect);
  }
  for (const lease of installed.leases.splice(0).toReversed()) {
    try {
      lease();
    } catch (failure) {
      collect(failure);
    }
  }
  return errors;
}

async function rollback(installed: Installed, error: unknown): Promise<never> {
  const errors = [error].concat((await uninstall(installed)).filter((other) => other !== error));
  if (errors.length > 1) throw new AggregateError(errors, "Program install rollback failed");
  throw error;
}

function parentDirectory(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function scriptLaunch(program: PackageProgram, options: InstallProgramsOptions): ProgramLaunch {
  const script = program.script;
  const launchInterpreter = options.launchInterpreter;
  if (!script || !launchInterpreter)
    throw new TypeError("Script programs require an interpreter launcher");
  return (context, service) => {
    const fallback: GuestLauncher = (next, host) =>
      launchInterpreter(script.interpreter, next, host);
    return program.launch ? program.launch(context, service, fallback) : fallback(context, service);
  };
}

function trackedScript(
  runtime: Runtime,
  entries: readonly Entry[],
  created: Entry[],
  activity: Activity,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (activity.closing) return Promise.reject(new Error("Program is being uninstalled"));
    pending ??= prepareScript(runtime, entries, created, activity).catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

async function prepareScript(
  runtime: Runtime,
  entries: readonly Entry[],
  created: Entry[],
  activity: Activity,
): Promise<void> {
  const script = entries[0]?.program.script;
  if (!script) throw new TypeError("Expected script program");
  const leave = activity.enter();
  try {
    const text = await script.source();
    if (typeof text !== "string") throw new TypeError("Script source loader must return text");
    if (activity.closing) throw new Error("Program is being uninstalled");
    const bytes = encoder.encode(`#!${script.interpreter}\n${text}`);
    for (const entry of entries) await writeScript(runtime, entry, bytes, created, activity);
  } finally {
    leave();
  }
}

async function writeScript(
  runtime: Runtime,
  entry: Entry,
  bytes: Uint8Array,
  created: Entry[],
  activity: Activity,
): Promise<void> {
  if (activity.closing) throw new Error("Program is being uninstalled");
  if (!(await runtime.filesystem.remove(entry.path, { ifContent: entry.marker })))
    throw new ProgramConflictError(entry.path, "script marker was replaced");
  if (activity.closing) throw new Error("Program is being uninstalled");
  await runtime.filesystem.writeFile(entry.path, bytes, { exclusive: true });
  entry.marker = bytes;
  if (!created.includes(entry)) created.push(entry);
}

function observeLoad(
  program: PackageProgram,
  activity: Activity,
  observe: InstallProgramsOptions["onLoad"],
): (state: ProgramLoadState) => void {
  let leave: (() => void) | undefined;
  return (state) => {
    if (state.kind === "preparing") leave ??= activity.enter();
    if (state.kind === "loaded" || state.kind === "error") {
      leave?.();
      leave = undefined;
    }
    observe?.(program, state);
    if (state.kind === "loaded" && activity.closing)
      throw new Error("Program is being uninstalled");
  };
}

function scriptPreparation(
  runtime: Runtime,
  entry: Entry,
  entries: readonly Entry[],
  created: Entry[],
  activity: Activity,
  preparations: Map<PackageProgram, () => Promise<void>>,
): () => Promise<void> {
  const existing = preparations.get(entry.program);
  if (existing) return existing;
  const prepare = trackedScript(
    runtime,
    entries.filter((other) => other.program === entry.program),
    created,
    activity,
  );
  preparations.set(entry.program, prepare);
  return prepare;
}
