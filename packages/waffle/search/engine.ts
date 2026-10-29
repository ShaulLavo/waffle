import type { HostProgramContext, RuntimeWorkerRequest } from "../browser/worker.js";
import { WasiExit } from "../core/wasi.js";
import type { WalkCursor, WalkEntry } from "../fs/walk.js";
import { compileMatcher } from "./matcher.js";
import {
  BATCHES_PER_SHARD,
  CONTROL_WORDS,
  FileReader,
  InlineExecutor,
  SearchRun,
  ShardPool,
  defaultShardCount,
  errnoOf,
  nestedWorkersAvailable,
  processIdentity,
  processFence,
  readAndScan,
  type BatchExecutor,
  type Candidate,
  type CandidateSource,
  type FileResult,
  type ProgramLimits,
  type ShardFile,
  type ShardProgram,
  type SourceEntry,
} from "./shards.js";
import { SEARCH_LIMITS, type OutputPlan, type SearchPlan } from "./types.js";

export interface SearchWorkerRequest extends RuntimeWorkerRequest {
  readonly plan: SearchPlan;
  readonly search: {
    readonly shardWorker: string;
    readonly shards: number | null;
    readonly diagnostics: boolean;
  };
}

type SearchContext = HostProgramContext<SearchWorkerRequest>;
type SourceContext = Pick<SearchContext, "open" | "checkActive"> & {
  readonly request: Pick<SearchWorkerRequest, "plan">;
  readonly fs: Pick<
    SearchContext["fs"],
    "walkOpen" | "walkPage" | "walkRelease" | "walkClose" | "release"
  >;
};
type Lease =
  | { readonly kind: "open"; readonly handle: number }
  | { readonly kind: "walk"; readonly token: number };
interface ActiveWalk {
  readonly original: WalkCursor;
  readonly path: string;
  cursor: WalkCursor | null;
  grants: number;
}

function displayPath(root: string, relative: string, tool: SearchPlan["tool"]): string {
  const prefix = tool === "grep" ? root.replace(/\/+$/, "/") : root;
  return prefix.endsWith("/") ? `${prefix}${relative}` : `${prefix}/${relative}`;
}

/** One source belongs to one SearchRun. Its entry sequence is SearchRun's candidate index. */
export class WalkSource implements CandidateSource {
  private readonly leases = new Map<number, Lease>();
  private readonly operandErrors = new Set<number>();
  private index = 0;
  private operand = 0;
  private walk: ActiveWalk | undefined;
  constructor(private readonly context: SourceContext) {}

  next(credits: number): { entries: readonly SourceEntry[]; done: boolean } {
    const entries: SourceEntry[] = [];
    while (entries.length < credits) {
      this.context.checkActive();
      if (this.walk) this.page(entries, credits - entries.length);
      else if (this.operand < this.context.request.plan.operands.length) this.open(entries);
      else break;
      if (this.walk?.cursor === null) break;
    }
    return {
      entries,
      done: !this.walk && this.operand >= this.context.request.plan.operands.length,
    };
  }

  isOperandError(index: number): boolean {
    return this.operandErrors.has(index);
  }

  release(files: readonly Candidate[]): void {
    const errors: unknown[] = [];
    this.releaseIndices(
      files.map((file) => file.index),
      errors,
    );
    this.retireWalk(errors);
    for (const file of files) this.operandErrors.delete(file.index);
    if (errors.length) throw new AggregateError(errors, "search candidate release failed");
  }

  close(): void {
    const errors: unknown[] = [];
    this.releaseIndices(Array.from(this.leases.keys()), errors);
    if (this.walk) this.closeWalk(errors);
    if (errors.length) throw new AggregateError(errors, "search source close failed");
  }

  private add(entries: SourceEntry[], entry: SourceEntry, lease?: Lease): void {
    if (lease) this.leases.set(this.index, lease);
    this.index++;
    entries.push(entry);
  }

  private open(entries: SourceEntry[]): void {
    const path = this.context.request.plan.operands[this.operand++]!;
    try {
      const opened = this.context.open(path);
      if (typeof opened === "number") {
        this.operandErrors.add(this.index);
        this.add(entries, { kind: "error", path, errno: -opened });
        return;
      }
      if (opened.kind === "file") {
        this.add(
          entries,
          { kind: "file", path, handle: opened.handle, size: opened.size },
          { kind: "open", handle: opened.handle },
        );
        return;
      }
      this.openWalk(path, opened.handle);
    } catch (error) {
      this.operandErrors.add(this.index);
      this.add(entries, { kind: "error", path, errno: errnoOf(error) });
    }
  }

  private openWalk(path: string, handle: number): void {
    try {
      const original = this.context.fs.walkOpen(handle, this.context.request.plan.walk);
      this.walk = { original, path, cursor: original, grants: 0 };
    } finally {
      this.context.fs.release(handle);
    }
  }

  private page(entries: SourceEntry[], credits: number): void {
    const walk = this.walk;
    if (!walk?.cursor) return;
    try {
      const page = this.context.fs.walkPage(walk.cursor, {
        grant: true,
        maxEntries: Math.min(128, credits),
      });
      walk.cursor = page.next;
      for (const entry of page.entries) this.walkEntry(entries, walk, entry);
    } catch (error) {
      walk.cursor = null;
      this.add(entries, { kind: "error", path: walk.path, errno: errnoOf(error) });
    }
    this.retireWalk([]);
  }

  private walkEntry(entries: SourceEntry[], walk: ActiveWalk, entry: WalkEntry): void {
    const path = displayPath(walk.path, entry.path, this.context.request.plan.tool);
    if (entry.kind === "error") {
      this.add(entries, { ...entry, path });
      return;
    }
    if (entry.handle === null || entry.grant === null)
      throw new Error("search walk omitted a grant");
    walk.grants++;
    this.add(
      entries,
      { kind: "file", path, handle: entry.handle, size: entry.size },
      { kind: "walk", token: entry.grant },
    );
  }

  private releaseIndices(indices: readonly number[], errors: unknown[]): void {
    const tokens: number[] = [];
    const granted: number[] = [];
    for (const index of indices) {
      const lease = this.leases.get(index);
      if (!lease) continue;
      if (lease.kind === "open") this.releaseOpen(index, lease.handle, errors);
      else {
        tokens.push(lease.token);
        granted.push(index);
      }
    }
    if (!tokens.length) return;
    try {
      this.context.fs.walkRelease(tokens);
      for (const index of granted) this.leases.delete(index);
      if (this.walk) this.walk.grants -= tokens.length;
    } catch (error) {
      errors.push(error);
    }
  }

  private releaseOpen(index: number, handle: number, errors: unknown[]): void {
    try {
      this.context.fs.release(handle);
      this.leases.delete(index);
    } catch (error) {
      errors.push(error);
    }
  }

  private retireWalk(errors: unknown[]): void {
    if (this.walk?.cursor === null && this.walk.grants === 0) this.closeWalk(errors);
    if (errors.length) throw new AggregateError(errors, "search walk cleanup failed");
  }

  private closeWalk(errors: unknown[]): void {
    const walk = this.walk;
    if (!walk) return;
    try {
      this.context.fs.walkClose(walk.original);
      this.walk = undefined;
    } catch (error) {
      errors.push(error);
    }
  }
}

const encoder = new TextEncoder();
const ERRORS: Readonly<Record<number, readonly [string, number]>> = {
  2: ["Permission denied", 13],
  6: ["Resource temporarily unavailable", 11],
  8: ["Bad file descriptor", 9],
  22: ["File too large", 27],
  29: ["Input/output error", 5],
  37: ["File name too long", 36],
  44: ["No such file or directory", 2],
  54: ["Not a directory", 20],
  76: ["Permission denied", 13],
};

export function outputBound(output: OutputPlan, size: number, pathBytes: number): number {
  if (output.kind === "files-with-matches") return pathBytes + 1;
  if (output.kind === "count") return (output.withFilename ? pathBytes + 1 : 0) + 24;
  const prefix = (output.withFilename ? pathBytes + 1 : 0) + (output.lineNumbers ? 9 : 0);
  return Math.min(SEARCH_LIMITS.outputBytes, size + size * prefix + 1);
}

class MatchSink {
  private matched = false;
  private failed = false;
  private readonly reader: FileReader;
  constructor(
    private readonly context: SearchContext,
    private readonly program: ShardProgram,
    private readonly source: WalkSource,
    cells: Int32Array,
  ) {
    this.reader = new FileReader(cells, SEARCH_LIMITS.fileBytes);
  }
  get status(): number {
    return this.failed ? 2 : this.matched ? 0 : 1;
  }
  deliver(file: Candidate, result: FileResult): void {
    this.context.checkActive();
    if (result.kind === "done") {
      this.matched ||= result.matched > 0;
      if (result.output) this.write(1, result.output);
      return;
    }
    this.failed = true;
    const errno = result.kind === "error" ? result.errno : 29;
    const error = ERRORS[errno] ?? [`errno ${errno}`, 5];
    const suffix = this.context.request.plan.tool === "rg" ? ` (os error ${error[1]})` : "";
    const operation =
      this.context.request.plan.tool === "rg" && this.source.isOperandError(file.index)
        ? `IO error for operation on ${file.path}: `
        : "";
    this.write(
      2,
      encoder.encode(
        `${this.context.request.plan.tool}: ${file.path}: ${operation}${error[0]}${suffix}\n`,
      ),
    );
  }
  fallback(file: ShardFile): FileResult {
    return readAndScan(
      this.reader,
      this.program,
      (chunk, offset) => this.context.fs.read(file.handle, [chunk], offset),
      file.path,
    );
  }
  private write(fd: 1 | 2, bytes: Uint8Array): void {
    const written = this.context.write(fd, bytes);
    if (written >= 0) return;
    if (written === -64) this.context.defaultSignal(13);
    throw new WasiExit(2);
  }
}

async function executor(
  context: SearchContext,
  control: SharedArrayBuffer,
  program: ShardProgram,
): Promise<BatchExecutor> {
  const options = context.request.search;
  const count = options.shards ?? defaultShardCount();
  if (count === 0 || !nestedWorkersAvailable() || context.request.filesystem.residentPublication)
    return new InlineExecutor(
      program,
      new Int32Array(control),
      SEARCH_LIMITS.fileBytes,
      (file, chunk, offset) => context.fs.read(file.handle, [chunk], offset),
    );
  const identity = processIdentity(context.request.filesystem);
  return ShardPool.start({
    url: options.shardWorker,
    count,
    start: {
      type: "start",
      identity,
      control,
      program,
      fileBytes: SEARCH_LIMITS.fileBytes,
      heartbeat: options.diagnostics,
    },
    fence: () => processFence(identity),
  });
}

export async function runSearch(context: SearchContext): Promise<number> {
  const { plan, env } = context.request;
  const admission = compileMatcher(
    plan.matcher,
    plan.tool,
    env.LC_ALL || env.LC_CTYPE || env.LANG || "C",
  );
  if (admission.kind === "fallback")
    throw new Error("search plan was not admitted before host launch");
  const program: ShardProgram = { kind: "search", matcher: admission.matcher, output: plan.output };
  const control = new SharedArrayBuffer(CONTROL_WORDS * 4);
  const source = new WalkSource(context);
  let batches: BatchExecutor;
  try {
    batches = await executor(context, control, program);
  } catch (error) {
    source.close();
    throw error;
  }
  if (context.request.search.diagnostics)
    globalThis.postMessage({
      type: "search-diagnostics",
      control,
      shards: batches instanceof InlineExecutor ? 0 : batches.capacity / BATCHES_PER_SHARD,
    });
  const sink = new MatchSink(context, program, source, new Int32Array(control));
  const limits: ProgramLimits = {
    fileBytes: SEARCH_LIMITS.fileBytes,
    pathBytes: SEARCH_LIMITS.pathBytes,
    outputBound: (size, pathBytes) => outputBound(plan.output, size, pathBytes),
  };
  await new SearchRun(source, batches, sink, limits, context.checkActive).run();
  return sink.status;
}
