import { FilesystemError } from "./protocol.js";
import { storeIdentity } from "./file-identity.js";
import {
  encodeWorkspaceArchive,
  WORKSPACE_ARCHIVE_LIMITS,
  WorkspaceArchiveError,
  type ArchiveOptions,
  type ArchiveSourceEntry,
} from "./workspace-archive.js";
import {
  WORKSPACE_LIMITS,
  type NamespaceCut,
  type NamespaceEntry,
  type ReadFailure,
  type SnapshotPage,
  type SnapshotCursor,
  type VersionLease,
  type VersionStat,
  type WorkspaceVfs,
} from "./workspace-types.js";

export type WorkspaceExportOptions = ArchiveOptions;

export const WORKSPACE_EXPORT_LIMITS = Object.freeze({
  scanPages: WORKSPACE_LIMITS.indexEdges + 2,
  chunkBytes: WORKSPACE_ARCHIVE_LIMITS.chunkBytes,
  windowEntries: 128,
  windowMetadataBytes: 64 * 1024,
});
type SnapshotFailure = Exclude<SnapshotPage, { kind: "entries" | "complete" }>;
export type ExportRefusal =
  | SnapshotFailure
  | ReadFailure
  | { readonly kind: "resnapshot"; readonly expected: NamespaceCut; readonly current: NamespaceCut }
  | { readonly kind: "contract"; readonly detail: string }
  | { readonly kind: "format-path"; readonly path: string }
  | { readonly kind: "scan-limit" };
export class WorkspaceExportError extends Error {
  constructor(readonly refusal: ExportRefusal) {
    super(`Workspace export refused: ${refusal.kind}`);
    this.name = "WorkspaceExportError";
  }
}
interface Failure {
  readonly error: unknown;
}
function refuse(refusal: ExportRefusal): never {
  throw new WorkspaceExportError(refusal);
}
function contract(detail: string): never {
  return refuse({ kind: "contract", detail });
}
function checkSignal(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
function sameCut(first: NamespaceCut, second: NamespaceCut): boolean {
  return (
    first.workspace === second.workspace &&
    first.generation === second.generation &&
    first.watermark.history === second.watermark.history &&
    first.watermark.seq === second.watermark.seq
  );
}
function requireCut(expected: NamespaceCut, current: NamespaceCut): void {
  if (!sameCut(expected, current)) refuse({ kind: "resnapshot", expected, current });
}

/** Abort starts closure, but the original operation is always awaited before finish returns. */
class ExportScope {
  private closing: Promise<Failure | undefined> | undefined;
  private readonly abort = () => {
    this.startClose();
  };
  constructor(
    private readonly closeResource: () => Promise<void>,
    private readonly signal?: AbortSignal,
  ) {
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.startClose();
  }
  private startClose(): Promise<Failure | undefined> {
    this.closing ??= Promise.resolve()
      .then(this.closeResource)
      .then(
        () => undefined,
        (error: unknown) => ({ error }),
      );
    return this.closing;
  }
  async wait<T>(start: () => Promise<T>): Promise<{ readonly then: undefined; readonly value: T }> {
    checkSignal(this.signal);
    try {
      const result = await start();
      checkSignal(this.signal);
      // oxlint-disable-next-line unicorn/no-thenable -- Own undefined then prevents a second observation of result.
      return { then: undefined, value: result };
    } catch (error) {
      checkSignal(this.signal);
      throw error;
    }
  }
  async finish(failure?: Failure): Promise<void> {
    this.signal?.removeEventListener("abort", this.abort);
    const cleanup = await this.startClose();
    if (!cleanup) return;
    if (!failure) throw cleanup.error;
    throw new AggregateError([failure.error, cleanup.error], "Workspace export cleanup failed");
  }
}
function pathParts(path: string): string[] {
  if (
    path.length > WORKSPACE_ARCHIVE_LIMITS.pathUnits ||
    !path.startsWith("/") ||
    path.includes("\0")
  )
    contract("Invalid snapshot path");
  if (path === "/") return [];
  const parts = path.slice(1).split("/");
  if (
    parts.length > WORKSPACE_ARCHIVE_LIMITS.depth ||
    parts.some((part) => !part || part === "." || part === "..")
  )
    contract("Invalid snapshot path components");
  if (/[\\\uD800-\uDFFF]/u.test(path)) refuse({ kind: "format-path", path });
  return parts;
}
function compare(first: readonly string[], second: readonly string[]): number {
  const length = Math.min(first.length, second.length);
  for (let index = 0; index < length; index++) {
    if (first[index]! < second[index]!) return -1;
    if (first[index]! > second[index]!) return 1;
  }
  return first.length - second.length;
}
interface Candidate {
  readonly entry: NamespaceEntry;
  readonly parts: string[];
  readonly charge: number;
}
class Successor {
  readonly entries: Candidate[] = [];
  private charge = 0;
  private excluded: string[] | undefined;
  private readonly after: string[] | undefined;
  constructor(previous?: string) {
    this.after = previous === undefined ? undefined : pathParts(previous);
  }
  consider(entries: readonly NamespaceEntry[]): void {
    if (entries.length > WORKSPACE_LIMITS.pageEntries) contract("Snapshot page count exceeded");
    let charge = 0;
    for (const entry of entries) {
      if (entry.kind !== "file" && entry.kind !== "directory")
        throw new WorkspaceArchiveError("INVALID", "Unsupported entry kind");
      charge += 192 + entry.path.length * 2;
      if (charge > WORKSPACE_LIMITS.pageBytes) contract("Snapshot page bytes exceeded");
      this.take(entry);
    }
  }
  private take(entry: NamespaceEntry): void {
    const parts = pathParts(entry.path);
    if (this.after && compare(parts, this.after) <= 0) return;
    if (this.excluded && compare(parts, this.excluded) >= 0) return;
    const at = this.position(parts);
    if (this.entries[at] && compare(parts, this.entries[at].parts) === 0) return;
    const charge = 256 + entry.path.length * 4 + parts.length * 32;
    this.entries.splice(at, 0, { entry: { ...entry }, parts, charge });
    this.charge += charge;
    this.trim();
  }
  private position(parts: readonly string[]): number {
    let first = 0,
      end = this.entries.length;
    while (first < end) {
      const middle = (first + end) >>> 1;
      if (compare(this.entries[middle]!.parts, parts) < 0) first = middle + 1;
      else end = middle;
    }
    return first;
  }
  private trim(): void {
    while (
      this.entries.length > WORKSPACE_EXPORT_LIMITS.windowEntries ||
      this.charge > WORKSPACE_EXPORT_LIMITS.windowMetadataBytes
    ) {
      const removed = this.entries.pop()!;
      this.charge -= removed.charge;
      // Once excluded, a path stays the window boundary even if later insertions free space.
      this.excluded = removed.parts;
    }
  }
}
async function successor(
  workspace: WorkspaceVfs,
  previous: string | undefined,
  expected: NamespaceCut | undefined,
  signal?: AbortSignal,
): Promise<{ readonly entries: Candidate[]; readonly cut: NamespaceCut }> {
  checkSignal(signal);
  const cursor = workspace.snapshot({ prefix: "/", includeDirs: true }, signal);
  const scope = new ExportScope(() => cursor.close(), signal);
  const selected = new Successor(previous);
  let failure: Failure | undefined;
  try {
    return await scan(cursor, selected, scope, expected);
  } catch (error) {
    const primary =
      !signal?.aborted && error instanceof FilesystemError && error.errno === 2
        ? new WorkspaceExportError({ kind: "denied" })
        : error;
    failure = { error: primary };
    throw primary;
  } finally {
    await scope.finish(failure);
  }
}
async function scan(
  cursor: SnapshotCursor,
  selected: Successor,
  scope: ExportScope,
  expected?: NamespaceCut,
): Promise<{ readonly entries: Candidate[]; readonly cut: NamespaceCut }> {
  for (let pages = 0; pages < WORKSPACE_EXPORT_LIMITS.scanPages; pages++) {
    const { value: page } = await scope.wait(() => cursor.next());
    if (page.kind === "entries") {
      selected.consider(page.entries);
      continue;
    }
    if (page.kind !== "complete") refuse(page);
    if (expected) requireCut(expected, page.cut);
    return { entries: selected.entries, cut: page.cut };
  }
  return refuse({ kind: "scan-limit" });
}
function requireStat(entry: NamespaceEntry, cut: NamespaceCut, stat: VersionStat): void {
  requireCut(cut, stat.cut);
  if (
    stat.id !== entry.id ||
    stat.version !== entry.version ||
    stat.kind !== entry.kind ||
    stat.size !== entry.size ||
    stat.mtime !== entry.mtime ||
    stat.mode !== entry.mode
  )
    contract("Lease metadata does not match the completed snapshot");
}
async function* fileBytes(
  lease: VersionLease,
  scope: ExportScope,
  entry: NamespaceEntry,
  cut: NamespaceCut,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < entry.size;) {
    const length = Math.min(WORKSPACE_EXPORT_LIMITS.chunkBytes, entry.size - offset);
    const { value: result } = await scope.wait(() => lease.read({ offset, length }, signal));
    if (result.kind !== "ok") refuse(result);
    requireStat(entry, cut, result.value.stat);
    const value = result.value;
    if (
      value.range.offset !== offset ||
      value.range.length !== length ||
      value.bytes.length !== length ||
      value.bytes.constructor !== Uint8Array ||
      value.bytes.byteOffset !== 0 ||
      value.bytes.buffer.byteLength !== length ||
      !(value.bytes.buffer instanceof ArrayBuffer) ||
      ("resizable" in value.bytes.buffer && value.bytes.buffer.resizable)
    )
      contract("Lease returned an invalid bounded range");
    yield value.bytes;
    offset += length;
  }
}
async function* sourceEntry(
  workspace: WorkspaceVfs,
  entry: NamespaceEntry,
  cut: NamespaceCut,
  signal?: AbortSignal,
): AsyncGenerator<ArchiveSourceEntry> {
  const metadata = {
    path: entry.path,
    kind: entry.kind,
    size: entry.size,
    mode: entry.mode,
    mtime: entry.mtime,
    sourceIdentity: storeIdentity(entry, cut.workspace),
  };
  checkSignal(signal);
  if (entry.kind === "directory") {
    yield { metadata: { ...metadata, kind: "directory" } };
    return;
  }
  const result = await workspace.pin(entry.id, entry.version, signal);
  if (result.kind !== "ok") refuse(result);
  const lease = result.value;
  const scope = new ExportScope(() => lease.close(), signal);
  let failure: Failure | undefined;
  try {
    checkSignal(signal);
    requireStat(entry, cut, lease.stat);
    yield {
      metadata: { ...metadata, kind: "file" },
      bytes: fileBytes(lease, scope, entry, cut, signal),
    };
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await scope.finish(failure);
  }
}
async function* sourceEntries(
  workspace: WorkspaceVfs,
  pending: Candidate[],
  cut: NamespaceCut,
  signal?: AbortSignal,
): AsyncGenerator<ArchiveSourceEntry> {
  let previous: string | undefined;
  while (pending.length) {
    const { entry } = pending.shift()!;
    yield* sourceEntry(workspace, entry, cut, signal);
    previous = entry.path;
    if (!pending.length) pending = (await successor(workspace, previous, cut, signal)).entries;
  }
}

/** Optimistic same-cut export. A refusal invalidates all bytes already yielded. */
export async function* exportWorkspaceArchive(
  workspace: WorkspaceVfs,
  options: WorkspaceExportOptions = {},
): AsyncGenerator<Uint8Array> {
  const settings: ArchiveOptions = {
    signal: options.signal,
    budget: options.budget && { ...options.budget },
  };
  const initial = await successor(workspace, undefined, undefined, settings.signal);
  const root = initial.entries[0]?.entry;
  if (root?.path !== "/" || root.kind !== "directory")
    contract("Completed snapshot has no root directory");
  yield* encodeWorkspaceArchive(
    {
      format: "waffle-workspace-archive-v1",
      sourceFormat: null,
      sourceWorkspace: initial.cut.workspace,
    },
    sourceEntries(workspace, initial.entries, initial.cut, settings.signal),
    settings,
  );
}
