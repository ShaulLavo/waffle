import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs";
import { MemFS } from "../fs/memory";
import { storeIdentity, parseFileIdentity } from "../fs/file-identity";
import {
  exportWorkspaceArchive,
  WorkspaceExportError,
  WORKSPACE_EXPORT_LIMITS,
} from "../fs/workspace-export";
import {
  parseWorkspaceArchive,
  type ArchiveEvent,
  type ArchiveOptions,
} from "../fs/workspace-archive";
import type {
  ByteRange,
  ReadOutcome,
  ReadValue,
  SnapshotPage,
  VersionLease,
  VersionStat,
  WorkspaceVfs,
} from "../fs/workspace-types";
import { publicReadFixture, heldNativeReadFixture } from "./fixtures/workspace-read";
import { RangeFixture } from "./fixtures/opfs-range-storage";

const encoder = new TextEncoder();
function fixture(paths: readonly string[] = ["/file"], size = 3) {
  const seed = new MemFS();
  for (const path of paths) seed.writeFile(path, new Uint8Array(size).fill(65));
  return publicReadFixture(new MemoryBackend(seed));
}
type Fixture = ReturnType<typeof fixture>;
interface Hooks {
  page?(page: SnapshotPage, scan: number, pull: number): Promise<SnapshotPage>;
  beforePin?(): Promise<void>;
  pinStat?(stat: VersionStat): VersionStat;
  read?(value: ReadOutcome<ReadValue>, range?: ByteRange): Promise<ReadOutcome<ReadValue>>;
  cursorClose?(): Promise<void>;
  leaseClose?(): Promise<void>;
}
function observe(workspace: WorkspaceVfs, hooks: Hooks = {}) {
  const counts = { scans: 0, pulls: 0, pins: 0, reads: 0, largestRange: 0, closed: 0 };
  const wrapped: WorkspaceVfs = {
    ...workspace,
    snapshot(options, signal) {
      const scan = ++counts.scans;
      const cursor = workspace.snapshot(options, signal);
      return {
        async next() {
          const page = await cursor.next();
          const pull = ++counts.pulls;
          return hooks.page ? hooks.page(page, scan, pull) : page;
        },
        async close() {
          await cursor.close();
          await hooks.cursorClose?.();
        },
      };
    },
    async pin(target, version, signal) {
      counts.pins++;
      await hooks.beforePin?.();
      const result = await workspace.pin(target, version, signal);
      if (result.kind !== "ok") return result;
      const original = result.value;
      const lease: VersionLease = {
        stat: hooks.pinStat ? hooks.pinStat(original.stat) : original.stat,
        async read(range, readSignal) {
          counts.reads++;
          counts.largestRange = Math.max(counts.largestRange, range?.length ?? Infinity);
          const value = await original.read(range, readSignal);
          return hooks.read ? hooks.read(value, range) : value;
        },
        async close() {
          counts.closed++;
          await original.close();
          await hooks.leaseClose?.();
        },
      };
      return { kind: "ok", value: lease };
    },
  };
  return { workspace: wrapped, counts };
}
async function capture<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ kind: "ok", value }) as const,
    (error: unknown) => ({ kind: "error", error }) as const,
  );
}
async function consume(workspace: WorkspaceVfs, options?: ArchiveOptions) {
  const events: ArchiveEvent[] = [];
  for await (const event of parseWorkspaceArchive(exportWorkspaceArchive(workspace, options)))
    events.push(event);
  return events;
}
async function rejected(workspace: WorkspaceVfs, options?: ArchiveOptions): Promise<unknown> {
  const result = await capture(consume(workspace, options));
  if (result.kind === "ok") throw new Error("Expected export failure");
  return result.error;
}
function refusal(error: unknown): WorkspaceExportError["refusal"] {
  if (!(error instanceof WorkspaceExportError)) throw error;
  return error.refusal;
}
function released(value: Fixture): void {
  const resources = value.service.resources();
  expect(resources.workspaceCursors).toBe(0);
  expect(resources.readerLeases ?? 0).toBe(0);
  expect(resources.readerTickets ?? 0).toBe(0);
  expect(resources.readerOperations ?? 0).toBe(0);
  expect(resources.readerPinBytes ?? 0).toBe(0);
  expect(resources.readerResultBytes ?? 0).toBe(0);
}

function expectFileEntry(
  entry: Extract<ArchiveEvent, { kind: "entry" }>["entry"],
  selected: VersionStat,
  size: number,
): void {
  if (entry.path !== "/file") return;
  expect(entry).toEqual({
    path: "/file",
    kind: "file",
    size,
    mode: selected.mode,
    mtime: selected.mtime,
    sourceIdentity: storeIdentity(selected, selected.cut.workspace),
  });
}

for (const size of [0, 1, 65535, 65536, 65537, 3 * 65536 + 7]) {
  test(`real service exports exact metadata and bounded file bytes for ${size}`, async () => {
    const value = fixture(["/file"], size);
    const observed = observe(value.workspace);
    try {
      const selected = await value.workspace.stat("/file");
      if (selected.kind !== "ok") throw new Error(selected.kind);
      let count = 0;
      const paths: string[] = [];
      let complete = false;
      for await (const event of parseWorkspaceArchive(exportWorkspaceArchive(observed.workspace))) {
        if (event.kind === "entry") {
          paths.push(event.entry.path);
          expectFileEntry(event.entry, selected.value, size);
        }
        if (event.kind === "data") {
          expect(event.bytes.length).toBeLessThanOrEqual(65536);
          expect(event.bytes.every((byte) => byte === 65)).toBe(true);
          count += event.bytes.length;
        }
        if (event.kind === "complete") complete = true;
      }
      expect(paths).toEqual(["/", "/file"]);
      expect(count).toBe(size);
      expect(complete).toBe(true);
      expect(observed.counts.pins).toBe(1);
      expect(observed.counts.closed).toBe(1);
      expect(observed.counts.largestRange).toBeLessThanOrEqual(WORKSPACE_EXPORT_LIMITS.chunkBytes);
      released(value);
    } finally {
      await value.close();
    }
  });
}

test("canonical component order spans unsorted multi-page public snapshots without sorting a corpus", async () => {
  const paths = ["/z", "/a-/file", "/a/z", "/a/a", "/a.a", "/😀/z", "/é/x"];
  for (let index = 135; index >= 0; index--) paths.push(`/wide/${String(index).padStart(3, "0")}`);
  const value = fixture(paths, 0);
  const observed = observe(value.workspace);
  try {
    const events = await consume(observed.workspace);
    const ordered = events.flatMap((event) => (event.kind === "entry" ? [event.entry.path] : []));
    const wide = Array.from(
      { length: 136 },
      (_, index) => `/wide/${String(index).padStart(3, "0")}`,
    );
    expect(ordered).toEqual(
      ["/", "/a", "/a/a", "/a/z", "/a-", "/a-/file", "/a.a", "/wide"].concat(wide, [
        "/z",
        "/é",
        "/é/x",
        "/😀",
        "/😀/z",
      ]),
    );
    expect(observed.counts.scans).toBe(ordered.length + 1);
    expect(observed.counts.pulls).toBeGreaterThan(observed.counts.scans * 2);
    released(value);
  } finally {
    await value.close();
  }
});

for (const phase of [
  "scan",
  "between-scans",
  "before-pin",
  "pinned-read",
  "final-pull",
  "final-scan",
] as const) {
  for (const mutation of ["write", "rename", "replace"] as const) {
    test(`real ${mutation} at ${phase} never completes a mixed archive`, async () => {
      const value = fixture(["/file"], 65537);
      let changed = false;
      const mutate = async () => {
        if (changed) return;
        changed = true;
        if (mutation === "rename") return value.client.asyncCall("move", ["/file", "/renamed"]);
        if (mutation === "replace") await value.client.asyncCall("remove", ["/file"]);
        await value.client.asyncCall("writeFile", ["/file"], encoder.encode("new"));
      };
      const observed = observe(value.workspace, {
        async page(page, scan) {
          if (phase === "scan" && scan === 1 && page.kind === "entries") await mutate();
          if (phase === "between-scans" && scan === 1 && page.kind === "complete") await mutate();
          if (phase === "final-scan" && scan === 3 && page.kind === "complete") await mutate();
          if (phase === "final-pull" && scan === 3 && page.kind === "entries") await mutate();
          return page;
        },
        async beforePin() {
          if (phase === "before-pin") await mutate();
        },
        async read(result) {
          if (phase === "pinned-read") await mutate();
          return result;
        },
      });
      try {
        if (phase === "final-scan") {
          // A mutation after the final completed cut is later than the exported source cut.
          const events = await consume(observed.workspace);
          expect(events.at(-1)?.kind).toBe("complete");
          const bytes = events.flatMap((event) => (event.kind === "data" ? [event.bytes] : []));
          expect(bytes.reduce((sum, part) => sum + part.length, 0)).toBe(65537);
          expect(bytes.every((part) => part.every((byte) => byte === 65))).toBe(true);
        } else {
          const failure = refusal(await rejected(observed.workspace));
          expect(["restart", "resnapshot", "version-gone"]).toContain(failure.kind);
        }
        expect(changed).toBe(true);
        released(value);
      } finally {
        await value.close();
      }
    });
  }
}

test("real lease reads retain untouched old bytes after a write, then final validation refuses the changed cut", async () => {
  const value = fixture(["/file"], 3 * 65536 + 1);
  const seen: number[] = [];
  const observed = observe(value.workspace, {
    async read(result) {
      if (result.kind === "ok") seen.push(result.value.bytes[0]!);
      if (seen.length === 1)
        await value.client.asyncCall("writeFile", ["/file"], new Uint8Array([90]));
      return result;
    },
  });
  try {
    expect(refusal(await rejected(observed.workspace)).kind).toBe("resnapshot");
    expect(seen).toEqual([65, 65, 65, 65]);
    released(value);
  } finally {
    await value.close();
  }
});

test("cursor and lease pressure are real public refusals and do not close caller-owned resources", async () => {
  const value = fixture();
  const cursors = [value.workspace.snapshot(), value.workspace.snapshot()];
  const leases: VersionLease[] = [];
  try {
    expect(refusal(await rejected(value.workspace))).toEqual({
      kind: "pressure",
      resource: "cursor",
    });
    for (const cursor of cursors) await cursor.close();
    for (let index = 0; index < 16; index++) {
      const result = await value.workspace.pin("/file");
      if (result.kind !== "ok") throw new Error(result.kind);
      leases.push(result.value);
    }
    expect(refusal(await rejected(value.workspace))).toEqual({
      kind: "pressure",
      resource: "leases",
    });
    expect(value.service.resources().readerLeases).toBe(16);
    for (const lease of leases) await lease.close();
    released(value);
    expect((await consume(value.workspace)).at(-1)?.kind).toBe("complete");
  } finally {
    await Promise.all(cursors.map((cursor) => cursor.close()));
    await Promise.all(leases.map((lease) => lease.close()));
    await value.close();
  }
});

for (const primary of [undefined, null, false, 0, ""]) {
  for (const resource of ["cursor", "lease"] as const) {
    test(`${resource} retains exact falsy primary ${String(primary)} plus cleanup identity`, async () => {
      const value = fixture();
      const cleanup = new Error("cleanup");
      const observed = observe(value.workspace, {
        async page(page) {
          if (resource === "cursor") throw primary;
          return page;
        },
        async read(result) {
          if (resource === "lease") throw primary;
          return result;
        },
        async cursorClose() {
          if (resource === "cursor") throw cleanup;
        },
        async leaseClose() {
          if (resource === "lease") throw cleanup;
        },
      });
      try {
        const error = await rejected(observed.workspace);
        if (!(error instanceof AggregateError)) throw error;
        expect(error.errors[0]).toBe(primary);
        expect(error.errors[1]).toBe(cleanup);
        released(value);
      } finally {
        await value.close();
      }
    });
  }
}

for (const cleanup of [undefined, null, false, 0, ""]) {
  test(`normal lease closure preserves falsy cleanup ${String(cleanup)}`, async () => {
    const value = fixture();
    const observed = observe(value.workspace, {
      async leaseClose() {
        throw cleanup;
      },
    });
    try {
      expect(await rejected(observed.workspace)).toBe(cleanup);
      released(value);
    } finally {
      await value.close();
    }
  });
}

test("pre-aborted export opens no resource and preserves the exact reason", async () => {
  const value = fixture();
  const controller = new AbortController();
  controller.abort(false);
  const observed = observe(value.workspace);
  try {
    expect(await rejected(observed.workspace, { signal: controller.signal })).toBe(false);
    expect(observed.counts.scans).toBe(0);
    expect(observed.counts.pins).toBe(0);
    released(value);
  } finally {
    await value.close();
  }
});

test("held native read cancellation joins original I/O and lease closure before rejecting", async () => {
  const physical = new RangeFixture();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let value: Awaited<ReturnType<typeof heldNativeReadFixture>> | undefined;
  let work: ReturnType<typeof capture> | undefined;
  try {
    value = await heldNativeReadFixture(physical, gate.promise, () => entered.resolve());
    const controller = new AbortController();
    let settled = false;
    work = capture(consume(value.value.workspace, { signal: controller.signal }));
    void work.then(() => {
      settled = true;
    });
    await entered.promise;
    controller.abort(0);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(value.storage.resources().opfsReaderWork).toBe(1);
    expect(value.value.service.resources().readerLeases).toBe(1);
    gate.resolve();
    const result = await work;
    expect(result).toEqual({ kind: "error", error: 0 });
    expect(value.storage.resources().opfsReaderWork).toBe(0);
    released(value.value);
  } finally {
    gate.resolve();
    await work;
    await value?.value.close();
    await physical.cleanup();
  }
});

for (const resource of ["cursor", "lease"] as const) {
  test(`abort during ${resource} delivery closes but joins the started rejecting pull`, async () => {
    const value = fixture();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let closes = 0;
    const closed = Promise.withResolvers<void>();
    const hold = async () => {
      controller.abort(false);
      entered.resolve();
      await gate.promise;
      throw 0;
    };
    const observed = observe(value.workspace, {
      async page(page) {
        if (resource === "cursor") return hold();
        return page;
      },
      async read(result) {
        if (resource === "lease") return hold();
        return result;
      },
      async cursorClose() {
        if (resource === "cursor") {
          closes++;
          closed.resolve();
        }
      },
      async leaseClose() {
        if (resource === "lease") {
          closes++;
          closed.resolve();
        }
      },
    });
    let work: ReturnType<typeof capture> | undefined;
    try {
      work = capture(consume(observed.workspace, { signal: controller.signal }));
      await entered.promise;
      let done = false;
      void work.then(() => {
        done = true;
      });
      await closed.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(done).toBe(false);
      gate.resolve();
      expect(await work).toEqual({ kind: "error", error: false });
      expect(closes).toBe(1);
      released(value);
    } finally {
      gate.resolve();
      await work;
      await value.close();
    }
  });
}

test("early consumer return closes the pinned lease even before payload pulls", async () => {
  const value = fixture();
  const observed = observe(value.workspace);
  const stream = exportWorkspaceArchive(observed.workspace);
  try {
    while (observed.counts.pins === 0) expect((await stream.next()).done).toBe(false);
    expect(value.service.resources().readerLeases).toBe(1);
    await stream.return(undefined);
    expect(observed.counts.reads).toBe(0);
    expect(observed.counts.closed).toBe(1);
    released(value);
  } finally {
    await stream.return(undefined);
    await value.close();
  }
});

for (const mismatch of ["version", "cut", "range", "size", "backing"] as const) {
  test(`deliberately broken lease ${mismatch} cannot finish a valid archive`, async () => {
    const value = fixture();
    const observed = observe(value.workspace, {
      async read(result) {
        if (result.kind !== "ok") return result;
        const read = result.value;
        if (mismatch === "version")
          return {
            kind: "ok",
            value: {
              ...read,
              stat: {
                ...read.stat,
                ...parseFileIdentity({
                  id: read.stat.id.toString(16),
                  version: (read.stat.version + 1n).toString(16),
                }),
              },
            },
          };
        if (mismatch === "cut")
          return {
            kind: "ok",
            value: {
              ...read,
              stat: { ...read.stat, cut: { ...read.stat.cut, workspace: crypto.randomUUID() } },
            },
          };
        if (mismatch === "range")
          return {
            kind: "ok",
            value: { ...read, range: { offset: 1, length: read.range.length } },
          };
        if (mismatch === "size")
          return { kind: "ok", value: { ...read, bytes: read.bytes.subarray(1) } };
        return { kind: "ok", value: { ...read, bytes: new Uint8Array(1024).subarray(1, 4) } };
      },
    });
    try {
      expect(["contract", "resnapshot"]).toContain(
        refusal(await rejected(observed.workspace)).kind,
      );
      released(value);
    } finally {
      await value.close();
    }
  });
}

test("archive budget refusal releases the actual lease", async () => {
  const value = fixture();
  try {
    const error = await rejected(value.workspace, {
      budget: { maxEntries: 1, maxFileBytes: 3, maxTotalBytes: 3 },
    });
    expect(error).toMatchObject({ code: "LIMIT" });
    released(value);
  } finally {
    await value.close();
  }
});

for (const cleanup of [undefined, null, false, 0, ""]) {
  test(`normal cursor closure preserves falsy cleanup ${String(cleanup)}`, async () => {
    const value = fixture();
    const observed = observe(value.workspace, {
      async cursorClose() {
        throw cleanup;
      },
    });
    try {
      expect(await rejected(observed.workspace)).toBe(cleanup);
      released(value);
    } finally {
      await value.close();
    }
  });
}

test("empty workspace is a complete root-only archive", async () => {
  const value = fixture([]);
  try {
    const events = await consume(value.workspace);
    expect(events.flatMap((event) => (event.kind === "entry" ? [event.entry.path] : []))).toEqual([
      "/",
    ]);
    expect(events.at(-1)).toEqual({ kind: "complete", summary: { entries: 1, fileBytes: 0 } });
    released(value);
  } finally {
    await value.close();
  }
});

test("large real memory file streams through one bounded lease with consumer backpressure", async () => {
  const value = fixture(["/file"], 8 * 1024 * 1024 + 1);
  const observed = observe(value.workspace);
  const source = exportWorkspaceArchive(observed.workspace);
  try {
    let bytes = 0;
    for await (const event of parseWorkspaceArchive(source)) {
      if (event.kind !== "data") continue;
      bytes += event.bytes.length;
      const reads = observed.counts.reads;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observed.counts.reads).toBe(reads);
      expect(value.service.resources().readerLeases).toBe(1);
    }
    expect(bytes).toBe(8 * 1024 * 1024 + 1);
    expect(observed.counts.reads).toBe(129);
    expect(observed.counts.largestRange).toBe(65536);
    released(value);
  } finally {
    await source.return(undefined);
    await value.close();
  }
});

test("denied file data is a real permission refusal, not an empty successful entry", async () => {
  const value = fixture();
  try {
    const root = await value.client.asyncCall("preopen", ["/"]);
    const handle = (await value.client.asyncCall("resolve", [root, "file"])).node;
    value.client.retain(handle);
    value.backend.shared.mutate(undefined, undefined, () =>
      value.backend.shared.setMode(handle, 0),
    );
    expect(refusal(await rejected(value.workspace))).toEqual({ kind: "denied" });
    released(value);
  } finally {
    await value.close();
  }
});

for (const dimension of ["workspace", "history", "generation", "sequence"] as const) {
  test(`same-looking completed snapshot with foreign ${dimension} requires resnapshot`, async () => {
    const value = fixture();
    const observed = observe(value.workspace, {
      async page(page, scan) {
        if (page.kind !== "complete" || scan !== 3) return page;
        const cut = page.cut;
        if (dimension === "workspace")
          return { kind: "complete", cut: { ...cut, workspace: crypto.randomUUID() } };
        if (dimension === "history")
          return {
            kind: "complete",
            cut: { ...cut, watermark: { ...cut.watermark, history: crypto.randomUUID() } },
          };
        // These are actual branded cuts selected after an actual mutation, not fabricated numeric brands.
        await value.client.asyncCall("writeFile", ["/new"], new Uint8Array());
        const newer = await value.workspace.stat("/");
        if (newer.kind !== "ok") throw new Error(newer.kind);
        if (dimension === "generation")
          return { kind: "complete", cut: { ...cut, generation: newer.value.cut.generation } };
        return {
          kind: "complete",
          cut: { ...cut, watermark: { ...cut.watermark, seq: newer.value.cut.watermark.seq } },
        };
      },
    });
    try {
      expect(refusal(await rejected(observed.workspace)).kind).toBe("resnapshot");
      released(value);
    } finally {
      await value.close();
    }
  });
}

test("endless empty snapshot pages hit a fixed scan budget and close the cursor", async () => {
  const value = fixture();
  const observed = observe(value.workspace, {
    async page() {
      return { kind: "entries", entries: [] };
    },
  });
  try {
    expect(refusal(await rejected(observed.workspace))).toEqual({ kind: "scan-limit" });
    expect(observed.counts.pulls).toBe(WORKSPACE_EXPORT_LIMITS.scanPages);
    released(value);
  } finally {
    await value.close();
  }
});

test("synchronous abort inside cursor.next observes its started rejection and calls close once", async () => {
  const value = fixture();
  const controller = new AbortController();
  let closes = 0;
  const workspace: WorkspaceVfs = {
    ...value.workspace,
    snapshot(options, signal) {
      const cursor = value.workspace.snapshot(options, signal);
      return {
        next() {
          const work = cursor.next().then(() => {
            throw 0;
          });
          controller.abort(false);
          return work;
        },
        async close() {
          closes++;
          await cursor.close();
        },
      };
    },
  };
  try {
    expect(await rejected(workspace, { signal: controller.signal })).toBe(false);
    expect(closes).toBe(1);
    released(value);
  } finally {
    await value.close();
  }
});

test("consumer return awaits failing lease cleanup and keeps its exact falsy value", async () => {
  const value = fixture();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const observed = observe(value.workspace, {
    async leaseClose() {
      entered.resolve();
      await gate.promise;
      throw false;
    },
  });
  const source = exportWorkspaceArchive(observed.workspace);
  let closing: ReturnType<typeof capture> | undefined;
  try {
    while (!observed.counts.pins) await source.next();
    closing = capture(source.return(undefined));
    await entered.promise;
    let done = false;
    void closing.then(() => {
      done = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    gate.resolve();
    expect(await closing).toEqual({ kind: "error", error: false });
    released(value);
  } finally {
    gate.resolve();
    await closing;
    await source.return(undefined);
    await value.close();
  }
});

for (const delivery of ["lease", "rejection"] as const) {
  test(`abort joins a held pin ${delivery} and closes a late real lease`, async () => {
    const value = fixture();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let acquired: VersionLease | undefined;
    const workspace: WorkspaceVfs = {
      ...value.workspace,
      async pin(target, version, signal) {
        const result = await value.workspace.pin(target, version, signal);
        if (result.kind === "ok") acquired = result.value;
        entered.resolve();
        await gate.promise;
        if (delivery === "lease") return result;
        await acquired?.close();
        throw 0;
      },
    };
    let work: ReturnType<typeof capture> | undefined;
    try {
      work = capture(consume(workspace, { signal: controller.signal }));
      await entered.promise;
      controller.abort(false);
      let settled = false;
      void work.then(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      gate.resolve();
      expect(await work).toEqual({ kind: "error", error: false });
      released(value);
    } finally {
      gate.resolve();
      await work;
      await acquired?.close();
      await value.close();
    }
  });
}

function changedStat(stat: VersionStat, field: string): VersionStat {
  if (field === "id" || field === "version")
    return {
      ...stat,
      ...parseFileIdentity({
        id: (stat.id - (field === "id" ? 1n : 0n)).toString(16),
        version: (stat.version + (field === "version" ? 1n : 0n)).toString(16),
      }),
    };
  if (field === "cut") return { ...stat, cut: { ...stat.cut, workspace: crypto.randomUUID() } };
  if (field === "kind") return { ...stat, kind: "directory" };
  if (field === "size") return { ...stat, size: stat.size + 1 };
  if (field === "mtime") return { ...stat, mtime: stat.mtime + 1 };
  if (field === "mode") return { ...stat, mode: stat.mode ^ 1 };
  throw new Error(`Unknown stat field ${field}`);
}

for (const size of [0, 3]) {
  for (const field of ["id", "version", "kind", "size", "mtime", "mode", "cut"]) {
    test(`acquired lease ${field} mismatch refuses before reads for ${size} bytes`, async () => {
      const value = fixture(["/file"], size);
      const observed = observe(value.workspace, { pinStat: (stat) => changedStat(stat, field) });
      try {
        expect(refusal(await rejected(observed.workspace)).kind).toBe(field === "cut" ? "resnapshot" : "contract");
        expect(observed.counts.pins).toBe(1);
        expect(observed.counts.reads).toBe(0);
        expect(observed.counts.closed).toBe(1);
        released(value);
      } finally {
        await value.close();
      }
    });
  }
}

for (const field of ["kind", "size", "mtime", "mode"]) {
  test(`read stat ${field} mismatch cannot complete an archive`, async () => {
    const value = fixture();
    const observed = observe(value.workspace, {
      async read(result) {
        if (result.kind !== "ok") return result;
        return { kind: "ok", value: { ...result.value, stat: changedStat(result.value.stat, field) } };
      },
    });
    try {
      expect(refusal(await rejected(observed.workspace)).kind).toBe("contract");
      expect(observed.counts.reads).toBe(1);
      released(value);
    } finally {
      await value.close();
    }
  });
}

for (const delivery of ["page", "read"] as const) {
  test(`fulfilled ${delivery} observes then once and preserves delivered accessors`, async () => {
    const value = fixture();
    let thenReads = 0;
    let kindReads = 0;
    const sentinel = new Error("second observation");
    function delivered<T extends object & { kind: string }>(original: T): T {
      if (thenReads) return original;
      return Object.defineProperties({ ...original }, {
        then: { get() { if (++thenReads > 1) throw sentinel; return undefined; } },
        kind: { get() { kindReads++; return original.kind; } },
      });
    }
    const workspace: WorkspaceVfs = {
      ...value.workspace,
      snapshot(options, signal) {
        const cursor = value.workspace.snapshot(options, signal);
        return {
          next: () => cursor.next().then((page) => delivery === "page" ? delivered(page) : page),
          close: () => cursor.close(),
        };
      },
      async pin(target, version, signal) {
        const result = await value.workspace.pin(target, version, signal);
        if (result.kind !== "ok") return result;
        const lease = result.value;
        return { kind: "ok", value: {
          stat: lease.stat,
          read: (range, readSignal) => lease.read(range, readSignal).then((read) => delivery === "read" ? delivered(read) : read),
          close: () => lease.close(),
        } };
      },
    };
    try {
      expect((await consume(workspace)).at(-1)?.kind).toBe("complete");
      expect(thenReads).toBe(1);
      expect(kindReads).toBeGreaterThan(0);
      released(value);
    } finally {
      await value.close();
    }
  });
}

for (const reason of [undefined, null, false, 0, ""]) {
  test(`provider then getter rejection retains exact falsy ${String(reason)}`, async () => {
    const value = fixture();
    let reads = 0;
    const workspace: WorkspaceVfs = {
      ...value.workspace,
      snapshot(options, signal) {
        const cursor = value.workspace.snapshot(options, signal);
        return {
          next: () => cursor.next().then((page) => Object.defineProperty(page, "then", { get() { reads++; throw reason; } })),
          close: () => cursor.close(),
        };
      },
    };
    try {
      expect(await rejected(workspace)).toBe(reason);
      expect(reads).toBe(1);
      released(value);
    } finally {
      await value.close();
    }
  });
}

for (const path of ["/a\\b", "/a\ud800b", "/a\udfffb"]) {
  test(`valid workspace path ${JSON.stringify(path)} is an explicit archive format limitation`, async () => {
    const value = fixture([path]);
    try {
      expect((await value.workspace.stat(path)).kind).toBe("ok");
      expect(refusal(await rejected(value.workspace))).toEqual({ kind: "format-path", path });
      released(value);
    } finally {
      await value.close();
    }
  });
}

for (const backing of ["shared", "resizable"] as const) {
  test(`broken ${backing} range backing is refused without retaining the real lease`, async () => {
    const value = fixture();
    const observed = observe(value.workspace, {
      async read(result) {
        if (result.kind !== "ok") return result;
        const length = result.value.bytes.length;
        const buffer = backing === "shared" ? new SharedArrayBuffer(length) : new ArrayBuffer(length, { maxByteLength: length * 2 });
        return { kind: "ok", value: Object.defineProperty({ ...result.value }, "bytes", { value: new Uint8Array(buffer) }) };
      },
    });
    try {
      expect(refusal(await rejected(observed.workspace)).kind).toBe("contract");
      released(value);
    } finally {
      await value.close();
    }
  });
}

test("directory traversal denial maps to the same explicit denial as file reads", async () => {
  const value = fixture(["/directory/file"]);
  try {
    const root = await value.client.asyncCall("preopen", ["/"]);
    const handle = (await value.client.asyncCall("resolve", [root, "directory"])).node;
    value.client.retain(handle);
    value.backend.shared.mutate(undefined, undefined, () => value.backend.shared.setMode(handle, 0));
    expect(refusal(await rejected(value.workspace))).toEqual({ kind: "denied" });
    released(value);
  } finally {
    await value.close();
  }
});

for (const kind of ["count", "metadata"] as const) {
  test(`bounded successor windows preserve every path across ${kind} limits`, async () => {
    const prefix = kind === "metadata" ? "p".repeat(3500) : "p";
    const count = kind === "metadata" ? 24 : 384;
    const paths = Array.from({ length: count }, (_, index) => `/${prefix}${String(index).padStart(4, "0")}`);
    const value = fixture(paths.toReversed(), 0);
    const observed = observe(value.workspace);
    try {
      const events = await consume(observed.workspace);
      expect(events.flatMap((event) => event.kind === "entry" ? [event.entry.path] : [])).toEqual(["/"].concat(paths));
      expect(events.at(-1)?.kind).toBe("complete");
      expect(observed.counts.scans).toBeLessThan(count / 2);
      expect(observed.counts.scans).toBeGreaterThan(2);
      released(value);
    } finally {
      await value.close();
    }
  });
}
