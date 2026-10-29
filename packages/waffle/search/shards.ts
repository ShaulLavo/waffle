import { FilesystemError } from "../core/filesystem.js";
import {
  revokeFilesystem,
  type FilesystemConnection,
  type FilesystemIdentity,
} from "../fs/protocol.js";
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
/** Set when close() had to retire helpers through the process filesystem fence. */
export const CONTROL_FENCED = 5;
export const CONTROL_WORDS = 6;

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
      /** This helper's word in liveness, advanced by its timer and by every read chunk. */
      readonly slot: number;
      readonly liveness: SharedArrayBuffer;
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

/** Revokes the process's filesystem identity, then waits for its sections word to reach zero:
 * from then on no helper can touch storage. It polls, so it needs no Atomics.waitAsync, and it
 * returns at once if the identity was already reaped. */
export async function processFence(identity: FilesystemIdentity): Promise<void> {
  revokeFilesystem(identity);
  const sections = new Int32Array(identity.sections);
  const revocation = new Int32Array(identity.revocations[0]!);
  while (Atomics.load(sections, 0) !== 0 && Atomics.load(revocation, 0) !== 2)
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
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
  /** Retires every helper: each acknowledged stop, or the process fence proved none can enter
   * a filesystem section, and then each was terminated. Settles only after that; rejects
   * after a fenced retirement. Idempotent. */
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
  /** Rejects with the loop's error, or with an AggregateError whose first entry is that
   * error (when there is one) followed by every cleanup failure. */
  async run(): Promise<void> {
    let failure: { readonly error: unknown } | undefined;
    try {
      await this.loop();
    } catch (error) {
      failure = { error };
    }
    const cleanup = await this.retire();
    if (cleanup.length)
      throw new AggregateError(
        failure ? [failure.error].concat(cleanup) : cleanup,
        "search cleanup failed",
        failure ? { cause: failure.error } : undefined,
      );
    if (failure) throw failure.error;
  }
  private async loop(): Promise<void> {
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
  }
  /** Helpers first: grants are released only once no helper can read them. The source's
   * close (the walk's original cursor) is attempted on every path and reclaims any grant a
   * failed release left behind. */
  private async retire(): Promise<unknown[]> {
    const errors: unknown[] = [];
    try {
      await this.executor.close();
    } catch (error) {
      errors.push(error);
    }
    this.releaseAll(errors);
    try {
      this.source.close();
    } catch (error) {
      errors.push(error);
    }
    return errors;
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
    } catch (error) {
      const errors: unknown[] = [error];
      this.releaseOnce(done, errors);
      throw errors.length > 1 ? new AggregateError(errors, "search delivery failed") : error;
    }
    this.release(done);
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
  /** A failed release forgets its candidates: retrying could release a grant twice. */
  private releaseOnce(files: readonly Candidate[], errors: unknown[]): void {
    try {
      this.release(files);
    } catch (error) {
      errors.push(error);
    }
  }
  private releaseAll(errors: unknown[]): void {
    const remaining = Array.from(this.outstanding.values());
    this.results.clear();
    this.pending.length = 0;
    this.batches.clear();
    for (let at = 0; at < remaining.length; at += CANDIDATE_CREDITS)
      this.releaseOnce(remaining.slice(at, at + CANDIDATE_CREDITS), errors);
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

type ShardPhase = "starting" | "ready" | "stopping" | "stopped";
interface ShardState {
  readonly slot: number;
  readonly worker: Worker;
  batches: number;
  phase: ShardPhase;
  /** When the current phase began: startup and stop deadlines run from here. */
  phaseAt: number;
  /** Last observed liveness word and when it last changed. */
  progress: number;
  progressAt: number;
  failed: boolean;
}

export type ShardFailureReason =
  | "error"
  | "messageerror"
  | "start-timeout"
  | "unresponsive"
  | "stop-unacknowledged"
  | "undeliverable";
export interface ShardFailure {
  readonly shard: number;
  readonly reason: ShardFailureReason;
  readonly detail: string;
}
/** A helper failed. "owned": the pool still owns every helper and close() must retire them.
 * "fenced": close() revoked the process filesystem, observed zero sections, then terminated
 * every helper, so none can touch storage again. */
export class ShardPoolError extends Error {
  constructor(
    readonly failures: readonly ShardFailure[],
    readonly retirement: "owned" | "fenced",
  ) {
    super(
      `search shards failed (${retirement}): ${failures
        .map((failure) => `shard ${failure.shard} ${failure.reason}: ${failure.detail}`)
        .join("; ")}`,
    );
  }
}

/** Deadlines only trigger the process fence; they never certify that a helper stopped. */
export interface ShardTiming {
  readonly startup: number;
  /** A helper owing a reply whose liveness word stays flat this long has failed. */
  readonly liveness: number;
  /** A helper that has not acknowledged stop within this long has failed. */
  readonly stopAck: number;
  readonly poll: number;
}
const SHARD_TIMING: ShardTiming = {
  startup: 30_000,
  liveness: 3_000,
  stopAck: 3_000,
  poll: 100,
};
type ShardStart = Omit<Extract<ShardRequest, { type: "start" }>, "slot" | "liveness">;
export interface ShardPoolOptions {
  readonly url: string;
  readonly count: number;
  readonly start: ShardStart;
  /** The owning process's revoke-then-zero-sections fence. After it resolves, no helper can
   * enter a filesystem section, so terminating any of them is safe. */
  readonly fence: () => Promise<void>;
  readonly timing?: ShardTiming;
}

const now = () => performance.now();

/** Nested shard workers owned by the process worker. A helper is terminated only after it
 * acknowledged stop from its event loop, outside every filesystem section, or after the
 * process fence proved no helper can enter one. close() settles only after every helper was
 * terminated on one of those two grounds; an error is never a stop acknowledgement. */
export class ShardPool implements BatchExecutor {
  readonly capacity: number;
  private readonly shards: ShardState[] = [];
  private readonly finished: { id: number; results: readonly IndexedResult[] }[] = [];
  private readonly failures: ShardFailure[] = [];
  private readonly control: Int32Array;
  private readonly liveness: Int32Array;
  private readonly timing: ShardTiming;
  private wake: (() => void) | undefined;
  private closing: Promise<void> | undefined;
  private constructor(private readonly options: ShardPoolOptions) {
    this.capacity = options.count * BATCHES_PER_SHARD;
    this.control = new Int32Array(options.start.control);
    this.liveness = new Int32Array(new SharedArrayBuffer(options.count * 4));
    this.timing = options.timing ?? SHARD_TIMING;
  }
  static async start(options: ShardPoolOptions): Promise<ShardPool> {
    const pool = new ShardPool(options);
    try {
      for (let slot = 0; slot < options.count; slot++) pool.spawn(slot);
      await pool.until(() => pool.shards.every((shard) => shard.phase !== "starting"));
      return pool;
    } catch (error) {
      await pool.close().catch(() => {});
      throw error;
    }
  }
  private spawn(slot: number): void {
    const at = now();
    const shard: ShardState = {
      slot,
      worker: new Worker(this.options.url, { type: "module", name: "waffle-search-shard" }),
      batches: 0,
      phase: "starting",
      phaseAt: at,
      progress: 0,
      progressAt: at,
      failed: false,
    };
    this.shards.push(shard);
    shard.worker.onmessage = ({ data }: MessageEvent<ShardReply>) => this.receive(shard, data);
    shard.worker.onerror = (event) => {
      event.preventDefault();
      // An uncaught error does not close the helper or drop its queued work. It stays owned.
      this.fail(shard, "error", event.message);
    };
    shard.worker.onmessageerror = () => this.fail(shard, "messageerror", "unreadable reply");
    this.post(shard, {
      ...this.options.start,
      slot,
      liveness: this.liveness.buffer as SharedArrayBuffer,
    });
  }
  private post(shard: ShardState, request: ShardRequest): void {
    try {
      shard.worker.postMessage(request);
    } catch (error) {
      this.fail(shard, "undeliverable", String(error));
    }
  }
  private receive(shard: ShardState, reply: ShardReply): void {
    if (reply.type === "ready") this.enter(shard, "ready");
    else if (reply.type === "stopped") this.enter(shard, "stopped");
    else {
      shard.batches--;
      this.finished.push(reply);
    }
    this.wake?.();
  }
  private enter(shard: ShardState, phase: ShardPhase): void {
    shard.phase = phase;
    shard.phaseAt = shard.progressAt = now();
  }
  private fail(shard: ShardState, reason: ShardFailureReason, detail: string): void {
    if (shard.failed) return;
    shard.failed = true;
    this.failures.push({ shard: shard.slot, reason, detail });
    this.wake?.();
  }
  /** Turns a missed deadline into a failure. Never marks a helper stopped. */
  private watch(): void {
    const at = now();
    for (let i = 0; i < this.shards.length; i++) this.watchShard(this.shards[i]!, at);
  }
  private watchShard(shard: ShardState, at: number): void {
    if (shard.failed || shard.phase === "stopped") return;
    const progress = Atomics.load(this.liveness, shard.slot);
    if (progress !== shard.progress) {
      shard.progress = progress;
      shard.progressAt = at;
    }
    if (shard.phase === "starting" && at - shard.phaseAt > this.timing.startup)
      this.fail(shard, "start-timeout", `no ready after ${this.timing.startup} ms`);
    else if (shard.phase === "stopping" && at - shard.phaseAt > this.timing.stopAck)
      this.fail(
        shard,
        "stop-unacknowledged",
        `no stop acknowledgement after ${this.timing.stopAck} ms`,
      );
    else if (this.owes(shard) && at - shard.progressAt > this.timing.liveness)
      this.fail(shard, "unresponsive", `no progress for ${this.timing.liveness} ms`);
  }
  private owes(shard: ShardState): boolean {
    return shard.phase === "stopping" || (shard.phase === "ready" && shard.batches > 0);
  }
  private sleep(): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, this.timing.poll);
      this.wake = done;
    });
  }
  private async until(ready: () => boolean): Promise<void> {
    for (;;) {
      this.watch();
      if (this.failures.length) throw new ShardPoolError(this.failures.slice(), "owned");
      if (ready()) return;
      await this.sleep();
    }
  }
  submit(id: number, files: readonly ShardFile[]): void {
    let target = this.shards[0]!;
    for (let i = 1; i < this.shards.length; i++)
      if (this.shards[i]!.batches < target.batches) target = this.shards[i]!;
    if (target.batches >= BATCHES_PER_SHARD) throw new Error("search shards are saturated");
    // A helper's idle time is not a stall: its liveness clock starts at dispatch.
    if (target.batches === 0) target.progressAt = now();
    target.batches++;
    this.post(target, { type: "batch", id, files });
  }
  async next() {
    await this.until(() => this.finished.length > 0);
    return this.finished.shift()!;
  }
  close(): Promise<void> {
    return (this.closing ??= this.retire());
  }
  private async retire(): Promise<void> {
    Atomics.store(this.control, CONTROL_ABORT, 1);
    for (let i = 0; i < this.shards.length; i++) this.requestStop(this.shards[i]!);
    while (!this.failures.length && !this.shards.every((shard) => shard.phase === "stopped")) {
      await this.sleep();
      this.watch();
    }
    if (this.failures.length) {
      await this.options.fence();
      Atomics.store(this.control, CONTROL_FENCED, 1);
    }
    for (let i = 0; i < this.shards.length; i++) this.shards[i]!.worker.terminate();
    if (this.failures.length) throw new ShardPoolError(this.failures.slice(), "fenced");
  }
  private requestStop(shard: ShardState): void {
    if (shard.phase === "stopped") return;
    this.enter(shard, "stopping");
    this.post(shard, { type: "stop" });
  }
}
