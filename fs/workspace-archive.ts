import { permissionsFor } from "../core/filesystem.js";
import { parseStoredIdentity, type StoredIdentity } from "./file-identity.js";
import type { NamespaceEntry } from "./workspace-types.js";

const MAGIC = new TextEncoder().encode("WAFLAR02");
const FORMAT = "waffle-workspace-archive-v2";
const HEADER = 1,
  ENTRY = 2,
  DATA = 3,
  END_ENTRY = 4,
  END = 5;
const DIGEST_BYTES = 32;
export const WORKSPACE_ARCHIVE_LIMITS = Object.freeze({
  headerBytes: 16 * 1024,
  chunkBytes: 64 * 1024,
  transportBytes: 64 * 1024 + 37,
  emptyChunks: 128,
  pathUnits: 4096,
  depth: 128,
});
export interface ArchiveManifest {
  readonly format: typeof FORMAT;
  readonly sourceFormat: string | null;
  readonly sourceWorkspace: string | null;
}
type ArchiveFields = Pick<NamespaceEntry, "path" | "size" | "mtime" | "mode"> & {
  readonly sourceIdentity: StoredIdentity | null;
};
export type ArchiveEntry = ArchiveFields &
  (
    | { readonly kind: "file" }
    | { readonly kind: "directory" }
    | { readonly kind: "symlink"; readonly target: string }
  );
export type ArchiveSourceEntry =
  | { readonly metadata: Exclude<ArchiveEntry, { kind: "file" }>; readonly bytes?: never }
  | {
      readonly metadata: Extract<ArchiveEntry, { kind: "file" }>;
      readonly bytes: AsyncIterable<Uint8Array>;
    };
export interface ArchiveSummary {
  readonly entries: number;
  readonly fileBytes: number;
  readonly linkTargetBytes: number;
}
interface ArchiveBudget {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}
export interface ArchiveOptions {
  readonly signal?: AbortSignal;
  readonly budget?: ArchiveBudget;
}
export type ArchiveEvent =
  | { readonly kind: "manifest"; readonly manifest: ArchiveManifest }
  | { readonly kind: "entry"; readonly entry: ArchiveEntry }
  | { readonly kind: "data"; readonly bytes: Uint8Array }
  | { readonly kind: "end-entry" }
  | { readonly kind: "complete"; readonly summary: ArchiveSummary };

/** All writes are private. Only complete may atomically select the durable staged root. */
export interface ArchiveStagingSink {
  begin(manifest: ArchiveManifest, signal?: AbortSignal): Promise<void>;
  entry(entry: Exclude<ArchiveEntry, { kind: "symlink" }>, signal?: AbortSignal): Promise<void>;
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  endEntry(signal?: AbortSignal): Promise<void>;
  complete(summary: ArchiveSummary, signal?: AbortSignal): Promise<void>;
  abort(reason: unknown): Promise<void>;
}
export class WorkspaceArchiveError extends Error {
  constructor(
    readonly code: "INVALID" | "LIMIT" | "TRUNCATED" | "INTEGRITY",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceArchiveError";
  }
}
function fail(code: WorkspaceArchiveError["code"], message: string): never {
  throw new WorkspaceArchiveError(code, message);
}
function checkSignal(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function add(value: number, amount: number, maximum: number): number {
  if (amount > maximum - value) fail("LIMIT", "Archive budget exceeded");
  return value + amount;
}
function budgetFor(options: ArchiveOptions): ArchiveBudget {
  const budget = options.budget ?? {
    maxEntries: 1_000_000,
    maxFileBytes: 2 ** 40,
    maxTotalBytes: 2 ** 40,
  };
  if (
    !integer(budget.maxEntries) ||
    !integer(budget.maxFileBytes) ||
    !integer(budget.maxTotalBytes)
  )
    fail("LIMIT", "Invalid archive budget");
  return Object.freeze({ ...budget });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID", "Expected metadata object");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value)))
    fail("INVALID", "Unexpected metadata fields");
}
function manifestFor(value: unknown): ArchiveManifest {
  const data = record(value);
  exactKeys(data, ["format", "sourceFormat", "sourceWorkspace"]);
  if (data.format !== FORMAT) fail("INVALID", "Unsupported archive format");
  if (
    data.sourceFormat !== null &&
    (typeof data.sourceFormat !== "string" || !/^[a-z0-9-]{1,128}$/.test(data.sourceFormat))
  )
    fail("INVALID", "Invalid source format");
  if (
    data.sourceWorkspace !== null &&
    (typeof data.sourceWorkspace !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data.sourceWorkspace))
  )
    fail("INVALID", "Invalid source workspace");
  return Object.freeze({
    format: FORMAT,
    sourceFormat: data.sourceFormat,
    sourceWorkspace: data.sourceWorkspace,
  });
}
function entryFor(value: unknown, manifest: ArchiveManifest): ArchiveEntry {
  const data = record(value);
  if (data.kind !== "file" && data.kind !== "directory" && data.kind !== "symlink")
    fail("INVALID", "Unsupported entry kind");
  const keys = ["path", "kind", "size", "mtime", "mode", "sourceIdentity"];
  exactKeys(data, data.kind === "symlink" ? keys.concat(["target"]) : keys);
  if (typeof data.path !== "string" || /[\uD800-\uDFFF]/u.test(data.path))
    fail("INVALID", "Invalid path string");
  if (!integer(data.size) || (data.kind === "directory" && data.size !== 0))
    fail("INVALID", "Invalid entry size");
  if (typeof data.mtime !== "number" || !Number.isFinite(data.mtime))
    fail("INVALID", "Invalid mtime");
  const mask = permissionsFor(data.kind, 0).modeSupported;
  if (!integer(data.mode) || data.mode > mask || (data.mode & ~mask) !== 0)
    fail("INVALID", "Unsupported mode bits");
  const sourceIdentity = sourceIdentityFor(data.sourceIdentity, manifest.sourceWorkspace);
  const fields = {
    path: data.path,
    size: data.size,
    mtime: data.mtime,
    mode: data.mode,
    sourceIdentity,
  };
  if (data.kind !== "symlink") return Object.freeze({ ...fields, kind: data.kind });
  const target = data.target;
  if (typeof target !== "string") fail("INVALID", "Invalid link target");
  archiveTargetCharge(target, data.size, 3 * WORKSPACE_ARCHIVE_LIMITS.headerBytes);
  return Object.freeze({ ...fields, kind: "symlink", target });
}

/** Internal exporter admission. No encoded target allocation is needed to measure it. */
export function archiveTargetCharge(target: unknown, size: number, maximum: number): number {
  if (typeof target !== "string" || !target) fail("INVALID", "Invalid link target");
  const retained = add(0, 2 * target.length, maximum);
  let bytes = 0;
  for (let index = 0; index < target.length; index++) {
    const unit = target.charCodeAt(index);
    if (unit === 0) fail("INVALID", "Invalid link target");
    const pair = isSurrogatePair(target, index);
    const length = unit < 0x80 ? 1 : unit < 0x800 ? 2 : pair ? 4 : 3;
    bytes = add(bytes, length, maximum - retained);
    if (pair) index++;
  }
  if (size !== bytes) fail("INVALID", "Link target size mismatch");
  return retained + bytes;
}
function isSurrogatePair(text: string, index: number): boolean {
  const first = text.charCodeAt(index),
    second = text.charCodeAt(index + 1);
  return first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff;
}
function sourceIdentityFor(value: unknown, workspace: string | null): StoredIdentity | null {
  if (value === null) return null;
  let identity: StoredIdentity;
  try {
    identity = parseStoredIdentity(value);
  } catch {
    fail("INVALID", "Invalid source identity");
  }
  if (workspace === null || identity.workspace !== workspace)
    fail("INVALID", "Foreign source identity");
  exactKeys(record(value), ["format", "workspace", "id", "version"]);
  return Object.freeze(identity);
}
class NamespaceOrder {
  private readonly directories: { path: string; lastChild: string }[] = [];
  accept(entry: ArchiveEntry): void {
    const path = entry.path;
    if (path.length > WORKSPACE_ARCHIVE_LIMITS.pathUnits) fail("LIMIT", "Path too long");
    if (this.directories.length === 0) {
      if (path !== "/" || entry.kind !== "directory")
        fail("INVALID", "Root directory must be first");
      this.directories.push({ path, lastChild: "" });
      return;
    }
    if (!path.startsWith("/") || path === "/" || /[\0\\]/.test(path))
      fail("INVALID", "Invalid absolute path");
    const parts = path.slice(1).split("/");
    if (parts.length > WORKSPACE_ARCHIVE_LIMITS.depth) fail("LIMIT", "Path too deep");
    if (parts.some((part) => !part || part === "." || part === ".."))
      fail("INVALID", "Invalid path component");
    const at = path.lastIndexOf("/"),
      parent = path.slice(0, at) || "/",
      child = path.slice(at + 1);
    while (this.directories.length && this.directories.at(-1)?.path !== parent)
      this.directories.pop();
    const directory = this.directories.at(-1);
    if (!directory || child <= directory.lastChild)
      fail("INVALID", "Entries must be sorted depth-first with explicit parents");
    directory.lastChild = child;
    if (entry.kind === "directory") this.directories.push({ path, lastChild: "" });
  }
}
function jsonStringSize(text: string, maximum: number): number {
  let size = add(0, 2, maximum);
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    const pair = isSurrogatePair(text, index);
    let length = unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    if (unit === 0x22 || unit === 0x5c || (unit >= 8 && unit <= 10) || unit === 12 || unit === 13)
      length = 2;
    else if (unit < 0x20 || (unit >= 0xd800 && unit <= 0xdfff && !pair)) length = 6;
    else if (pair) length = 4;
    size = add(size, length, maximum);
    if (pair) index++;
  }
  return size;
}
function jsonSize(value: unknown, maximum: number): number {
  if (value === null) return add(0, 4, maximum);
  if (typeof value === "string") return jsonStringSize(value, maximum);
  if (typeof value === "number") return add(0, JSON.stringify(value).length, maximum);
  const fields = record(value);
  let size = add(0, 2, maximum),
    separator = 0;
  for (const key of Object.keys(fields)) {
    size = add(size, separator + 1, maximum);
    size += jsonStringSize(key, maximum - size);
    size += jsonSize(fields[key], maximum - size);
    separator = 1;
  }
  return size;
}
function json(value: ArchiveManifest | ArchiveEntry): Uint8Array {
  jsonSize(value, WORKSPACE_ARCHIVE_LIMITS.headerBytes);
  return new TextEncoder().encode(JSON.stringify(value));
}
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("INVALID", "Invalid UTF-8 JSON metadata");
  }
}
async function digest(
  previous: Uint8Array,
  header: Uint8Array,
  payload: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = new Uint8Array(previous.length + header.length + payload.length);
  input.set(previous);
  input.set(header, previous.length);
  input.set(payload, previous.length + header.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}
class FrameEncoder {
  constructor(private readonly signal?: AbortSignal) {}
  private previous = new Uint8Array(DIGEST_BYTES);
  async frame(type: number, payload: Uint8Array): Promise<Uint8Array> {
    checkSignal(this.signal);
    const frame = new Uint8Array(5 + payload.length + DIGEST_BYTES);
    frame[0] = type;
    new DataView(frame.buffer).setUint32(1, payload.length);
    frame.set(payload, 5);
    this.previous = await digest(
      this.previous,
      frame.subarray(0, 5),
      frame.subarray(5, 5 + payload.length),
    );
    checkSignal(this.signal);
    frame.set(this.previous, 5 + payload.length);
    return frame;
  }
}
function summaryBytes(summary: ArchiveSummary): Uint8Array {
  const bytes = new Uint8Array(24),
    view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(summary.entries));
  view.setBigUint64(8, BigInt(summary.fileBytes));
  view.setBigUint64(16, BigInt(summary.linkTargetBytes));
  return bytes;
}
class ArchiveState {
  readonly budget: ArchiveBudget;
  readonly order = new NamespaceOrder();
  entries = 0;
  fileBytes = 0;
  linkTargetBytes = 0;
  constructor(options: ArchiveOptions) {
    this.budget = budgetFor(options);
  }
  accept(entry: ArchiveEntry): void {
    this.order.accept(entry);
    this.entries = add(this.entries, 1, this.budget.maxEntries);
    const total = add(this.fileBytes, this.linkTargetBytes, this.budget.maxTotalBytes);
    add(total, entry.size, this.budget.maxTotalBytes);
    if (entry.kind === "symlink") {
      this.linkTargetBytes += entry.size;
      return;
    }
    if (entry.kind !== "file") return;
    if (entry.size > this.budget.maxFileBytes) fail("LIMIT", "File too large");
    this.fileBytes += entry.size;
  }
  summary(): ArchiveSummary {
    return Object.freeze({
      entries: this.entries,
      fileBytes: this.fileBytes,
      linkTargetBytes: this.linkTargetBytes,
    });
  }
}
async function* encodeEntry(
  source: ArchiveSourceEntry,
  manifest: ArchiveManifest,
  frames: FrameEncoder,
  state: ArchiveState,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const entry = entryFor(source.metadata, manifest);
  state.accept(entry);
  yield await frames.frame(ENTRY, json(entry));
  if (source.metadata.kind === "file") {
    const bytes = source.bytes;
    if (!bytes) fail("INVALID", "Missing file payload iterator");
    yield* encodeFile(bytes, entry.size, frames, signal);
  }
  checkSignal(signal);
  yield await frames.frame(END_ENTRY, new Uint8Array());
}
async function* encodeFile(
  source: AsyncIterable<Uint8Array>,
  expectedSize: number,
  frames: FrameEncoder,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let size = 0;
  const input = new ArchiveInput(source, signal);
  let failure: Failure | undefined;
  try {
    for (;;) {
      const { result } = await input.next();
      if (result.done) break;
      const bytes = result.value;
      if (!(bytes instanceof Uint8Array) || bytes.length > WORKSPACE_ARCHIVE_LIMITS.chunkBytes)
        fail("LIMIT", "Source chunk too large");
      if (bytes.length === 0) fail("INVALID", "Empty source chunk");
      size = add(size, bytes.length, expectedSize);
      yield await frames.frame(DATA, bytes);
    }
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await input.close(failure);
  }
  checkSignal(signal);
  if (size !== expectedSize) fail("INVALID", "Source file length mismatch");
}
export async function* encodeWorkspaceArchive(
  manifest: ArchiveManifest,
  entries: AsyncIterable<ArchiveSourceEntry>,
  options: ArchiveOptions = {},
): AsyncGenerator<Uint8Array> {
  const checked = manifestFor(manifest),
    state = new ArchiveState(options),
    frames = new FrameEncoder(options.signal);
  checkSignal(options.signal);
  yield MAGIC.slice();
  yield await frames.frame(HEADER, json(checked));
  const input = new ArchiveInput(entries, options.signal);
  let failure: Failure | undefined;
  try {
    for (;;) {
      const { result } = await input.next();
      if (result.done) break;
      yield* encodeEntry(result.value, checked, frames, state, options.signal);
    }
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await input.close(failure);
  }
  checkSignal(options.signal);
  if (state.entries === 0) fail("INVALID", "Missing root");
  yield await frames.frame(END, summaryBytes(state.summary()));
}

interface Failure {
  readonly error: unknown;
}
type PullOutcome<T> =
  | { readonly kind: "fulfilled"; readonly result: IteratorResult<T>; readonly then: undefined }
  | { readonly kind: "rejected"; readonly reason: unknown; readonly then: undefined };
/* oxlint-disable unicorn/no-thenable -- Own undefined then fields prevent inherited hooks and result re-assimilation. */
function observePull<T>(iterator: AsyncIterator<T>): Promise<PullOutcome<T>> {
  try {
    return Promise.resolve(iterator.next()).then(
      (result) => ({ kind: "fulfilled", result, then: undefined }),
      (reason: unknown) => ({ kind: "rejected", reason, then: undefined }),
    );
  } catch (reason) {
    return Promise.resolve({ kind: "rejected", reason, then: undefined });
  }
}
async function waitForPull<T>(
  observed: Promise<PullOutcome<T>>,
  signal?: AbortSignal,
): Promise<PullOutcome<T>> {
  checkSignal(signal);
  if (!signal) return observed;
  let onAbort = () => {};
  const aborted = new Promise<PullOutcome<T>>((resolve) => {
    onAbort = () => resolve({ kind: "rejected", reason: signal.reason, then: undefined });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([observed, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
class ArchiveInput<T> {
  private readonly iterator: AsyncIterator<T>;
  private ended = false;
  private pending: Promise<PullOutcome<T>> | undefined;
  constructor(
    source: AsyncIterable<T>,
    private readonly signal?: AbortSignal,
  ) {
    checkSignal(signal);
    this.iterator = source[Symbol.asyncIterator]();
  }
  async next(): Promise<{ result: IteratorResult<T>; then: undefined }> {
    checkSignal(this.signal);
    this.pending = observePull(this.iterator);
    const outcome = await waitForPull(this.pending, this.signal);
    checkSignal(this.signal);
    if (outcome.kind === "rejected") throw outcome.reason;
    this.pending = undefined;
    this.ended = !!outcome.result.done;
    return { result: outcome.result, then: undefined };
  }
  async close(failure?: Failure): Promise<void> {
    let cleanup: Failure | undefined;
    try {
      if (!this.ended) await this.iterator.return?.();
    } catch (error) {
      cleanup = { error };
    } finally {
      await this.pending;
      this.pending = undefined;
    }
    if (!cleanup) return;
    if (!failure) throw cleanup.error;
    throw new AggregateError(
      [failure.error, cleanup.error],
      "Archive operation and source cleanup failed",
    );
  }
}
/* oxlint-enable unicorn/no-thenable */
class StreamReader {
  private readonly input: ArchiveInput<Uint8Array>;
  private bytes: Uint8Array = new Uint8Array(0);
  private offset = 0;
  private ended = false;
  private emptyPulls = 0;
  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly signal?: AbortSignal,
  ) {
    this.input = new ArchiveInput(source, signal);
  }
  private async available(): Promise<boolean> {
    while (this.offset === this.bytes.length && !this.ended) await this.refill();
    return this.offset < this.bytes.length;
  }
  private async refill(): Promise<void> {
    checkSignal(this.signal);
    const { result: next } = await this.input.next();
    checkSignal(this.signal);
    if (next.done) {
      this.ended = true;
      this.bytes = new Uint8Array(0);
      return;
    }
    if (!(next.value instanceof Uint8Array)) fail("LIMIT", "Invalid transport chunk");
    const length = next.value.length;
    if (length > WORKSPACE_ARCHIVE_LIMITS.transportBytes)
      fail("LIMIT", "Transport chunk too large");
    this.emptyPulls = length ? 0 : this.emptyPulls + 1;
    if (this.emptyPulls > WORKSPACE_ARCHIVE_LIMITS.emptyChunks)
      fail("LIMIT", "Too many empty transport chunks");
    this.bytes = new Uint8Array(length);
    this.bytes.set(next.value);
    this.offset = 0;
  }
  async read(length: number): Promise<Uint8Array> {
    const output = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      if (!(await this.available())) fail("TRUNCATED", "Truncated archive");
      const amount = Math.min(length - filled, this.bytes.length - this.offset);
      output.set(this.bytes.subarray(this.offset, this.offset + amount), filled);
      this.offset += amount;
      filled += amount;
    }
    return output;
  }
  async eof(): Promise<void> {
    if (await this.available()) fail("INVALID", "Trailing archive bytes");
  }
  async close(failure?: Failure): Promise<void> {
    this.bytes = new Uint8Array(0);
    await this.input.close(failure);
  }
}
function frameLimit(type: number): number {
  if (type === HEADER || type === ENTRY) return WORKSPACE_ARCHIVE_LIMITS.headerBytes;
  if (type === DATA) return WORKSPACE_ARCHIVE_LIMITS.chunkBytes;
  if (type === END_ENTRY) return 0;
  if (type === END) return 24;
  fail("INVALID", "Unknown frame type");
}
class FrameReader {
  private previous = new Uint8Array(DIGEST_BYTES);
  constructor(
    private readonly reader: StreamReader,
    private readonly signal?: AbortSignal,
  ) {}
  async next(): Promise<{ type: number; payload: Uint8Array }> {
    const header = await this.reader.read(5),
      type = header[0]!,
      length = new DataView(header.buffer, header.byteOffset, 5).getUint32(1);
    if (length > frameLimit(type)) fail("LIMIT", "Frame too large");
    const payload = await this.reader.read(length),
      expected = await this.reader.read(DIGEST_BYTES);
    const actual = await digest(this.previous, header, payload);
    checkSignal(this.signal);
    if (!actual.every((byte, index) => byte === expected[index]))
      fail("INTEGRITY", "Frame checksum mismatch");
    this.previous = actual;
    return { type, payload };
  }
}
async function* parseEntry(
  entry: ArchiveEntry,
  frames: FrameReader,
  signal?: AbortSignal,
): AsyncGenerator<ArchiveEvent> {
  yield { kind: "entry", entry };
  let size = 0;
  for (;;) {
    checkSignal(signal);
    const frame = await frames.next();
    if (frame.type === END_ENTRY) break;
    if (frame.type !== DATA || entry.kind !== "file" || frame.payload.length === 0)
      fail("INVALID", "Unexpected entry frame");
    size = add(size, frame.payload.length, entry.size);
    yield { kind: "data", bytes: frame.payload };
  }
  if (entry.kind === "file" && size !== entry.size) fail("INVALID", "Entry file length mismatch");
  yield { kind: "end-entry" };
}
function validateSummary(payload: Uint8Array, summary: ArchiveSummary): void {
  if (payload.length !== 24) fail("INVALID", "Invalid archive summary");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (
    view.getBigUint64(0) !== BigInt(summary.entries) ||
    view.getBigUint64(8) !== BigInt(summary.fileBytes) ||
    view.getBigUint64(16) !== BigInt(summary.linkTargetBytes)
  )
    fail("INTEGRITY", "Archive totals mismatch");
}
export async function* parseWorkspaceArchive(
  source: AsyncIterable<Uint8Array>,
  options: ArchiveOptions = {},
): AsyncGenerator<ArchiveEvent> {
  const state = new ArchiveState(options);
  checkSignal(options.signal);
  const reader = new StreamReader(source, options.signal),
    frames = new FrameReader(reader, options.signal);
  let failure: Failure | undefined;
  try {
    const magic = await reader.read(MAGIC.length);
    if (!magic.every((byte, index) => byte === MAGIC[index]))
      fail("INVALID", "Unsupported archive magic");
    const first = await frames.next();
    if (first.type !== HEADER) fail("INVALID", "Missing archive manifest");
    const manifest = manifestFor(parseJson(first.payload));
    yield { kind: "manifest", manifest };
    yield* parseEntries(reader, frames, manifest, state, options.signal);
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await reader.close(failure);
  }
}
async function* parseEntries(
  reader: StreamReader,
  frames: FrameReader,
  manifest: ArchiveManifest,
  state: ArchiveState,
  signal?: AbortSignal,
): AsyncGenerator<ArchiveEvent> {
  for (;;) {
    checkSignal(signal);
    const frame = await frames.next();
    if (frame.type === END && state.entries === 0) fail("INVALID", "Missing root");
    if (frame.type === END) {
      validateSummary(frame.payload, state.summary());
      await reader.eof();
      checkSignal(signal);
      yield { kind: "complete", summary: state.summary() };
      return;
    }
    if (frame.type !== ENTRY) fail("INVALID", "Expected entry");
    const entry = entryFor(parseJson(frame.payload), manifest);
    state.accept(entry);
    yield* parseEntry(entry, frames, signal);
  }
}
async function stage(
  event: ArchiveEvent,
  sink: ArchiveStagingSink,
  signal?: AbortSignal,
): Promise<void> {
  checkSignal(signal);
  switch (event.kind) {
    case "manifest":
      return sink.begin(event.manifest, signal);
    case "entry":
      if (event.entry.kind === "symlink") fail("INVALID", "Link import is not supported");
      return sink.entry(event.entry, signal);
    case "data":
      return sink.write(event.bytes, signal);
    case "end-entry":
      return sink.endEntry(signal);
    case "complete":
      return;
  }
  const unexpected: never = event;
  return unexpected;
}
export async function importWorkspaceArchive(
  source: AsyncIterable<Uint8Array>,
  sink: ArchiveStagingSink,
  options: ArchiveOptions = {},
): Promise<ArchiveSummary> {
  try {
    const summary = await stageArchive(source, sink, options);
    checkSignal(options.signal);
    if (!summary) fail("TRUNCATED", "Missing archive end");
    await sink.complete(summary, options.signal);
    return summary;
  } catch (error) {
    await abortStaging(sink, error);
    throw error;
  }
}
async function stageArchive(
  source: AsyncIterable<Uint8Array>,
  sink: ArchiveStagingSink,
  options: ArchiveOptions,
): Promise<ArchiveSummary | undefined> {
  const input = new ArchiveInput(parseWorkspaceArchive(source, options));
  let failure: Failure | undefined;
  let summary: ArchiveSummary | undefined;
  try {
    for (;;) {
      const { result } = await input.next();
      if (result.done) break;
      await stage(result.value, sink, options.signal);
      if (result.value.kind === "complete") summary = result.value.summary;
    }
    return summary;
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await input.close(failure);
  }
}
async function abortStaging(sink: ArchiveStagingSink, error: unknown): Promise<void> {
  try {
    await sink.abort(error);
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "Archive import and staging cleanup failed");
  }
}
