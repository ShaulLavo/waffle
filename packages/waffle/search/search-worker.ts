import {
  bootstrap,
  type HostProgramContext,
  type HostProgramExecutor,
  type RuntimeWorkerRequest,
} from "../browser/worker.js";
import { WasiExit } from "../core/wasi.js";
import type { DirectoryEntry } from "../core/filesystem.js";
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
  processFence,
  processIdentity,
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

export interface SearchWorkerRequest extends RuntimeWorkerRequest {
  readonly search: {
    /** URL of the bundler-emitted shard worker entry. */
    readonly shardWorker: string;
    /** null selects defaultShardCount(); 0 scans on the process thread. */
    readonly shards: number | null;
    /** Post the control cells to the launcher as { type: "search-diagnostics" }. */
    readonly diagnostics: boolean;
  };
}
export interface SearchDiagnosticsMessage {
  readonly type: "search-diagnostics";
  readonly control: SharedArrayBuffer;
  readonly shards: number;
}

// Captured before any later code in this realm runs. Only Waffle code runs here.
const postToLauncher = globalThis.postMessage.bind(globalThis) as (
  message: SearchDiagnosticsMessage,
) => void;

const WASI_EPIPE = 64;
const SIGPIPE = 13;
const FILE_BYTES = 16 * 1024 * 1024;
const COUNT_LIMITS: ProgramLimits = {
  fileBytes: FILE_BYTES,
  pathBytes: 4096,
  outputBound: (_size, pathBytes) => pathBytes + 24,
};
const COUNT: ShardProgram = { kind: "count-lines" };
const MESSAGES: Record<number, string> = {
  2: "Permission denied",
  6: "Resource temporarily unavailable",
  8: "Bad file descriptor",
  22: "File too large",
  37: "File name too long",
  44: "No such file or directory",
  54: "Not a directory",
  76: "Permission denied",
};
const encoder = new TextEncoder();

function joinPath(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

interface Listing {
  readonly path: string;
  readonly handle: number;
  readonly entries: readonly DirectoryEntry[];
  at: number;
}

/** Operands, then a depth-first readdir walk in name order. One request per open and listing:
 * the scaffold until the filesystem's paged walk replaces it with the same entries. */
class DirectorySource implements CandidateSource {
  private readonly stack: Listing[] = [];
  private operand = 0;
  constructor(
    private readonly context: HostProgramContext<SearchWorkerRequest>,
    private readonly operands: readonly string[],
  ) {}
  next(credits: number) {
    const entries: SourceEntry[] = [];
    while (entries.length < credits && !this.done()) this.step(entries);
    return { entries, done: this.done() };
  }
  release(files: readonly Candidate[]): void {
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      if (file.kind === "file") this.context.fs.release(file.handle);
    }
  }
  close(): void {
    while (this.stack.length) this.context.fs.release(this.stack.pop()!.handle);
  }
  private done(): boolean {
    return !this.stack.length && this.operand >= this.operands.length;
  }
  private step(entries: SourceEntry[]): void {
    const top = this.stack.at(-1);
    if (!top) {
      this.openOperand(this.operands[this.operand++]!, entries);
      return;
    }
    if (top.at >= top.entries.length) {
      this.stack.pop();
      this.context.fs.release(top.handle);
      return;
    }
    this.visit(top, top.entries[top.at++]!, entries);
  }
  private openOperand(path: string, entries: SourceEntry[]): void {
    const opened = this.context.open(path);
    if (typeof opened === "number") entries.push({ kind: "error", path, errno: -opened });
    else if (opened.kind === "file")
      entries.push({ kind: "file", path, handle: opened.handle, size: opened.size });
    else this.list(path, opened.handle, entries);
  }
  private visit(parent: Listing, entry: DirectoryEntry, entries: SourceEntry[]): void {
    if (entry.name === "." || entry.name === "..") return;
    if (entry.kind !== "file" && entry.kind !== "directory") return;
    const fs = this.context.fs;
    const path = joinPath(parent.path, entry.name);
    const resolved = fs.resolve(parent.handle, entry.name);
    if (typeof resolved === "number" || resolved.node === undefined) {
      entries.push({ kind: "error", path, errno: typeof resolved === "number" ? resolved : 44 });
      return;
    }
    fs.retain(resolved.node);
    if (entry.kind === "directory") {
      this.list(path, resolved.node, entries);
      return;
    }
    try {
      entries.push({
        kind: "file",
        path,
        handle: resolved.node,
        size: fs.stat(resolved.node).size,
      });
    } catch (error) {
      fs.release(resolved.node);
      entries.push({ kind: "error", path, errno: errnoOf(error) });
    }
  }
  private list(path: string, handle: number, entries: SourceEntry[]): void {
    try {
      const listing = this.context.fs.readdir(handle);
      listing.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      this.stack.push({ path, handle, entries: listing, at: 0 });
    } catch (error) {
      this.context.fs.release(handle);
      entries.push({ kind: "error", path, errno: errnoOf(error) });
    }
  }
}

class CountSink {
  status = 0;
  private readonly reader: FileReader;
  constructor(
    private readonly context: HostProgramContext<SearchWorkerRequest>,
    control: Int32Array,
  ) {
    this.reader = new FileReader(control, FILE_BYTES);
  }
  deliver(file: Candidate, result: FileResult): void {
    if (result.kind === "done") {
      this.write(1, `${file.path}:${result.matched}\n`);
      return;
    }
    const errno = result.kind === "error" ? result.errno : 29;
    this.status = 2;
    this.write(2, `count: ${file.path}: ${MESSAGES[errno] ?? `errno ${errno}`}\n`);
  }
  fallback(file: ShardFile): FileResult {
    return readAndScan(this.reader, COUNT, (chunk, offset) =>
      this.context.fs.read(file.handle, [chunk], offset),
    );
  }
  private write(fd: 1 | 2, text: string): void {
    const result = this.context.write(fd, encoder.encode(text));
    if (result >= 0) return;
    if (result === -WASI_EPIPE) this.context.defaultSignal(SIGPIPE);
    throw new WasiExit(2);
  }
}

async function executor(
  context: HostProgramContext<SearchWorkerRequest>,
  control: SharedArrayBuffer,
): Promise<BatchExecutor> {
  const options = context.request.search;
  const connection = context.request.filesystem;
  const count = options.shards ?? defaultShardCount();
  const cells = new Int32Array(control);
  if (count === 0 || !nestedWorkersAvailable() || connection.residentPublication)
    return new InlineExecutor(COUNT, cells, FILE_BYTES, (file, chunk, offset) =>
      context.fs.read(file.handle, [chunk], offset),
    );
  const identity = processIdentity(connection);
  return ShardPool.start({
    url: options.shardWorker,
    count,
    start: {
      type: "start",
      identity,
      control,
      program: COUNT,
      fileBytes: FILE_BYTES,
      heartbeat: options.diagnostics,
    },
    fence: () => processFence(identity),
  });
}

/** count PATH...: newline-terminated record counts per file, in walk order. The trivial host
 * program that proves the process, shard and filesystem contracts before matching lands. */
async function countProgram(context: HostProgramContext<SearchWorkerRequest>): Promise<number> {
  const control = new SharedArrayBuffer(CONTROL_WORDS * 4);
  const operands = context.request.args.slice(1);
  const source = new DirectorySource(context, operands.length ? operands : ["."]);
  let batches: BatchExecutor;
  try {
    batches = await executor(context, control);
  } catch (error) {
    source.close();
    throw error;
  }
  const inline = batches instanceof InlineExecutor;
  if (context.request.search.diagnostics)
    postToLauncher({
      type: "search-diagnostics",
      control,
      shards: inline ? 0 : batches.capacity / BATCHES_PER_SHARD,
    });
  const sink = new CountSink(context, new Int32Array(control));
  await new SearchRun(source, batches, sink, COUNT_LIMITS, context.checkActive).run();
  return sink.status;
}

const searchExecutor: HostProgramExecutor<SearchWorkerRequest> = {
  kind: "host",
  run: countProgram,
};

const entry = globalThis as unknown as {
  onmessage: (event: MessageEvent<SearchWorkerRequest>) => Promise<void>;
};
entry.onmessage = (event) => bootstrap(event.data, searchExecutor);
