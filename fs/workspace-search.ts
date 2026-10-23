import type { PersistedIndex } from "./storage.js";
import type { VfsDescriptor } from "./vfs.js";
import {
  WORKSPACE_LIMITS,
  type FileId,
  type FileVersion,
  type HistoryGap,
  type NamespaceCut,
  type NamespaceEntry,
  type ReadFailure,
  type ReadValue,
  type SnapshotCursor,
  type VersionLease,
  type WorkspaceChangePage,
  type WorkspaceVfs,
} from "./workspace-types.js";

export type SearchQuery = {
  readonly kind: "files" | "text";
  readonly prefix: string;
  readonly text: string;
};
export type SearchHit =
  | {
      readonly kind: "file";
      readonly id: FileId;
      readonly version: FileVersion;
      readonly path: string;
    }
  | {
      readonly kind: "text";
      readonly id: FileId;
      readonly version: FileVersion;
      readonly path: string;
      readonly offset: number;
      readonly length: number;
    };
export interface IndexStamp extends NamespaceCut {
  readonly format: "waffle-search-index";
  readonly schema: 1;
  readonly filesystem: {
    readonly format: string | null;
    readonly schema: PersistedIndex["version"];
  };
  readonly query: SearchQuery;
}
export type SearchTerminal =
  | { readonly kind: "cancelled" | "stopped" }
  | { readonly kind: "restart"; readonly current: NamespaceCut; readonly resync: "snapshot" }
  | HistoryGap
  | {
      readonly kind: "pressure";
      readonly resource: "query" | "pull" | "index" | "queue" | "results" | "read" | "snapshot";
    }
  | { readonly kind: "invalid"; readonly field: "query" | "index" }
  | { readonly kind: "read-failed"; readonly id: FileId; readonly failure: ReadFailure }
  | { readonly kind: "cleanup-failed"; readonly message: string };
export type SearchPage =
  | {
      readonly kind: "delta";
      readonly cut: NamespaceCut;
      readonly retract: readonly { readonly kind: "all" }[];
      readonly add: readonly SearchHit[];
    }
  | { readonly kind: "checkpoint"; readonly stamp: IndexStamp }
  | SearchTerminal;
export type IndexValidation =
  | { readonly kind: "valid"; readonly current: NamespaceCut }
  | {
      readonly kind: "stale";
      readonly current: NamespaceCut;
      readonly reason: "format" | "schema" | "query" | "behind";
      readonly action: "rebuild";
    }
  | {
      readonly kind: "gap";
      readonly current: NamespaceCut;
      readonly reason: "workspace" | "history" | "position";
      readonly resync: "snapshot";
    };
export interface SearchCursor {
  next(): Promise<SearchPage>;
  close(): Promise<void>;
}
export interface WorkspaceSearch {
  search(query: SearchQuery, signal?: AbortSignal): SearchCursor;
  /** Freshness of an in-memory checkpoint, not validation of persisted postings. */
  validateIndex(
    stamp: unknown,
    query: SearchQuery,
    signal?: AbortSignal,
  ): Promise<IndexValidation | SearchTerminal>;
  close(): Promise<void>;
}
export const WORKSPACE_SEARCH_LIMITS = Object.freeze({
  entries: 65536,
  nameBytes: 8 * 1024 * 1024,
  resultBytes: 4 * 1024 * 1024,
  queueBytes: 1024 * 1024,
  outputBytes: 64 * 1024,
  pageHits: 128,
  chunkBytes: 65536,
  queryBytes: 4096,
  totalBytes: 16 * 1024 * 1024,
});
export type SearchLimits = { readonly [K in keyof typeof WORKSPACE_SEARCH_LIMITS]: number };
const limitKeys = Object.keys(WORKSPACE_SEARCH_LIMITS) as (keyof SearchLimits)[];
type SearchOwner = { readonly workspace: WorkspaceVfs | undefined; readonly vfs: VfsDescriptor };
type Pattern = {
  readonly query: SearchQuery;
  readonly bytes: Uint8Array;
  readonly table: Uint32Array;
  readonly charge: number;
};
type Names = { entries: NamespaceEntry[]; bytes: number };
type Live = {
  kind: "live";
  names: Names;
  cut: NamespaceCut;
  index: number;
  offset: number;
  matched: number;
  results: number;
};
type State = { kind: "snapshot"; names: Names } | Live | { kind: "terminal"; page: SearchTerminal };
const filesystemSchema: PersistedIndex["version"] = 1;
const owners = new WeakMap<WorkspaceVfs, Search>();
const encoder = new TextEncoder();
const invalidQuery = { kind: "invalid", field: "query" } as const;
const pressure = (
  resource: Extract<SearchTerminal, { kind: "pressure" }>["resource"],
): SearchTerminal => ({ kind: "pressure", resource });
const cutCopy = (cut: NamespaceCut): NamespaceCut => ({
  workspace: cut.workspace,
  generation: cut.generation,
  watermark: { ...cut.watermark },
});
const delta = (cut: NamespaceCut, add: readonly SearchHit[] = [], reset = false): SearchPage => ({
  kind: "delta",
  cut: cutCopy(cut),
  retract: reset ? [{ kind: "all" }] : [],
  add,
});
function within(path: string, prefix: string): boolean {
  return prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
}
function canonical(path: string): boolean {
  if (!path.startsWith("/") || path.includes("\0") || path.length > WORKSPACE_LIMITS.pathUnits)
    return false;
  if (path === "/") return true;
  return path
    .slice(1)
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}
function validQuery(value: SearchQuery): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value.kind === "files" || value.kind === "text") &&
    typeof value.prefix === "string" &&
    typeof value.text === "string" &&
    canonical(value.prefix) &&
    (value.kind === "files" || value.text.length > 0)
  );
}
function limitsFrom(overrides: Partial<SearchLimits>): SearchLimits {
  const limits: Record<keyof SearchLimits, number> = { ...WORKSPACE_SEARCH_LIMITS };
  for (const key of limitKeys) {
    const value = key in overrides ? overrides[key] : WORKSPACE_SEARCH_LIMITS[key];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > WORKSPACE_SEARCH_LIMITS[key]
    )
      throw new Error(`Invalid search limit: ${key}`);
    limits[key] = value;
  }
  if (!limits.chunkBytes || !limits.pageHits)
    throw new Error("Search requires positive chunk and page limits");
  return Object.freeze(limits);
}
function prefixTable(pattern: Uint8Array): Uint32Array {
  const table = new Uint32Array(pattern.length);
  let matched = 0;
  for (let index = 1; index < pattern.length; index++) {
    while (matched && pattern[index] !== pattern[matched]) matched = table[matched - 1]!;
    if (pattern[index] === pattern[matched]) matched++;
    table[index] = matched;
  }
  return table;
}
function compile(query: SearchQuery, limits: SearchLimits): Pattern | SearchTerminal {
  try {
    query = { kind: query.kind, prefix: query.prefix, text: query.text };
  } catch {
    return invalidQuery;
  }
  if (!validQuery(query)) return invalidQuery;
  if (limits.outputBytes < 256) return pressure("results");
  if (query.text.length > limits.queryBytes) return pressure("query");
  const bytes = query.kind === "text" ? encoder.encode(query.text) : new Uint8Array();
  if (bytes.byteLength > limits.queryBytes) return pressure("query");
  const charge = 256 + 2 * (query.text.length + query.prefix.length) + 5 * bytes.byteLength;
  if (charge > limits.totalBytes) return pressure("index");
  return { query: Object.freeze(query), bytes, table: prefixTable(bytes), charge };
}
class Refused implements SearchCursor {
  constructor(private readonly page: SearchTerminal) {}
  async next(): Promise<SearchPage> {
    return this.page;
  }
  async close(): Promise<void> {}
}

/** @public Borrows one public workspace projection. Limits can only lower the fixed bounds. */
export function createWorkspaceSearch(
  owner: SearchOwner,
  limits: Partial<SearchLimits> = {},
): WorkspaceSearch {
  if (!owner.workspace || !owner.vfs)
    throw new Error("Search requires a workspace and its VFS descriptor");
  const existing = owners.get(owner.workspace);
  const selectedLimits = limitsFrom(limits);
  const format = owner.vfs.format?.id ?? null;
  if (existing) {
    if (existing.format !== format) throw new Error("Workspace already has a different VFS format");
    if (limitKeys.some((key) => key in limits && selectedLimits[key] !== existing.limits[key]))
      throw new Error("Workspace already has different search limits");
    return existing;
  }
  const search = new Search(owner.workspace, format, selectedLimits);
  owners.set(owner.workspace, search);
  return search;
}
class Search implements WorkspaceSearch {
  private active?: Cursor | "opening";
  private stopped = false;
  private closing?: Promise<void>;
  constructor(
    readonly workspace: WorkspaceVfs,
    readonly format: string | null,
    readonly limits: SearchLimits,
  ) {}
  search(query: SearchQuery, signal?: AbortSignal): SearchCursor {
    return this.open(query, false, signal);
  }
  private open(query: SearchQuery, validation: boolean, signal?: AbortSignal): SearchCursor {
    if (this.stopped) return new Refused({ kind: "stopped" });
    if (this.active) return new Refused(pressure("query"));
    this.active = "opening";
    try {
      if (signal?.aborted) return new Refused({ kind: "cancelled" });
      const pattern = compile(query, this.limits);
      if (this.stopped) return new Refused({ kind: "stopped" });
      if (!("query" in pattern)) return new Refused(pattern);
      const cursor = new Cursor(this, pattern, validation, signal);
      this.active = cursor;
      cursor.initialize();
      return cursor;
    } finally {
      if (this.active === "opening") this.active = undefined;
    }
  }
  release(cursor: Cursor): void {
    if (this.active === cursor) this.active = undefined;
  }
  stamp(cut: NamespaceCut, query: SearchQuery): IndexStamp {
    return {
      ...cutCopy(cut),
      format: "waffle-search-index",
      schema: 1,
      filesystem: { format: this.format, schema: filesystemSchema },
      query: { ...query },
    };
  }
  async validateIndex(
    saved: unknown,
    query: SearchQuery,
    signal?: AbortSignal,
  ): Promise<IndexValidation | SearchTerminal> {
    const parsed = parseStamp(saved);
    if (!parsed) return { kind: "invalid", field: "index" };
    const cursor = this.open(query, true, signal);
    const page = await cursor.next();
    try {
      await cursor.close();
    } catch (error) {
      return { kind: "cleanup-failed", message: message(error) };
    }
    if (page.kind === "checkpoint") return compareStamp(parsed, page.stamp);
    if (page.kind === "delta") throw new Error("Validation unexpectedly produced search results");
    return page;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.closing =
      this.active instanceof Cursor ? this.active.stop({ kind: "stopped" }) : Promise.resolve();
    return this.closing;
  }
}
class Cursor implements SearchCursor {
  private state: State = { kind: "snapshot", names: { entries: [], bytes: 0 } };
  private readonly lifetime = new AbortController();
  private failure?: { readonly error: unknown };
  private work?: Promise<SearchPage>;
  private closing?: Promise<void>;
  private snapshot?: SnapshotCursor;
  private lease?: VersionLease;
  private readonly abort = () => {
    void this.stop({ kind: "cancelled" }).catch(() => {});
  };
  constructor(
    private readonly owner: Search,
    private readonly pattern: Pattern,
    private readonly validation: boolean,
    private readonly signal?: AbortSignal,
  ) {}
  initialize(): void {
    try {
      if (this.signal?.aborted) return this.abort();
      this.signal?.addEventListener("abort", this.abort, { once: true });
      if (this.signal?.aborted) this.abort();
    } catch (error) {
      void this.stop({ kind: "cleanup-failed", message: message(error) }, { error }).catch(
        () => {},
      );
    }
  }
  next(): Promise<SearchPage> {
    if (this.state.kind === "terminal") return this.terminalPage();
    if (this.work) return Promise.resolve(pressure("pull"));
    const work = Promise.resolve().then(() => this.turn());
    this.work = work;
    return this.deliver(work);
  }
  private async deliver(work: Promise<SearchPage>): Promise<SearchPage> {
    let page: SearchPage;
    try {
      page = await work;
    } catch (error) {
      this.fail({ kind: "cleanup-failed", message: message(error) });
      page = await this.terminalPage();
    } finally {
      if (this.work === work) this.work = undefined;
    }
    if (this.state.kind === "terminal") return this.terminalPage();
    return page;
  }
  private async terminalPage(): Promise<SearchPage> {
    await this.closing?.catch(() => {});
    if (this.state.kind !== "terminal") throw new Error("Search is not terminal");
    return this.state.page;
  }
  private fail(page: SearchTerminal): SearchTerminal {
    void this.stop(page).catch(() => {});
    return page;
  }
  stop(page: SearchTerminal, failure?: { readonly error: unknown }): Promise<void> {
    this.failure ??= failure;
    if (this.closing) return this.closing;
    this.state = { kind: "terminal", page };
    const work = this.work;
    this.closing = Promise.resolve().then(() => this.cleanup(work));
    void this.closing.catch((error) => {
      this.state = { kind: "terminal", page: { kind: "cleanup-failed", message: message(error) } };
    });
    return this.closing;
  }
  close(): Promise<void> {
    return this.stop({ kind: "cancelled" });
  }
  private async cleanup(work?: Promise<SearchPage>): Promise<void> {
    try {
      this.signal?.removeEventListener("abort", this.abort);
    } catch (error) {
      this.failure ??= { error };
    }
    try {
      this.lifetime.abort();
    } catch (error) {
      this.failure ??= { error };
    }
    await work?.catch(() => {});
    try {
      await this.closeSnapshot();
    } catch (error) {
      this.failure ??= { error };
    }
    try {
      await this.closeLease();
    } catch (error) {
      this.failure ??= { error };
    }
    if (this.failure) throw this.failure.error;
    this.owner.release(this);
  }
  private async closeSnapshot(): Promise<void> {
    if (!this.snapshot) return;
    await this.snapshot.close();
    this.snapshot = undefined;
  }
  private async closeLease(): Promise<void> {
    if (!this.lease) return;
    await this.lease.close();
    this.lease = undefined;
  }
  private get currentState(): State {
    return this.state;
  }
  private interrupted(): SearchTerminal {
    if (this.state.kind === "terminal") return this.state.page;
    return this.fail(pressure("snapshot"));
  }
  private async turn(): Promise<SearchPage> {
    if (this.state.kind === "terminal") return this.state.page;
    if (this.state.kind === "snapshot") await this.seed(this.state);
    const state = this.currentState;
    if (state.kind !== "live")
      return state.kind === "terminal" ? state.page : this.fail(pressure("snapshot"));
    if (this.validation)
      return { kind: "checkpoint", stamp: this.owner.stamp(state.cut, this.pattern.query) };
    const changes = await this.owner.workspace.changes(state.cut.watermark, this.lifetime.signal);
    if (this.state !== state) return this.interrupted();
    const advanced = this.advance(state, changes);
    if (advanced) return advanced;
    return this.scan(state);
  }
  private async seed(state: Extract<State, { kind: "snapshot" }>): Promise<void> {
    this.snapshot = this.owner.workspace.snapshot(
      { prefix: "/", includeDirs: false },
      this.lifetime.signal,
    );
    while (this.state === state) {
      const page = await this.snapshot.next();
      if (this.state !== state) return;
      if (page.kind === "entries") {
        this.stage(state.names, page.entries);
        continue;
      }
      await this.finishSnapshot(state, page);
      return;
    }
  }
  private async finishSnapshot(
    state: Extract<State, { kind: "snapshot" }>,
    page: Exclude<Awaited<ReturnType<SnapshotCursor["next"]>>, { kind: "entries" }>,
  ): Promise<void> {
    if (page.kind === "complete") {
      await this.closeSnapshot();
      if (this.state === state)
        this.state = {
          kind: "live",
          names: state.names,
          cut: cutCopy(page.cut),
          index: 0,
          offset: 0,
          matched: 0,
          results: 0,
        };
      return;
    }
    if (page.kind === "restart") {
      this.fail({ ...page, resync: "snapshot" });
      return;
    }
    this.fail(page.kind === "pressure" ? pressure("snapshot") : page);
  }
  private stage(names: Names, entries: readonly NamespaceEntry[]): void {
    for (const entry of entries) {
      if (!this.stageEntry(names, entry)) return;
    }
  }
  private stageEntry(names: Names, entry: NamespaceEntry): boolean {
    const charge = 192 + 2 * entry.path.length;
    const limits = this.owner.limits;
    if (
      names.entries.length >= limits.entries ||
      names.bytes + charge > limits.nameBytes ||
      names.bytes + charge + this.pattern.charge > limits.totalBytes
    ) {
      this.fail(pressure("index"));
      return false;
    }
    names.bytes += charge;
    names.entries.push(entry);
    return true;
  }
  private advance(state: Live, page: WorkspaceChangePage): SearchPage | undefined {
    if (page.kind !== "changes")
      return this.fail(page.kind === "pressure" ? pressure("snapshot") : page);
    let seq: bigint = state.cut.watermark.seq,
      generation: bigint = state.cut.generation;
    if (page.next.history !== state.cut.watermark.history) return this.restart(state.cut);
    for (const batch of page.batches) {
      if (batch.seq !== seq + 1n || batch.generation <= generation) return this.restart(state.cut);
      seq = batch.seq;
      generation = batch.generation;
    }
    if (page.next.seq !== seq) return this.restart(state.cut);
    const last = page.batches.at(-1);
    if (!last) return;
    const current: NamespaceCut = {
      workspace: state.cut.workspace,
      generation: last.generation,
      watermark: { ...page.next },
    };
    this.state = { kind: "snapshot", names: { entries: [], bytes: 0 } };
    return delta(current, [], true);
  }
  private restart(current: NamespaceCut): SearchTerminal {
    return this.fail({ kind: "restart", current: cutCopy(current), resync: "snapshot" });
  }
  private async scan(state: Live): Promise<SearchPage> {
    const entry = this.selected(state);
    if (!entry)
      return { kind: "checkpoint", stamp: this.owner.stamp(state.cut, this.pattern.query) };
    if (this.owner.limits.queueBytes < 128) return this.fail(pressure("queue"));
    if (this.pattern.query.kind === "files") return this.fileHit(state, entry);
    return this.textHits(state, entry);
  }
  private selected(state: Live): NamespaceEntry | undefined {
    while (state.index < state.names.entries.length) {
      const entry = state.names.entries[state.index]!;
      if (
        within(entry.path, this.pattern.query.prefix) &&
        (this.pattern.query.kind === "text" || entry.path.includes(this.pattern.query.text))
      )
        return entry;
      this.nextFile(state);
    }
    return;
  }
  private nextFile(state: Live): void {
    state.index++;
    state.offset = 0;
    state.matched = 0;
  }
  private fileHit(state: Live, entry: NamespaceEntry): SearchPage {
    if (!this.reserveHit(state, entry, 256, 0)) return this.fail(pressure("results"));
    this.nextFile(state);
    return delta(state.cut, [
      { kind: "file", id: entry.id, version: entry.version, path: entry.path },
    ]);
  }
  private async textHits(state: Live, entry: NamespaceEntry): Promise<SearchPage> {
    const length = Math.min(this.owner.limits.chunkBytes, entry.size - state.offset);
    if (
      state.names.bytes + this.pattern.charge + state.results + length + 128 + 256 >
      this.owner.limits.totalBytes
    )
      return this.fail(pressure("read"));
    const selected = await this.owner.workspace.pin(entry.id, entry.version, this.lifetime.signal);
    if (selected.kind !== "ok") return this.readFailure(entry.id, selected);
    this.lease = selected.value;
    try {
      return await this.readChunk(state, entry, length);
    } finally {
      await this.closeLease();
    }
  }
  private async readChunk(state: Live, entry: NamespaceEntry, length: number): Promise<SearchPage> {
    const lease = this.lease;
    if (!lease) throw new Error("Search lost its version lease");
    if (this.state !== state) return { kind: "cancelled" };
    if (
      lease.stat.id !== entry.id ||
      lease.stat.version !== entry.version ||
      lease.stat.kind !== "file" ||
      lease.stat.size !== entry.size ||
      lease.stat.cut.workspace !== state.cut.workspace ||
      lease.stat.cut.watermark.history !== state.cut.watermark.history
    )
      return this.readFailure(entry.id, {
        kind: "corrupt",
        message: "Pinned identity, version or size differs from snapshot",
      });
    const result = await lease.read({ offset: state.offset, length }, this.lifetime.signal);
    if (this.state !== state) return { kind: "cancelled" };
    if (result.kind !== "ok") return this.readFailure(entry.id, result);
    if (!this.validRange(result.value, entry, state.offset, length))
      return this.readFailure(entry.id, {
        kind: "corrupt",
        message: "Read identity, version or range differs from lease",
      });
    return this.matchChunk(state, entry, result.value.bytes);
  }
  private validRange(
    value: ReadValue,
    entry: NamespaceEntry,
    offset: number,
    length: number,
  ): boolean {
    return (
      value.stat.id === entry.id &&
      value.stat.version === entry.version &&
      value.range.offset === offset &&
      value.range.length === length &&
      value.bytes.byteLength === length
    );
  }
  private matchChunk(state: Live, entry: NamespaceEntry, bytes: Uint8Array): SearchPage {
    const hits: SearchHit[] = [];
    let output = 256;
    for (const byte of bytes) {
      while (state.matched && byte !== this.pattern.bytes[state.matched])
        state.matched = this.pattern.table[state.matched - 1]!;
      if (byte === this.pattern.bytes[state.matched]) state.matched++;
      state.offset++;
      if (state.matched !== this.pattern.bytes.length) continue;
      if (!this.reserveHit(state, entry, output, bytes.byteLength))
        return this.fail(pressure("results"));
      hits.push({
        kind: "text",
        id: entry.id,
        version: entry.version,
        path: entry.path,
        offset: state.offset - this.pattern.bytes.length,
        length: this.pattern.bytes.length,
      });
      output += 96 + 2 * entry.path.length;
      state.matched = this.pattern.table[state.matched - 1]!;
      if (
        hits.length === this.owner.limits.pageHits ||
        output + 96 + 2 * entry.path.length > this.owner.limits.outputBytes
      )
        break;
    }
    if (state.offset === entry.size) this.nextFile(state);
    return delta(state.cut, hits);
  }
  private reserveHit(
    state: Live,
    entry: NamespaceEntry,
    output: number,
    readBytes: number,
  ): boolean {
    const charge = 96 + 2 * entry.path.length,
      limits = this.owner.limits;
    if (
      output + charge > limits.outputBytes ||
      state.results + charge > limits.resultBytes ||
      state.names.bytes + this.pattern.charge + state.results + output + charge + readBytes + 128 >
        limits.totalBytes
    )
      return false;
    state.results += charge;
    return true;
  }
  private readFailure(id: FileId, failure: ReadFailure): SearchTerminal {
    if (failure.kind === "cancelled" || failure.kind === "stopped") return this.fail(failure);
    return this.fail({ kind: "read-failed", id, failure });
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
type SavedStamp = {
  workspace: string;
  generation: bigint;
  history: string;
  seq: bigint;
  format: string;
  schema: number;
  filesystem: { format: string | null; schema: number };
  query: SearchQuery;
};
function boundedToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
function boundedCounter(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n && value <= 0xffffffffffffffffn;
}
function parseQuery(value: unknown): SearchQuery | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    !("kind" in value) ||
    !("prefix" in value) ||
    !("text" in value)
  )
    return;
  if (
    (value.kind !== "files" && value.kind !== "text") ||
    typeof value.prefix !== "string" ||
    typeof value.text !== "string"
  )
    return;
  const query: SearchQuery = { kind: value.kind, prefix: value.prefix, text: value.text };
  if (
    !validQuery(query) ||
    value.text.length > 4096 ||
    (query.kind === "text" && encoder.encode(value.text).byteLength > 4096)
  )
    return;
  return query;
}
function parseFilesystem(value: unknown): SavedStamp["filesystem"] | undefined {
  if (value === null || typeof value !== "object" || !("format" in value) || !("schema" in value))
    return;
  if (
    (value.format !== null && !boundedToken(value.format)) ||
    typeof value.schema !== "number" ||
    !Number.isSafeInteger(value.schema) ||
    value.schema < 0
  )
    return;
  return { format: value.format, schema: value.schema };
}
function parsePosition(value: unknown): Pick<SavedStamp, "history" | "seq"> | undefined {
  if (value === null || typeof value !== "object" || !("history" in value) || !("seq" in value))
    return;
  if (!boundedToken(value.history) || !boundedCounter(value.seq)) return;
  return { history: value.history, seq: value.seq };
}
function parseStamp(value: unknown): SavedStamp | undefined {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      !("workspace" in value) ||
      !("generation" in value) ||
      !("watermark" in value) ||
      !("format" in value) ||
      !("schema" in value) ||
      !("filesystem" in value) ||
      !("query" in value)
    )
      return;
    if (
      !boundedToken(value.workspace) ||
      !boundedCounter(value.generation) ||
      !boundedToken(value.format) ||
      typeof value.schema !== "number" ||
      !Number.isSafeInteger(value.schema) ||
      value.schema < 0
    )
      return;
    const position = parsePosition(value.watermark),
      filesystem = parseFilesystem(value.filesystem),
      query = parseQuery(value.query);
    if (!position || !filesystem || !query) return;
    return {
      workspace: value.workspace,
      generation: value.generation,
      ...position,
      format: value.format,
      schema: value.schema,
      filesystem,
      query,
    };
  } catch {
    return;
  }
}
function compareStamp(saved: SavedStamp, current: IndexStamp): IndexValidation {
  const gap = (reason: "workspace" | "history" | "position"): IndexValidation => ({
    kind: "gap",
    current: cutCopy(current),
    reason,
    resync: "snapshot",
  });
  const stale = (reason: "format" | "schema" | "query" | "behind"): IndexValidation => ({
    kind: "stale",
    current: cutCopy(current),
    reason,
    action: "rebuild",
  });
  if (saved.workspace !== current.workspace) return gap("workspace");
  if (saved.format !== current.format || saved.filesystem.format !== current.filesystem.format)
    return stale("format");
  if (saved.schema !== current.schema || saved.filesystem.schema !== current.filesystem.schema)
    return stale("schema");
  if (
    saved.query.kind !== current.query.kind ||
    saved.query.prefix !== current.query.prefix ||
    saved.query.text !== current.query.text
  )
    return stale("query");
  if (saved.history !== current.watermark.history) return gap("history");
  if (saved.generation === current.generation && saved.seq === current.watermark.seq)
    return { kind: "valid", current: cutCopy(current) };
  if (saved.generation < current.generation && saved.seq < current.watermark.seq)
    return stale("behind");
  return gap("position");
}
