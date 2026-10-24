import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  encodeWorkspaceArchive,
  importWorkspaceArchive,
  parseWorkspaceArchive,
  WorkspaceArchiveError,
  WORKSPACE_ARCHIVE_LIMITS,
  type ArchiveEntry,
  type ArchiveEvent,
  type ArchiveManifest,
  type ArchiveOptions,
  type ArchiveSourceEntry,
  type ArchiveStagingSink,
  type ArchiveSummary,
} from "../fs/workspace-archive.js";

const manifest: ArchiveManifest = {
  format: "waffle-workspace-archive-v1",
  sourceFormat: "waffle-indexeddb-chunks-v2",
  sourceWorkspace: "d66ef453-eaa9-4133-9133-022d96260fce",
};
function directory(path = "/"): ArchiveEntry & { kind: "directory" } {
  return { path, kind: "directory", size: 0, mtime: 1234.5, mode: 0o1700, sourceIdentity: null };
}
function file(path = "/a", size = 3): ArchiveEntry & { kind: "file" } {
  return {
    path,
    kind: "file",
    size,
    mtime: -10.75,
    mode: 0o600,
    sourceIdentity: {
      format: "waffle-file-identity-v1",
      workspace: manifest.sourceWorkspace!,
      id: "10000000000000002",
      version: "20000000000000001",
    },
  };
}
async function* values<T>(items: readonly T[]): AsyncGenerator<T> {
  yield* items;
}
function sources(): AsyncIterable<ArchiveSourceEntry> {
  return values<ArchiveSourceEntry>([
    { metadata: directory() },
    { metadata: file(), bytes: values([new Uint8Array([0, 128]), new Uint8Array([255])]) },
    { metadata: directory("/b") },
    { metadata: file("/b/é", 0), bytes: values([]) },
  ]);
}
async function* split(
  source: AsyncIterable<Uint8Array>,
  length: number,
): AsyncGenerator<Uint8Array> {
  for await (const bytes of source) {
    for (let at = 0; at < bytes.length; at += length) yield bytes.subarray(at, at + length);
  }
}
function u64s(entries: bigint, bytes: bigint): Uint8Array {
  const out = new Uint8Array(16),
    view = new DataView(out.buffer);
  view.setBigUint64(0, entries);
  view.setBigUint64(8, bytes);
  return out;
}
function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
type RawFrame = readonly [number, Uint8Array];
function entryFrames(entry: unknown, chunks: readonly Uint8Array[] = []): RawFrame[] {
  const start: RawFrame[] = [[2, json(entry)]];
  return start.concat(
    chunks.map((chunk): RawFrame => [3, chunk]),
    [[4, new Uint8Array()]],
  );
}
function manifestFrames(value: unknown): RawFrame[] {
  return [[1, json(value)]];
}
function rootFrames(): RawFrame[] {
  return manifestFrames(manifest).concat(entryFrames(directory()));
}
function validFrames(): RawFrame[] {
  return rootFrames().concat(entryFrames(file(), [new Uint8Array([0, 128, 255])]), [
    [5, u64s(2n, 3n)],
  ]);
}
async function* raw(frames: readonly RawFrame[]): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode("WAFLAR01");
  let previous = new Uint8Array(32);
  for (const [type, payload] of frames) {
    const header = new Uint8Array(5);
    header[0] = type;
    new DataView(header.buffer).setUint32(1, payload.length);
    const hash = createHash("sha256").update(previous).update(header).update(payload).digest();
    previous = new Uint8Array(hash);
    yield header;
    yield payload;
    yield previous;
  }
}
async function consume(source: AsyncIterable<ArchiveEvent>): Promise<void> {
  for await (const event of source) expect(event.kind).toBeDefined();
}
class RootModel implements ArchiveStagingSink {
  selected = "old";
  staged: ArchiveEntry[] = [];
  writes = 0;
  bytes = 0;
  completed = 0;
  aborted = 0;
  ended = 0;
  published = 0;
  onWrite: (() => Promise<void>) | undefined;
  failAt: "begin" | "entry" | "write" | "endEntry" | "complete" | "abort" | undefined;
  private attempt(at: RootModel["failAt"]): void {
    expect(this.selected).toBe("old");
    if (this.failAt === at) throw new Error(`sink ${at}`);
  }
  async begin(_manifest: ArchiveManifest): Promise<void> {
    this.attempt("begin");
  }
  async entry(entry: ArchiveEntry): Promise<void> {
    this.attempt("entry");
    this.staged.push(entry);
  }
  async write(bytes: Uint8Array): Promise<void> {
    this.attempt("write");
    expect(bytes.buffer.byteLength).toBeLessThanOrEqual(WORKSPACE_ARCHIVE_LIMITS.chunkBytes);
    this.writes++;
    this.bytes += bytes.length;
    await this.onWrite?.();
  }
  async endEntry(): Promise<void> {
    this.attempt("endEntry");
    this.ended++;
  }
  async complete(_summary: ArchiveSummary): Promise<void> {
    this.completed++;
    this.attempt("complete");
    this.selected = "new";
    this.published++;
  }
  async abort(_reason: unknown): Promise<void> {
    this.aborted++;
    this.attempt("abort");
    this.staged = [];
  }
}
async function rejectsOld(
  source: AsyncIterable<Uint8Array>,
  code: WorkspaceArchiveError["code"],
  options?: ArchiveOptions,
): Promise<RootModel> {
  const sink = new RootModel();
  await expect(importWorkspaceArchive(source, sink, options)).rejects.toMatchObject({
    name: "WorkspaceArchiveError",
    code,
  });
  expect(sink.selected).toBe("old");
  expect(sink.completed).toBe(0);
  expect(sink.published).toBe(0);
  expect(sink.aborted).toBe(1);
  expect(sink.staged).toEqual([]);
  return sink;
}
async function* mutate(
  source: AsyncIterable<Uint8Array>,
  index: number,
  offset: number,
): AsyncGenerator<Uint8Array> {
  let at = 0;
  for await (const bytes of source) {
    const copy = bytes.slice();
    if (at++ === index) copy[offset] = copy[offset]! ^ 1;
    yield copy;
  }
}
async function* truncate(
  source: AsyncIterable<Uint8Array>,
  limit: number,
): AsyncGenerator<Uint8Array> {
  let remaining = limit;
  for await (const bytes of source) {
    if (remaining === 0) return;
    yield bytes.subarray(0, remaining);
    remaining = Math.max(0, remaining - bytes.length);
  }
}

describe("workspace archive candidate", () => {
  test.each([1, 7, 65573])(
    "round trips binary bytes and metadata with %i-byte transport splits",
    async (length) => {
      const sink = new RootModel();
      const summary = await importWorkspaceArchive(
        split(encodeWorkspaceArchive(manifest, sources()), length),
        sink,
      );
      expect(summary).toEqual({ entries: 4, fileBytes: 3 });
      expect(sink.staged).toEqual([directory(), file(), directory("/b"), file("/b/é", 0)]);
      expect(sink.bytes).toBe(3);
      expect(sink.completed).toBe(1);
      expect(sink.published).toBe(1);
      expect(sink.aborted).toBe(0);
      expect(sink.selected).toBe("new");
    },
  );

  test("decodes independent SHA-256 framing fixture", async () => {
    const sink = new RootModel();
    await importWorkspaceArchive(split(raw(validFrames()), 2), sink);
    expect(sink.staged).toEqual([directory(), file()]);
    expect(sink.bytes).toBe(3);
  });

  test("retains an old root through writes and the final EOF pull", async () => {
    const sink = new RootModel();
    async function* checked(): AsyncGenerator<Uint8Array> {
      yield* encodeWorkspaceArchive(manifest, sources());
      expect(sink.ended).toBe(4);
      expect(sink.selected).toBe("old");
      expect(sink.completed).toBe(0);
    }
    await importWorkspaceArchive(checked(), sink);
    expect(sink.selected).toBe("new");
  });

  test("streams a generated 16 MiB file through a backpressured sink without collecting it", async () => {
    const chunks = 256,
      size = WORKSPACE_ARCHIVE_LIMITS.chunkBytes;
    let produced = 0,
      consumed = 0,
      maximumAhead = 0;
    const expected = createHash("sha256"),
      actual = createHash("sha256");
    async function* bytes(): AsyncGenerator<Uint8Array> {
      for (let at = 0; at < chunks; at++) {
        const chunk = new Uint8Array(size).fill(at);
        expected.update(chunk);
        produced++;
        maximumAhead = Math.max(maximumAhead, produced - consumed);
        yield chunk;
      }
    }
    const input = values<ArchiveSourceEntry>([
      { metadata: directory() },
      { metadata: file("/big", chunks * size), bytes: bytes() },
    ]);
    const sink = new RootModel();
    const baseWrite = sink.write.bind(sink);
    sink.write = async (chunk) => {
      await Promise.resolve();
      actual.update(chunk);
      consumed++;
      await baseWrite(chunk);
    };
    await importWorkspaceArchive(split(encodeWorkspaceArchive(manifest, input), 997), sink);
    expect(produced).toBe(chunks);
    expect(consumed).toBe(chunks);
    expect(maximumAhead).toBe(1);
    expect(actual.digest("hex")).toBe(expected.digest("hex"));
    expect(sink.bytes).toBe(chunks * size);
  });

  test("sibling ordering compares components, not raw full paths", async () => {
    const frames = rootFrames().concat(
      entryFrames(directory("/a")),
      entryFrames(file("/a/z"), [new Uint8Array(3)]),
      entryFrames(file("/a-"), [new Uint8Array(3)]),
      [[5, u64s(4n, 6n)]],
    );
    const sink = new RootModel();
    await importWorkspaceArchive(raw(frames), sink);
    expect(sink.published).toBe(1);
  });

  test("source hardlink identities remain provenance, not target identity allocation", async () => {
    const a = file("/a"),
      b = file("/b");
    const frames = rootFrames().concat(
      entryFrames(a, [new Uint8Array(3)]),
      entryFrames(b, [new Uint8Array(3)]),
      [[5, u64s(3n, 6n)]],
    );
    const sink = new RootModel();
    await importWorkspaceArchive(raw(frames), sink);
    expect(sink.staged[1]?.sourceIdentity).toEqual(sink.staged[2]?.sourceIdentity);
    expect(Object.keys(sink.staged[1]!)).not.toContain("targetIdentity");
  });

  test.each(["begin", "entry", "write", "endEntry", "complete"] as const)(
    "sink %s failure aborts and never publishes",
    async (at) => {
      const sink = new RootModel();
      sink.failAt = at;
      await expect(
        importWorkspaceArchive(encodeWorkspaceArchive(manifest, sources()), sink),
      ).rejects.toThrow(`sink ${at}`);
      expect(sink.selected).toBe("old");
      expect(sink.aborted).toBe(1);
      expect(sink.published).toBe(0);
      expect(sink.completed).toBe(at === "complete" ? 1 : 0);
    },
  );

  test("abort cleanup failure retains both errors", async () => {
    const sink = new RootModel();
    sink.failAt = "abort";
    let error: unknown;
    try {
      await importWorkspaceArchive(values([new Uint8Array(8)]), sink);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected aggregate");
    expect(error.errors[0]).toBeInstanceOf(WorkspaceArchiveError);
    expect(error.errors[1]).toMatchObject({ message: "sink abort" });
    expect(sink.published).toBe(0);
  });
});

describe("archive validation before publication", () => {
  test.each([0, 1, 7, 8, 9, 12, 13, 50, 120, 200, 350, 550, 700])(
    "truncation at byte %i cannot publish",
    async (at) => {
      await rejectsOld(truncate(raw(validFrames()), at), "TRUNCATED");
    },
  );

  test.each([1, 4, 7])(
    "rejects corrupted manifest, metadata or end checksum frame part %i",
    async (index) => {
      await rejectsOld(
        mutate(raw(validFrames()), index, index === 1 ? 1 : 0),
        index === 1 ? "LIMIT" : "INTEGRITY",
      );
    },
  );

  test("payload corruption is rejected before corrupted data reaches staging", async () => {
    const sink = await rejectsOld(mutate(raw(validFrames()), 14, 1), "INTEGRITY");
    expect(sink.writes).toBe(0);
  });

  test("valid frame checksums cannot hide a reordered or omitted frame", async () => {
    async function* reordered(): AsyncGenerator<Uint8Array> {
      let at = 0;
      for await (const bytes of raw(validFrames())) {
        if (at++ >= 13 && at <= 16) continue;
        yield bytes;
      }
    }
    await rejectsOld(reordered(), "INTEGRITY");
  });

  test("forged totals fail after private data writes", async () => {
    const frames = validFrames();
    frames[frames.length - 1] = [5, u64s(2n, 4n)];
    const sink = await rejectsOld(raw(frames), "INTEGRITY");
    expect(sink.writes).toBe(1);
  });

  test("trailing bytes fail before complete", async () => {
    async function* trailing(): AsyncGenerator<Uint8Array> {
      yield* raw(validFrames());
      yield new Uint8Array([0]);
    }
    await rejectsOld(trailing(), "INVALID");
  });

  test.each(["/../a", "/a/./b", "/a//b", "/a/", "relative", "/a\0b", "/a\\b", "/\ud800"])(
    "rejects unsafe path %j with valid checksums",
    async (path) => {
      await rejectsOld(
        raw(rootFrames().concat(entryFrames(file(path)), [[5, u64s(2n, 3n)]])),
        "INVALID",
      );
    },
  );

  test.each(
    [
      [directory("/a"), directory("/a")],
      [directory("/b"), directory("/a")],
      [file("/a", 0), file("/a/b", 0)],
      [directory("/a/b")],
      [directory("/a"), directory("/b"), directory("/a/z")],
      [directory("/")],
    ].map((entries) => ({ entries })),
  )(
    "rejects duplicate, missing-parent, file-parent and out-of-order entries %#",
    async ({ entries }) => {
      const frames = rootFrames().concat(
        entries.flatMap((entry) => entryFrames(entry)),
        [[5, u64s(BigInt(entries.length + 1), 0n)]],
      );
      await rejectsOld(raw(frames), "INVALID");
    },
  );

  test.each([
    { ...file(), size: -1 },
    { ...file(), size: Number.MAX_SAFE_INTEGER + 1 },
    { ...file(), mtime: "bad" },
    { ...file(), mode: 0o777 },
    { ...directory("/a"), size: 1 },
    { ...file(), kind: "symlink" },
    { ...file(), sourceIdentity: { ...file().sourceIdentity, workspace: "not-a-workspace" } },
    { ...file(), sourceIdentity: { ...file().sourceIdentity, id: "1" } },
    { ...file(), sourceIdentity: { ...file().sourceIdentity, version: "10000000000000001" } },
    { ...file(), targetIdentity: "not-importable" },
  ])("rejects unimportable metadata %#", async (entry) => {
    await rejectsOld(raw(rootFrames().concat(entryFrames(entry))), "INVALID");
  });

  test("rejects foreign source workspace identity", async () => {
    const identity = {
      ...file().sourceIdentity,
      workspace: "00000000-0000-0000-0000-000000000000",
    };
    await rejectsOld(
      raw(rootFrames().concat(entryFrames({ ...file(), sourceIdentity: identity }))),
      "INVALID",
    );
  });

  test("archive and physical format identities are distinct", async () => {
    const unknownManifest = { ...manifest, format: "waffle-opfs-snapshots-v1" };
    await rejectsOld(raw([[1, json(unknownManifest)]]), "INVALID");
    const sink = new RootModel();
    await importWorkspaceArchive(
      raw(
        manifestFrames({ ...manifest, sourceFormat: "other-packed-format-v9" }).concat(
          entryFrames(directory()),
          [[5, u64s(1n, 0n)]],
        ),
      ),
      sink,
    );
    expect(sink.published).toBe(1);
  });

  test("rejects malformed UTF-8 and JSON with valid frame checksums", async () => {
    await rejectsOld(raw([[1, new Uint8Array([0xc3, 0x28])]]), "INVALID");
    await rejectsOld(raw([[1, new TextEncoder().encode("{")]]), "INVALID");
  });

  test.each([0, 6, 255])("rejects unknown frame tag %i", async (type) => {
    await rejectsOld(raw([[type, new Uint8Array()]]), "INVALID");
  });

  test("rejects oversized frame length before pulling its body", async () => {
    let bodyRead = false;
    async function* oversized(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode("WAFLAR01");
      yield new Uint8Array([1, 255, 255, 255, 255]);
      bodyRead = true;
      yield new Uint8Array(0);
    }
    await rejectsOld(oversized(), "LIMIT");
    expect(bodyRead).toBe(false);
  });

  test("rejects oversized transport chunks", async () => {
    await rejectsOld(
      values([new Uint8Array(WORKSPACE_ARCHIVE_LIMITS.transportBytes + 1)]),
      "LIMIT",
    );
  });

  test.each([
    { maxEntries: 1, maxFileBytes: 3, maxTotalBytes: 3 },
    { maxEntries: 2, maxFileBytes: 2, maxTotalBytes: 3 },
    { maxEntries: 2, maxFileBytes: 3, maxTotalBytes: 2 },
    { maxEntries: -1, maxFileBytes: 3, maxTotalBytes: 3 },
  ])("enforces declared entry, file and cumulative budgets %#", async (budget) => {
    await rejectsOld(raw(validFrames()), "LIMIT", { budget });
  });

  test("cumulative budget subtraction rejects a second file before its body", async () => {
    const frames = rootFrames().concat(
      entryFrames(file("/a"), [new Uint8Array(3)]),
      entryFrames(file("/b")),
    );
    const sink = await rejectsOld(raw(frames), "LIMIT", {
      budget: { maxEntries: 3, maxFileBytes: 3, maxTotalBytes: 5 },
    });
    expect(sink.bytes).toBe(3);
  });

  test("unsafe 64-bit trailer counters are compared without number conversion", async () => {
    await rejectsOld(
      raw(rootFrames().concat([[5, u64s(1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n)]])),
      "INTEGRITY",
    );
  });

  test("rejects oversized paths and depth without a whole-tree index", async () => {
    await rejectsOld(raw(rootFrames().concat(entryFrames(file("/" + "x".repeat(4096))))), "LIMIT");
    await rejectsOld(
      raw(
        rootFrames().concat(
          entryFrames(file("/" + Array.from({ length: 129 }, () => "a").join("/"))),
        ),
      ),
      "LIMIT",
    );
  });

  test.each(
    [
      rootFrames().concat([[3, new Uint8Array([1])]]),
      rootFrames().concat(entryFrames(file("/a", 0), [new Uint8Array([1])])),
      rootFrames().concat(entryFrames(file("/a", 1))),
      rootFrames().concat(entryFrames(directory("/a"), [new Uint8Array([1])])),
      rootFrames().concat([
        [2, json(file())],
        [3, new Uint8Array()],
      ]),
      [
        [1, json(manifest)],
        [5, u64s(0n, 0n)],
      ] satisfies RawFrame[],
      rootFrames().concat([[5, new Uint8Array(0)]]),
    ].map(
      (frames, index) =>
        ({ frames, code: index === 1 ? "LIMIT" : "INVALID" }) satisfies {
          frames: RawFrame[];
          code: WorkspaceArchiveError["code"];
        },
    ),
  )("rejects causal framing or file-length violation %#", async ({ frames, code }) => {
    await rejectsOld(raw(frames), code);
  });
});

describe("stream lifecycle", () => {
  test("parse early return closes its source", async () => {
    let closed = 0;
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        yield* raw(validFrames());
      } finally {
        closed++;
      }
    }
    for await (const event of parseWorkspaceArchive(source())) {
      expect(event.kind).toBe("manifest");
      break;
    }
    expect(closed).toBe(1);
  });

  test("encoder early return closes entry and payload producers", async () => {
    let entriesClosed = 0,
      payloadClosed = 0;
    async function* payload(): AsyncGenerator<Uint8Array> {
      try {
        yield new Uint8Array([1]);
        yield new Uint8Array([2]);
      } finally {
        payloadClosed++;
      }
    }
    async function* entries(): AsyncGenerator<ArchiveSourceEntry> {
      try {
        yield { metadata: directory() };
        yield { metadata: file("/a", 2), bytes: payload() };
      } finally {
        entriesClosed++;
      }
    }
    let pulled = 0;
    for await (const bytes of encodeWorkspaceArchive(manifest, entries())) {
      expect(bytes.length).toBeGreaterThan(0);
      if (++pulled === 6) break;
    }
    expect(entriesClosed).toBe(1);
    expect(payloadClosed).toBe(1);
  });

  test("parse/write failure closes the actual transport generator", async () => {
    let closed = 0;
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        yield* raw(validFrames());
      } finally {
        closed++;
      }
    }
    const sink = new RootModel();
    sink.failAt = "write";
    await expect(importWorkspaceArchive(source(), sink)).rejects.toThrow("sink write");
    expect(closed).toBe(1);
    expect(sink.published).toBe(0);
  });

  test("producer failure after archive end still prevents publication", async () => {
    const sink = new RootModel();
    async function* source(): AsyncGenerator<Uint8Array> {
      yield* raw(validFrames());
      throw new Error("transport failed at EOF");
    }
    await expect(importWorkspaceArchive(source(), sink)).rejects.toThrow("transport failed at EOF");
    expect(sink.completed).toBe(0);
    expect(sink.aborted).toBe(1);
  });

  test("cancellation during a staged write aborts without publication", async () => {
    const controller = new AbortController(),
      sink = new RootModel();
    sink.onWrite = async () => {
      controller.abort(new Error("cancelled write"));
    };
    await expect(
      importWorkspaceArchive(raw(validFrames()), sink, { signal: controller.signal }),
    ).rejects.toThrow("cancelled write");
    expect(sink.published).toBe(0);
    expect(sink.aborted).toBe(1);
  });

  test("cancellation interrupts pending transport pull and joins its return cleanup", async () => {
    const controller = new AbortController();
    const source = new PendingInput<Uint8Array>();
    const sink = new RootModel();
    const importing = importWorkspaceArchive(source, sink, { signal: controller.signal });
    await source.started;
    controller.abort(new Error("cancelled pending pull"));
    await expect(importing).rejects.toThrow("cancelled pending pull");
    expect(source.returned).toBe(1);
    expect(sink.aborted).toBe(1);
    expect(sink.published).toBe(0);
  });

  test("source return failure after a sink failure still aborts staging", async () => {
    let returned = 0;
    const input = raw(validFrames())[Symbol.asyncIterator]();
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => input.next(),
          async return() {
            returned++;
            await input.return?.(undefined);
            throw new Error("return failed");
          },
        };
      },
    };
    const sink = new RootModel();
    sink.failAt = "write";
    await expect(importWorkspaceArchive(source, sink)).rejects.toThrow();
    expect(returned).toBe(1);
    expect(sink.aborted).toBe(1);
    expect(sink.published).toBe(0);
  });

  test("encoder enforces source length, chunk and metadata limits", async () => {
    const tooBig = values<ArchiveSourceEntry>([
      { metadata: directory() },
      { metadata: file("/a", 65537), bytes: values([new Uint8Array(65537)]) },
    ]);
    await expect(
      consume(parseWorkspaceArchive(encodeWorkspaceArchive(manifest, tooBig))),
    ).rejects.toMatchObject({ code: "LIMIT" });
    const tooShort = values<ArchiveSourceEntry>([
      { metadata: directory() },
      { metadata: file(), bytes: values([new Uint8Array(2)]) },
    ]);
    await rejectsOld(encodeWorkspaceArchive(manifest, tooShort), "INVALID");
    const tooLong = values<ArchiveSourceEntry>([
      { metadata: directory() },
      { metadata: file(), bytes: values([new Uint8Array(4)]) },
    ]);
    await rejectsOld(encodeWorkspaceArchive(manifest, tooLong), "LIMIT");
  });
});

class PendingInput<T> implements AsyncIterable<T>, AsyncIterator<T> {
  returned = 0;
  private markStarted: () => void = () => {};
  private finish: (result: IteratorResult<T>) => void = () => {};
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });
  private readonly waiting = new Promise<IteratorResult<T>>((resolve) => {
    this.finish = resolve;
  });
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
  next(): Promise<IteratorResult<T>> {
    this.markStarted();
    return this.waiting;
  }
  async return(): Promise<IteratorResult<T>> {
    this.returned++;
    const result = { done: true, value: undefined } satisfies IteratorResult<T>;
    this.finish(result);
    return result;
  }
}

describe("bounded stream ownership", () => {
  test("cancellation of a pending entry producer closes it", async () => {
    const input = new PendingInput<ArchiveSourceEntry>(),
      controller = new AbortController();
    const sink = new RootModel();
    const importing = importWorkspaceArchive(
      encodeWorkspaceArchive(manifest, input, { signal: controller.signal }),
      sink,
    );
    await input.started;
    controller.abort(new Error("cancelled entries"));
    await expect(importing).rejects.toThrow("cancelled entries");
    expect(input.returned).toBe(1);
    expect(sink.aborted).toBe(1);
    expect(sink.completed).toBe(0);
  });

  test("cancellation of pending file bytes closes both producers", async () => {
    const input = new PendingInput<Uint8Array>(),
      controller = new AbortController();
    let entriesClosed = 0;
    async function* entries(): AsyncGenerator<ArchiveSourceEntry> {
      try {
        yield { metadata: directory() };
        yield { metadata: file(), bytes: input };
      } finally {
        entriesClosed++;
      }
    }
    const sink = new RootModel();
    const importing = importWorkspaceArchive(
      encodeWorkspaceArchive(manifest, entries(), { signal: controller.signal }),
      sink,
    );
    await input.started;
    controller.abort(new Error("cancelled bytes"));
    await expect(importing).rejects.toThrow("cancelled bytes");
    expect(input.returned).toBe(1);
    expect(entriesClosed).toBe(1);
    expect(sink.published).toBe(0);
  });

  test("pre-aborted import does not open a source iterator", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    let opened = 0;
    const input: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        opened++;
        return new PendingInput<Uint8Array>();
      },
    };
    const sink = new RootModel();
    await expect(
      importWorkspaceArchive(input, sink, { signal: controller.signal }),
    ).rejects.toThrow("already cancelled");
    expect(opened).toBe(0);
    expect(sink.aborted).toBe(1);
  });

  test("cancellation on the final source pull prevents complete", async () => {
    const controller = new AbortController(),
      sink = new RootModel();
    async function* input(): AsyncGenerator<Uint8Array> {
      yield* raw(validFrames());
      controller.abort(new Error("cancelled EOF"));
    }
    await expect(
      importWorkspaceArchive(input(), sink, { signal: controller.signal }),
    ).rejects.toThrow("cancelled EOF");
    expect(sink.aborted).toBe(1);
    expect(sink.completed).toBe(0);
  });

  test("accepts small views of a large reused transport buffer", async () => {
    const buffer = new Uint8Array(1024 * 1024);
    const wire = raw(validFrames());
    async function* reused(): AsyncGenerator<Uint8Array> {
      for await (const chunk of wire) {
        buffer.set(chunk);
        yield buffer.subarray(0, chunk.length);
      }
    }
    const sink = new RootModel();
    await importWorkspaceArchive(reused(), sink);
    expect(sink.published).toBe(1);
    expect(sink.bytes).toBe(3);
  });

  test("limits consecutive empty transport pulls instead of spinning forever", async () => {
    let closed = false;
    async function* empty(): AsyncGenerator<Uint8Array> {
      try {
        for (let index = 0; index <= WORKSPACE_ARCHIVE_LIMITS.emptyChunks; index++)
          yield new Uint8Array();
      } finally {
        closed = true;
      }
    }
    await rejectsOld(empty(), "LIMIT");
    expect(closed).toBe(true);
  });

  test("rejects zero-byte encoder chunks instead of spinning forever", async () => {
    const entries = values<ArchiveSourceEntry>([
      { metadata: directory() },
      { metadata: file("/a", 0), bytes: values([new Uint8Array()]) },
    ]);
    await rejectsOld(encodeWorkspaceArchive(manifest, entries), "INVALID");
  });

  test("truncated final digest is not a completed archive", async () => {
    const frames = validFrames(),
      length = 8 + frames.reduce((size, frame) => size + 37 + frame[1].length, 0);
    await rejectsOld(truncate(raw(frames), length - 1), "TRUNCATED");
  });

  test("source bytes remain independent of encoder frame ownership", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const entries = values<ArchiveSourceEntry>([
      { metadata: directory() },
      { metadata: file(), bytes: values([original]) },
    ]);
    const frames = encodeWorkspaceArchive(manifest, entries);
    const seen: number[] = [];
    for await (const event of parseWorkspaceArchive(frames)) {
      if (event.kind !== "data") continue;
      original.fill(0);
      for (const byte of event.bytes) seen.push(byte);
    }
    expect(seen).toEqual([1, 2, 3]);
  });

  test.each(
    (
      [
        [
          [1, json(manifest)],
          [2, json(file("/a", 0))],
        ],
        [[2, json(directory())]],
        [[1, json({ ...manifest, unexpected: 1 })]],
        [[1, json({ ...manifest, sourceWorkspace: "bad" })]],
        [[1, json({ ...manifest, sourceFormat: "a".repeat(129) })]],
      ] satisfies RawFrame[][]
    ).map((frames) => ({ frames })),
  )("valid digests cannot hide malformed manifest/root sequencing %#", async ({ frames }) => {
    await rejectsOld(raw(frames), "INVALID");
  });
});

describe("logical namespace streaming", () => {
  test("streams thousands of entries without accumulating a tree", async () => {
    const count = 2048;
    let produced = 0,
      staged = 0,
      maximumAhead = 0;
    async function* entries(): AsyncGenerator<ArchiveSourceEntry> {
      produced++;
      yield { metadata: directory() };
      for (let index = 0; index < count; index++) {
        produced++;
        maximumAhead = Math.max(maximumAhead, produced - staged);
        yield { metadata: file(`/file-${String(index).padStart(6, "0")}`, 0), bytes: values([]) };
      }
    }
    const sink = new RootModel();
    sink.entry = async () => {
      expect(sink.selected).toBe("old");
      staged++;
    };
    const summary = await importWorkspaceArchive(encodeWorkspaceArchive(manifest, entries()), sink);
    expect(summary).toEqual({ entries: count + 1, fileBytes: 0 });
    expect(staged).toBe(count + 1);
    expect(maximumAhead).toBe(1);
    expect(sink.staged).toEqual([]);
    expect(sink.selected).toBe("new");
  });

  test("accepts identity-free memory metadata and rejects nonfinite encoder timestamps", async () => {
    const memoryManifest = { ...manifest, sourceFormat: null, sourceWorkspace: null };
    const entry = { ...file("/a", 0), sourceIdentity: null };
    const sink = new RootModel();
    await importWorkspaceArchive(
      encodeWorkspaceArchive(
        memoryManifest,
        values<ArchiveSourceEntry>([
          { metadata: directory() },
          { metadata: entry, bytes: values([]) },
        ]),
      ),
      sink,
    );
    expect(sink.staged[1]).toEqual(entry);
    const input = values<ArchiveSourceEntry>([{ metadata: { ...directory(), mtime: Infinity } }]);
    await rejectsOld(encodeWorkspaceArchive(memoryManifest, input), "INVALID");
  });

  test("rejects oversized data and nonempty end-entry declarations before body reads", async () => {
    const cases = [
      { type: 3, size: 65537 },
      { type: 4, size: 1 },
    ];
    for (const { type, size } of cases) {
      let readBody = false;
      async function* input(): AsyncGenerator<Uint8Array> {
        yield* raw(rootFrames().concat([[2, json(file("/a", 65537))]]));
        const header = new Uint8Array(5);
        header[0] = type;
        new DataView(header.buffer).setUint32(1, size);
        yield header;
        readBody = true;
        yield new Uint8Array(size);
      }
      await rejectsOld(input(), "LIMIT");
      expect(readBody).toBe(false);
    }
  });
});

for (const target of ["/a", "/missing", "link"]) {
  test(`v1 raw link target ${target} is not importable and never selects a staged root`, async () => {
    const entry = {
      ...file("/link", new TextEncoder().encode(target).length),
      kind: "symlink",
      target,
    };
    const sink = await rejectsOld(raw(rootFrames().concat(entryFrames(entry))), "INVALID");
    expect(sink.selected).toBe("old");
    expect(sink.published).toBe(0);
  });
}

test("v1 encoder rejects link-shaped input without pulling a referent", async () => {
  let pulls = 0;
  const metadata = Object.defineProperties(file("/link", 1), {
    kind: { value: "symlink", enumerable: true },
    target: { value: "/a", enumerable: true },
  });
  async function* referent(): AsyncGenerator<Uint8Array> {
    pulls++;
    yield new Uint8Array([1]);
  }
  const input = values<ArchiveSourceEntry>([
    { metadata: directory() },
    { metadata, bytes: referent() },
  ]);
  await expect(
    consume(parseWorkspaceArchive(encodeWorkspaceArchive(manifest, input))),
  ).rejects.toMatchObject({
    name: "WorkspaceArchiveError",
    code: "INVALID",
  });
  expect(pulls).toBe(0);
});
