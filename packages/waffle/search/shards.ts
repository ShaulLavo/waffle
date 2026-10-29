import { FilesystemError } from "../core/filesystem.js";
import type { FilesystemConnection, FilesystemIdentity } from "../fs/protocol.js";
import { MissingDataError, MissingSegmentError } from "../fs/shared.js";

/** Grants, opened handles and pending pages share one window per process, across every walk
 * and every shard. It matches the filesystem's outstanding walk-grant bound. */
export const CANDIDATE_CREDITS = 256;
/** Worst-case output reserved by dispatched files and undelivered results. */
export const OUTPUT_WINDOW_BYTES = 64 * 1024 * 1024;
export const BATCH_FILES = 64;
const BATCH_BYTES = 4 * 1024 * 1024;
export const BATCHES_PER_SHARD = 2;
const MAX_SHARDS = 4;
/** Each directRead call is one filesystem section; abort is checked between chunks. */
const READ_CHUNK_BYTES = 1024 * 1024;

// Control cells shared by the host and its shards. Diagnostics are counters, never authority.
export const CONTROL_ABORT = 0;
export const CONTROL_CHUNKS = 1;
const CONTROL_FILES = 2;
export const CONTROL_LIVE_SHARDS = 3;
/** Advanced by each live shard's timer when the launcher asked for diagnostics. */
export const CONTROL_HEARTBEAT = 4;
export const CONTROL_WORDS = 5;

const WASI_EAGAIN = 6;
const WASI_EFBIG = 22;
const WASI_EIO = 29;
const WASI_ENAMETOOLONG = 37;

/** What a shard computes for one complete file. Matching programs join this union. */
export type ShardProgram = { readonly kind: "count-lines" };
export interface ProgramLimits {
  readonly fileBytes: number;
  readonly pathBytes: number;
  /** Upper bound on the bytes one file's result can emit, reserved before dispatch. */
  outputBound(size: number, pathBytes: number): number;
}

export interface ShardFile {
  readonly index: number;
  readonly path: string;
  readonly handle: number;
  readonly size: number;
}
export type FileResult =
  | { readonly kind: "done"; readonly matched: number; readonly output: Uint8Array | null }
  | { readonly kind: "error"; readonly errno: number }
  /** The shared pages were not readable here; the host reads this file through the service. */
  | { readonly kind: "fallback" };
export type IndexedResult = FileResult & { readonly index: number };

export type ShardRequest =
  | {
      readonly type: "start";
      readonly identity: FilesystemIdentity;
      readonly control: SharedArrayBuffer;
      readonly program: ShardProgram;
      readonly fileBytes: number;
      readonly heartbeat: boolean;
    }
  | { readonly type: "batch"; readonly id: number; readonly files: readonly ShardFile[] }
  | { readonly type: "stop" };
export type ShardReply =
  | { readonly type: "ready" }
  | { readonly type: "batch"; readonly id: number; readonly results: readonly IndexedResult[] }
  | { readonly type: "stopped" };

export function errnoOf(error: unknown): number {
  return error instanceof FilesystemError ? error.errno : WASI_EIO;
}

/** The process's own identity: same sections word, revocations and owner token. Never a fork,
 * whose separate sections word the process kill fence would not observe. */
export function processIdentity({
  port: _port,
  requests: _requests,
  residentPublication: _resident,
  ...identity
}: FilesystemConnection): FilesystemIdentity {
  return identity;
}

/** Reads one complete file in bounded chunks into a reusable buffer. */
export class FileReader {
  private buffer = new Uint8Array(64 * 1024);
  constructor(
    private readonly control: Int32Array,
    private readonly fileBytes: number,
  ) {}
  /** Returns the file bytes, or a positive errno. read returns bytes copied or a negative errno. */
  read(read: (chunk: Uint8Array, offset: number) => number): Uint8Array | number {
    let length = 0;
    for (;;) {
      if (Atomics.load(this.control, CONTROL_ABORT)) return WASI_EAGAIN;
      if (length > this.fileBytes) return WASI_EFBIG;
      this.reserve(length + READ_CHUNK_BYTES);
      const count = read(this.buffer.subarray(length, length + READ_CHUNK_BYTES), length);
      Atomics.add(this.control, CONTROL_CHUNKS, 1);
      if (count < 0) return -count;
      length += count;
      if (count < READ_CHUNK_BYTES) break;
    }
    if (length > this.fileBytes) return WASI_EFBIG;
    Atomics.add(this.control, CONTROL_FILES, 1);
    return this.buffer.subarray(0, length);
  }
  private reserve(bytes: number): void {
    if (bytes <= this.buffer.length) return;
    const next = new Uint8Array(Math.max(bytes, this.buffer.length * 2));
    next.set(this.buffer);
    this.buffer = next;
  }
}

function scanFile(program: ShardProgram, bytes: Uint8Array): FileResult {
  switch (program.kind) {
    case "count-lines":
      return { kind: "done", matched: countLines(bytes), output: null };
  }
}

function countLines(bytes: Uint8Array): number {
  let lines = 0;
  for (let at = bytes.indexOf(10); at >= 0; at = bytes.indexOf(10, at + 1)) lines++;
  return bytes.length && bytes[bytes.length - 1] !== 10 ? lines + 1 : lines;
}

/** Reads through a synchronous chunk reader and scans; the shard and inline paths share it. */
export function readAndScan(
  reader: FileReader,
  program: ShardProgram,
  read: (chunk: Uint8Array, offset: number) => number,
): FileResult {
  try {
    const bytes = reader.read(read);
    if (typeof bytes === "number") return { kind: "error", errno: bytes };
    return scanFile(program, bytes);
  } catch (error) {
    if (error instanceof MissingSegmentError || error instanceof MissingDataError)
      return { kind: "fallback" };
    return { kind: "error", errno: errnoOf(error) };
  }
}

/** A granted file, or an entry the walk reports as an error in its output position. */
export type SourceEntry =
  | { readonly kind: "file"; readonly path: string; readonly handle: number; readonly size: number }
  | { readonly kind: "error"; readonly path: string; readonly errno: number };
/** Each candidate holds one credit from acceptance until the source releases it. */
export type Candidate = SourceEntry & { readonly index: number };
type FileCandidate = Extract<Candidate, { kind: "file" }>;
export interface CandidateSource {
  /** Up to `credits` (at least 1) entries in output order: at least one unless done. A
   * walk-backed source passes credits as the page's grant bound. */
  next(credits: number): { readonly entries: readonly SourceEntry[]; readonly done: boolean };
  /** Releases each candidate's grant exactly once. */
  release(files: readonly Candidate[]): void;
  /** Releases traversal state; runs in finally after every outstanding candidate was released. */
  close(): void;
}

/** Runs batches somewhere: nested shard workers, or this thread when they are unavailable. */
export interface BatchExecutor {
  /** Concurrent batch capacity; the dispatcher never exceeds it. */
  readonly capacity: number;
  submit(id: number, files: readonly ShardFile[]): void;
  /** The next finished batch. Called only while a batch is outstanding. */
  next(): Promise<{ readonly id: number; readonly results: readonly IndexedResult[] }>;
  /** Stops every helper outside any filesystem section, then releases it. Idempotent. */
  close(): Promise<void>;
}

export interface SearchSink {
  /** Writes one file's result. Called in candidate order, at most once per candidate. */
  deliver(file: Candidate, result: FileResult): void;
  /** Reads a fallback file through the service on this thread. */
  fallback(file: ShardFile): FileResult;
}

const encoder = new TextEncoder();

/** The host search loop. Every candidate is released exactly once, on delivery or in finally;
 * total outstanding candidates never exceed CANDIDATE_CREDITS, and reserved worst-case output
 * never exceeds OUTPUT_WINDOW_BYTES except for a single file when nothing else is reserved. */
export class SearchRun {
  private readonly outstanding = new Map<number, Candidate>();
  private readonly pending: FileCandidate[] = [];
  private readonly reserved = new Map<number, number>();
  private readonly results = new Map<number, FileResult>();
  private readonly batches = new Map<number, readonly FileCandidate[]>();
  private reservedBytes = 0;
  private nextIndex = 0;
  private delivered = 0;
  private nextBatch = 1;
  private exhausted = false;
  constructor(
    private readonly source: CandidateSource,
    private readonly executor: BatchExecutor,
    private readonly sink: SearchSink,
    private readonly limits: ProgramLimits,
    private readonly checkActive: () => void,
  ) {}
  async run(): Promise<void> {
    try {
      for (;;) {
        this.checkActive();
        this.fill();
        this.dispatch();
        this.deliverReady();
        if (this.exhausted && this.outstanding.size === 0) return;
        if (this.batches.size === 0) continue;
        const finished = await this.executor.next();
        this.complete(finished.id, finished.results);
      }
    } finally {
      await this.executor.close();
      this.releaseAll();
      this.source.close();
    }
  }
  private fill(): void {
    while (!this.exhausted) {
      const credits = CANDIDATE_CREDITS - this.outstanding.size;
      if (credits <= 0) return;
      const page = this.source.next(credits);
      if (page.done) this.exhausted = true;
      if (page.entries.length > credits) throw new RangeError("source exceeded its credits");
      for (let i = 0; i < page.entries.length; i++) this.accept(page.entries[i]!);
      if (!page.entries.length) return;
    }
  }
  private accept(entry: SourceEntry): void {
    const candidate: Candidate = { ...entry, index: this.nextIndex++ };
    this.outstanding.set(candidate.index, candidate);
    if (candidate.kind === "error") {
      this.results.set(candidate.index, { kind: "error", errno: candidate.errno });
      return;
    }
    const errno = this.preflight(candidate);
    if (errno) this.results.set(candidate.index, { kind: "error", errno });
    else this.pending.push(candidate);
  }
  private preflight(file: FileCandidate): number {
    if (encoder.encode(file.path).length > this.limits.pathBytes) return WASI_ENAMETOOLONG;
    return file.size > this.limits.fileBytes ? WASI_EFBIG : 0;
  }
  private dispatch(): void {
    while (this.pending.length && this.batches.size < this.executor.capacity) {
      const batch = this.takeBatch();
      if (!batch.length) return;
      const id = this.nextBatch++;
      this.batches.set(id, batch);
      this.executor.submit(id, batch);
    }
  }
  private takeBatch(): FileCandidate[] {
    const batch: FileCandidate[] = [];
    let bytes = 0;
    while (this.pending.length && batch.length < BATCH_FILES) {
      const file = this.pending[0]!;
      const bound = this.limits.outputBound(file.size, encoder.encode(file.path).length);
      if (this.reservedBytes && this.reservedBytes + bound > OUTPUT_WINDOW_BYTES) break;
      if (batch.length && bytes + file.size > BATCH_BYTES) break;
      this.pending.shift();
      this.reserved.set(file.index, bound);
      this.reservedBytes += bound;
      bytes += file.size;
      batch.push(file);
    }
    return batch;
  }
  private complete(id: number, results: readonly IndexedResult[]): void {
    const batch = this.batches.get(id);
    if (!batch) throw new Error(`unknown search batch ${id}`);
    this.batches.delete(id);
    const expected = new Set(batch.map((file) => file.index));
    for (let i = 0; i < results.length; i++) {
      const { index, ...result } = results[i]!;
      if (!expected.delete(index)) throw new Error(`batch ${id} returned file ${index} twice`);
      this.results.set(index, result);
    }
    if (expected.size) throw new Error(`batch ${id} omitted ${expected.size} files`);
  }
  private deliverReady(): void {
    const done: Candidate[] = [];
    try {
      for (let result = this.results.get(this.delivered); result;) {
        const file = this.outstanding.get(this.delivered)!;
        this.results.delete(this.delivered);
        this.delivered++;
        done.push(file);
        this.sink.deliver(
          file,
          result.kind === "fallback" && file.kind === "file" ? this.sink.fallback(file) : result,
        );
        result = this.results.get(this.delivered);
      }
    } finally {
      this.release(done);
    }
  }
  private release(files: readonly Candidate[]): void {
    if (!files.length) return;
    for (let i = 0; i < files.length; i++) {
      const index = files[i]!.index;
      this.outstanding.delete(index);
      this.reservedBytes -= this.reserved.get(index) ?? 0;
      this.reserved.delete(index);
    }
    this.source.release(files);
  }
  private releaseAll(): void {
    const remaining = Array.from(this.outstanding.values());
    this.results.clear();
    this.pending.length = 0;
    this.batches.clear();
    for (let at = 0; at < remaining.length; at += CANDIDATE_CREDITS)
      this.release(remaining.slice(at, at + CANDIDATE_CREDITS));
  }
}

/** Default shard count for this host, fixed before any search starts. */
export function defaultShardCount(): number {
  const cores = typeof navigator === "object" ? (navigator.hardwareConcurrency ?? 1) : 1;
  return Math.min(MAX_SHARDS, Math.max(1, cores - 2));
}

/** Absent nested Worker support is a capability, not an error: the host scans inline. */
export function nestedWorkersAvailable(): boolean {
  return typeof Worker === "function";
}

export class InlineExecutor implements BatchExecutor {
  readonly capacity = 1;
  private queued: { id: number; files: readonly ShardFile[] } | undefined;
  private readonly reader: FileReader;
  constructor(
    private readonly program: ShardProgram,
    control: Int32Array,
    fileBytes: number,
    private readonly read: (file: ShardFile, chunk: Uint8Array, offset: number) => number,
  ) {
    this.reader = new FileReader(control, fileBytes);
  }
  submit(id: number, files: readonly ShardFile[]): void {
    if (this.queued) throw new Error("inline search runs one batch at a time");
    this.queued = { id, files };
  }
  async next() {
    const batch = this.queued;
    if (!batch) throw new Error("no inline search batch is outstanding");
    this.queued = undefined;
    const results = batch.files.map((file) => ({
      index: file.index,
      ...readAndScan(this.reader, this.program, (chunk, offset) => this.read(file, chunk, offset)),
    }));
    return { id: batch.id, results };
  }
  async close(): Promise<void> {
    this.queued = undefined;
  }
}

interface ShardState {
  readonly worker: Worker;
  batches: number;
  ready: boolean;
  stopped: boolean;
}

/** Nested shard workers owned by the process worker. Terminating the process worker
 * terminates them; the pool itself terminates a shard only after it acknowledged stop, which
 * it sends from its event loop and therefore outside every filesystem section. */
export class ShardPool implements BatchExecutor {
  readonly capacity: number;
  private readonly shards: ShardState[] = [];
  private readonly owners = new Map<number, ShardState>();
  private readonly finished: { id: number; results: readonly IndexedResult[] }[] = [];
  private failure: Error | undefined;
  private wake: (() => void) | undefined;
  private closing: Promise<void> | undefined;
  private constructor(
    count: number,
    private readonly control: Int32Array,
  ) {
    this.capacity = count * BATCHES_PER_SHARD;
  }
  static async start(
    url: string,
    count: number,
    start: Extract<ShardRequest, { type: "start" }>,
  ): Promise<ShardPool> {
    const pool = new ShardPool(count, new Int32Array(start.control));
    try {
      for (let i = 0; i < count; i++) pool.spawn(url, start);
      await pool.until(() => pool.shards.every((shard) => shard.ready));
      return pool;
    } catch (error) {
      await pool.close();
      throw error;
    }
  }
  private spawn(url: string, start: ShardRequest): void {
    const shard: ShardState = {
      worker: new Worker(url, { type: "module", name: "waffle-search-shard" }),
      batches: 0,
      ready: false,
      stopped: false,
    };
    this.shards.push(shard);
    shard.worker.onmessage = ({ data }: MessageEvent<ShardReply>) => this.receive(shard, data);
    shard.worker.onerror = (event) => {
      event.preventDefault();
      // An uncaught error unwinds directRead's finally, so the shard holds no section.
      shard.stopped = true;
      this.fail(new Error(`search shard failed: ${event.message}`));
    };
    shard.worker.postMessage(start);
  }
  private receive(shard: ShardState, reply: ShardReply): void {
    if (reply.type === "ready") shard.ready = true;
    else if (reply.type === "stopped") shard.stopped = true;
    else {
      shard.batches--;
      this.owners.delete(reply.id);
      this.finished.push(reply);
    }
    this.wake?.();
  }
  private fail(error: Error): void {
    this.failure ??= error;
    this.wake?.();
  }
  private async until(ready: () => boolean): Promise<void> {
    while (!ready()) {
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
  submit(id: number, files: readonly ShardFile[]): void {
    let target = this.shards[0]!;
    for (let i = 1; i < this.shards.length; i++)
      if (this.shards[i]!.batches < target.batches) target = this.shards[i]!;
    if (target.batches >= BATCHES_PER_SHARD) throw new Error("search shards are saturated");
    target.batches++;
    this.owners.set(id, target);
    target.worker.postMessage({ type: "batch", id, files } satisfies ShardRequest);
  }
  async next() {
    await this.until(() => this.finished.length > 0);
    return this.finished.shift()!;
  }
  close(): Promise<void> {
    return (this.closing ??= this.stop());
  }
  private async stop(): Promise<void> {
    Atomics.store(this.control, CONTROL_ABORT, 1);
    for (let i = 0; i < this.shards.length; i++)
      this.shards[i]!.worker.postMessage({ type: "stop" } satisfies ShardRequest);
    this.failure = undefined;
    try {
      await this.until(() => this.shards.every((shard) => shard.stopped));
    } finally {
      for (let i = 0; i < this.shards.length; i++)
        if (this.shards[i]!.stopped) this.shards[i]!.worker.terminate();
    }
  }
}
