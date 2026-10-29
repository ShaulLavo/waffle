import { expect, test } from "bun:test";
import {
  BATCH_FILES,
  CANDIDATE_CREDITS,
  OUTPUT_WINDOW_BYTES,
  SearchRun,
  type BatchExecutor,
  type Candidate,
  type CandidateSource,
  type FileResult,
  type IndexedResult,
  type ProgramLimits,
  type ShardFile,
  type SourceEntry,
} from "../search/shards.ts";

class FakeSource implements CandidateSource {
  outstanding = 0;
  peak = 0;
  closed = 0;
  readonly released = new Map<string, number>();
  private at = 0;
  constructor(private readonly entries: readonly SourceEntry[]) {}
  next(credits: number) {
    expect(credits).toBeGreaterThan(0);
    const page = this.entries.slice(this.at, this.at + Math.min(credits, 128));
    this.at += page.length;
    this.outstanding += page.length;
    this.peak = Math.max(this.peak, this.outstanding);
    return { entries: page, done: this.at >= this.entries.length };
  }
  release(files: readonly Candidate[]): void {
    expect(files.length).toBeLessThanOrEqual(CANDIDATE_CREDITS);
    for (const file of files) this.released.set(file.path, (this.released.get(file.path) ?? 0) + 1);
    this.outstanding -= files.length;
  }
  close(): void {
    this.closed++;
  }
}

/** Finishes batches in reverse submission order to exercise the reorder buffer. */
class FakeExecutor implements BatchExecutor {
  readonly queued: { id: number; files: readonly ShardFile[] }[] = [];
  inFlightFiles = 0;
  peakFiles = 0;
  closed = 0;
  constructor(
    readonly capacity: number,
    private readonly result: (file: ShardFile) => FileResult = () => ({
      kind: "done",
      matched: 1,
      output: null,
    }),
  ) {}
  submit(id: number, files: readonly ShardFile[]): void {
    expect(files.length).toBeLessThanOrEqual(BATCH_FILES);
    this.queued.push({ id, files });
    this.inFlightFiles += files.length;
    this.peakFiles = Math.max(this.peakFiles, this.inFlightFiles);
  }
  async next() {
    const batch = this.queued.pop()!;
    this.inFlightFiles -= batch.files.length;
    const results: IndexedResult[] = batch.files.map((file) => ({
      index: file.index,
      ...this.result(file),
    }));
    return { id: batch.id, results };
  }
  async close(): Promise<void> {
    this.closed++;
  }
}

const limits: ProgramLimits = {
  fileBytes: 1024,
  pathBytes: 32,
  outputBound: (size) => size,
};
function files(count: number, size = 1): SourceEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "file" as const,
    path: `f${index}`,
    handle: index + 10,
    size,
  }));
}

test("one credit window bounds every shard, batch and pending page", async () => {
  const source = new FakeSource(files(3000));
  // 4 shards * 2 batches * 64 files would be 512 handles; the window holds 256.
  const executor = new FakeExecutor(8);
  const delivered: string[] = [];
  await new SearchRun(
    source,
    executor,
    {
      deliver: (file) => {
        delivered.push(file.path);
      },
      fallback: () => ({ kind: "error", errno: 29 }),
    },
    limits,
    () => {},
  ).run();
  expect(source.peak).toBeLessThanOrEqual(CANDIDATE_CREDITS);
  expect(executor.peakFiles).toBeLessThanOrEqual(CANDIDATE_CREDITS);
  expect(delivered).toEqual(files(3000).map((file) => file.path));
  expect(source.outstanding).toBe(0);
  expect([...source.released.values()].every((count) => count === 1)).toBe(true);
  expect(source.released.size).toBe(3000);
  expect([source.closed, executor.closed]).toEqual([1, 1]);
});

test("preflight rejects oversized files and paths before dispatch, in output order", async () => {
  const entries: SourceEntry[] = [
    { kind: "file", path: "ok", handle: 1, size: 4 },
    { kind: "file", path: "big", handle: 2, size: 2048 },
    { kind: "file", path: "p".repeat(40), handle: 3, size: 1 },
    { kind: "error", path: "denied", errno: 2 },
  ];
  const source = new FakeSource(entries);
  const dispatched: string[] = [];
  const executor = new FakeExecutor(2, (file) => {
    dispatched.push(file.path);
    return { kind: "done", matched: 0, output: null };
  });
  const seen: [string, FileResult][] = [];
  await new SearchRun(
    source,
    executor,
    {
      deliver: (file, result) => void seen.push([file.path, result]),
      fallback: () => ({ kind: "error", errno: 29 }),
    },
    limits,
    () => {},
  ).run();
  expect(dispatched).toEqual(["ok"]);
  expect(seen.map(([path, result]) => [path, result.kind === "error" ? result.errno : 0])).toEqual([
    ["ok", 0],
    ["big", 22],
    ["p".repeat(40), 37],
    ["denied", 2],
  ]);
  expect(source.outstanding).toBe(0);
});

test("reserved worst-case output pauses dispatch at the window", async () => {
  const size = OUTPUT_WINDOW_BYTES / 4;
  const source = new FakeSource(files(20, size));
  const executor = new FakeExecutor(8);
  await new SearchRun(
    source,
    executor,
    { deliver: () => {}, fallback: () => ({ kind: "error", errno: 29 }) },
    { ...limits, fileBytes: size },
    () => {},
  ).run();
  expect(executor.peakFiles).toBeLessThanOrEqual(4);
  expect(source.outstanding).toBe(0);
});

test("cancellation releases every outstanding candidate exactly once and stops the executor", async () => {
  const source = new FakeSource(files(1000));
  const executor = new FakeExecutor(4);
  let steps = 0;
  const run = new SearchRun(
    source,
    executor,
    { deliver: () => {}, fallback: () => ({ kind: "error", errno: 29 }) },
    limits,
    () => {
      if (++steps === 3) throw new Error("signal");
    },
  );
  await expect(run.run()).rejects.toThrow("signal");
  expect(source.outstanding).toBe(0);
  expect([...source.released.values()].every((count) => count === 1)).toBe(true);
  expect([source.closed, executor.closed]).toEqual([1, 1]);
});

test("a failed delivery still releases the delivered candidate once", async () => {
  const source = new FakeSource(files(10));
  const executor = new FakeExecutor(1);
  let writes = 0;
  const run = new SearchRun(
    source,
    executor,
    {
      deliver: () => {
        if (++writes === 4) throw new Error("EPIPE");
      },
      fallback: () => ({ kind: "error", errno: 29 }),
    },
    limits,
    () => {},
  );
  await expect(run.run()).rejects.toThrow("EPIPE");
  expect(source.outstanding).toBe(0);
  expect(source.released.size).toBe(10);
  expect([...source.released.values()].every((count) => count === 1)).toBe(true);
});

const noFallback = { deliver: () => {}, fallback: () => ({ kind: "error" as const, errno: 29 }) };
async function settle(run: SearchRun): Promise<unknown> {
  return run.run().then(
    () => undefined,
    (error: unknown) => error,
  );
}

test("a rejected executor close still releases grants and closes the source", async () => {
  const source = new FakeSource(files(300));
  const executor = new FakeExecutor(2);
  const order: string[] = [];
  const stop = new Error("helpers fenced");
  executor.close = async () => {
    order.push("executor");
    throw stop;
  };
  const release = source.release.bind(source);
  source.release = (released) => {
    order.push("release");
    release(released);
  };
  const run = new SearchRun(source, executor, noFallback, limits, () => {
    throw new Error("signal");
  });
  const error = await settle(run);
  expect(error).toBeInstanceOf(AggregateError);
  const errors = (error as AggregateError).errors;
  expect(errors.map(String)).toEqual(["Error: signal", "Error: helpers fenced"]);
  expect((error as AggregateError).cause).toBe(errors[0]);
  expect(source.closed).toBe(1);
  expect(order[0]).toBe("executor");
});

test("a throwing grant release cannot skip the original-cursor close", async () => {
  const source = new FakeSource(files(600));
  const executor = new FakeExecutor(1);
  let releases = 0;
  const release = source.release.bind(source);
  source.release = (released) => {
    if (++releases === 1) throw new Error("walkRelease EBADF");
    release(released);
  };
  let steps = 0;
  const run = new SearchRun(source, executor, noFallback, limits, () => {
    if (++steps === 2) throw new Error("signal");
  });
  const error = await settle(run);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors.map(String)).toContain("Error: signal");
  expect((error as AggregateError).errors.map(String)).toContain("Error: walkRelease EBADF");
  expect(executor.closed).toBe(1);
  expect(source.closed).toBe(1);
});

test("every outstanding chunk is released even when one release throws", async () => {
  const source = new FakeSource(files(256));
  const executor = new FakeExecutor(0);
  let calls = 0;
  const release = source.release.bind(source);
  source.release = (released) => {
    calls++;
    if (released.some((file) => file.path === "f0")) throw new Error("first chunk");
    release(released);
  };
  // Capacity 0 never dispatches: the run fills its whole window, then is cancelled.
  let checks = 0;
  const run = new SearchRun(source, executor, noFallback, limits, () => {
    if (++checks === 2) throw new Error("cancel");
  });
  const error = await settle(run);
  expect((error as AggregateError).errors.map(String)).toEqual([
    "Error: cancel",
    "Error: first chunk",
  ]);
  expect(calls).toBe(1);
  expect(source.closed).toBe(1);
});

test("a source close failure is reported with the original cause first", async () => {
  const source = new FakeSource(files(10));
  source.close = () => {
    throw new Error("walkClose failed");
  };
  const executor = new FakeExecutor(1);
  const run = new SearchRun(
    source,
    executor,
    {
      deliver: () => {
        throw new Error("EPIPE");
      },
      fallback: () => ({ kind: "error", errno: 29 }),
    },
    limits,
    () => {},
  );
  const error = await settle(run);
  expect((error as AggregateError).errors.map(String)).toEqual([
    "Error: EPIPE",
    "Error: walkClose failed",
  ]);
  expect(executor.closed).toBe(1);
  expect(source.outstanding).toBe(0);
});

test("a delivery failure and its release failure are both kept", async () => {
  const source = new FakeSource(files(4));
  const release = source.release.bind(source);
  source.release = (released) => {
    if (released.length === 1) throw new Error("release failed");
    release(released);
  };
  const run = new SearchRun(
    source,
    new FakeExecutor(1),
    {
      deliver: () => {
        throw new Error("EPIPE");
      },
      fallback: () => ({ kind: "error", errno: 29 }),
    },
    limits,
    () => {},
  );
  const error = await settle(run);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors.map(String)).toEqual([
    "Error: EPIPE",
    "Error: release failed",
  ]);
  expect(source.closed).toBe(1);
});

test("output reservations cover files that grow after enumeration", async () => {
  const actualBytes = OUTPUT_WINDOW_BYTES / 4;
  const source = new FakeSource(files(8, 0));
  let pendingBytes = 0;
  let peakBytes = 0;
  const executor = new FakeExecutor(8, () => {
    const output = new Uint8Array(actualBytes);
    pendingBytes += output.byteLength;
    peakBytes = Math.max(peakBytes, pendingBytes);
    return { kind: "done", matched: 1, output };
  });
  await new SearchRun(
    source,
    executor,
    {
      deliver: (_file, result) => {
        if (result.kind === "done") pendingBytes -= result.output?.byteLength ?? 0;
      },
      fallback: () => ({ kind: "error", errno: 29 }),
    },
    { ...limits, fileBytes: actualBytes },
    () => {},
  ).run();
  expect(peakBytes).toBeLessThanOrEqual(OUTPUT_WINDOW_BYTES);
  expect(pendingBytes).toBe(0);
  expect([source.closed, executor.closed]).toEqual([1, 1]);
});
