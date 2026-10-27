// Install program packages (coreutils, sed, ...) on a page Runtime. Installing writes one small
// marker file per path and registers it; nothing is fetched or compiled until the first exec.
import type { Runtime } from "../runtime.js";

/** One program package: its WASI programs and the absolute paths they are installed at. */
export interface ProgramPackage {
  /** Package name, recorded in each marker file, for example "coreutils". */
  readonly name: string;
  readonly programs: readonly PackageProgram[];
}

export interface PackageProgram {
  /** Canonical absolute path, for example /usr/bin/ls. */
  readonly path: string;
  /** More absolute paths that run the same program, for example /bin/ls. */
  readonly aliases?: readonly string[];
  /** The program's WASI preview1 module, fetched and compiled on first exec only.
   * Write it as `new URL("./ls.wasm", import.meta.url)` so bundlers emit the asset. */
  readonly wasm: URL;
}

export interface InstallProgramsOptions {
  /** A launcher the caller registered with `runtime.registerAdapter`. */
  readonly adapter: string;
}

export interface ProgramInstallation {
  /** Directories holding the installed programs, in manifest order. Put these on PATH. */
  readonly path: readonly string[];
  /** Every installed executable path, canonical paths and aliases. */
  readonly executables: readonly string[];
  /** Unregister every path, then remove the marker files this installation created that are
   * still unchanged. Call once its processes have stopped; Runtime.dispose also releases it. */
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
  readonly marker: Uint8Array;
  readonly source: () => Promise<Uint8Array>;
}

const encoder = new TextEncoder();

/** Install every program of the given packages. Fails before any change when two programs
 * claim one path; rolls back fully when a path is taken or a filesystem write fails. */
export async function installPrograms(
  runtime: Runtime,
  packages: readonly ProgramPackage[],
  options: InstallProgramsOptions,
): Promise<ProgramInstallation> {
  if (runtime.disposed) throw new Error("Runtime is disposed");
  const entries = programEntries(packages);
  const releases: Array<() => void> = [];
  const created: Entry[] = [];
  const release = () => {
    for (const unregister of releases.splice(0).toReversed()) unregister();
  };
  try {
    for (const entry of entries)
      releases.push(
        runtime.registerProgram(entry.path, { adapter: options.adapter, source: entry.source }),
      );
    await provision(runtime, entries, created);
  } catch (error) {
    return rollback(runtime, created, release, error);
  }
  let disposal: Promise<void> | undefined;
  return {
    path: Array.from(new Set(entries.map((entry) => parentDirectory(entry.path)))),
    executables: entries.map((entry) => entry.path),
    dispose() {
      disposal ??= dispose(runtime, created, release);
      return disposal;
    },
  };
}

function programEntries(packages: readonly ProgramPackage[]): Entry[] {
  const entries = packages.flatMap(({ name, programs }) =>
    programs.flatMap((program) => programPaths(name, program)),
  );
  const claimed = new Set<string>();
  for (const { path } of entries) {
    if (claimed.has(path))
      throw new ProgramConflictError(path, "two programs in this install claim it");
    claimed.add(path);
  }
  return entries;
}

function programPaths(name: string, program: PackageProgram): Entry[] {
  if (!(program.wasm instanceof URL))
    throw new TypeError(`Program ${program.path} must give its wasm as a URL`);
  const source = fetchWasm(new URL(program.wasm.href));
  const marker = encoder.encode(`waffle program: ${name} ${program.path}\n`);
  return [program.path].concat(program.aliases ?? []).map((path) => ({ path, marker, source }));
}

// The registry shares concurrent loads and retries after a failure; this only owns the fetch.
function fetchWasm(url: URL): () => Promise<Uint8Array> {
  return async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Program fetch failed: ${url.href} (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
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

async function removeMarker(runtime: Runtime, entry: Entry): Promise<void> {
  if (runtime.disposed) return;
  if ((await runtime.filesystem.lookup(entry.path))?.kind !== "file") return;
  if (await isMarker(runtime, entry)) await runtime.filesystem.remove(entry.path);
}

async function rollback(
  runtime: Runtime,
  created: readonly Entry[],
  release: () => void,
  error: unknown,
): Promise<never> {
  const errors = [error];
  const collect = (failure: unknown) => {
    if (!errors.includes(failure)) errors.push(failure);
  };
  try {
    release();
  } catch (failure) {
    collect(failure);
  }
  if (!runtime.disposed) {
    // Consume the failed write's queued error before reading the tree back.
    await runtime.filesystem.drain().catch(collect);
    for (const entry of created.toReversed()) await removeMarker(runtime, entry).catch(collect);
    await runtime.filesystem.drain().catch(collect);
  }
  if (errors.length > 1) throw new AggregateError(errors, "Program install rollback failed");
  throw error;
}

async function dispose(runtime: Runtime, created: readonly Entry[], release: () => void) {
  release();
  const results = await Promise.allSettled(created.map((entry) => removeMarker(runtime, entry)));
  if (!runtime.disposed) results.push((await Promise.allSettled([runtime.filesystem.drain()]))[0]!);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Program uninstall failed");
}

function parentDirectory(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}
