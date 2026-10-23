import { expect, expectTypeOf, test } from "bun:test";
import {
  createFilesystemConnection,
  createWorkspaceVfs,
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  type ByteRange,
  type FileTarget,
  type FileVersion,
  type NamespaceCut,
  type ReadOutcome,
  type ReadValue,
  type SnapshotOptions,
  type SnapshotPage,
  type VersionLease,
  type Watermark,
  type WorkspaceChangePage,
  type WorkspaceVfs,
  createWorkspaceSearch,
  WORKSPACE_SEARCH_LIMITS,
  type IndexStamp,
  type IndexValidation,
  type SearchTerminal,
  type SearchCursor,
  type SearchHit,
  type SearchLimits,
  type SearchPage,
  type SearchQuery,
  type WorkspaceSearch,
} from "../fs";
import { getVfsDescriptor } from "../fs/vfs";
import { workspacePublication } from "../fs/workspace-protocol";

const bytes = (value: string) => new TextEncoder().encode(value);
const query: SearchQuery = { kind: "text", prefix: "/", text: "TODO" };
function gate() {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
class Boundaries implements WorkspaceVfs {
  snapshotReply?: (page: SnapshotPage) => Promise<void>;
  snapshotCloseReply?: () => Promise<void>;
  changesReply?: (page: WorkspaceChangePage) => Promise<WorkspaceChangePage>;
  readReply?: (result: ReadOutcome<ReadValue>) => Promise<void>;
  closeReply?: () => Promise<void>;
  beforePin?: () => Promise<void>;
  readonly ranges: ByteRange[] = [];
  snapshots = 0;
  changesCalls = 0;
  pins = 0;
  closes = 0;
  constructor(readonly source: WorkspaceVfs) {}
  read(...args: Parameters<WorkspaceVfs["read"]>) {
    return this.source.read(...args);
  }
  stat(...args: Parameters<WorkspaceVfs["stat"]>) {
    return this.source.stat(...args);
  }
  close() {
    return this.source.close();
  }
  snapshot(options?: SnapshotOptions, signal?: AbortSignal) {
    this.snapshots++;
    const cursor = this.source.snapshot(options, signal);
    let closing: Promise<void> | undefined;
    const close = async () => {
      await cursor.close();
      await this.snapshotCloseReply?.();
    };
    return {
      next: async () => {
        const page = await cursor.next();
        await this.snapshotReply?.(page);
        return page;
      },
      close: () => (closing ??= close()),
    };
  }
  async changes(after: Watermark, signal?: AbortSignal) {
    this.changesCalls++;
    const page = await this.source.changes(after, signal);
    return this.changesReply ? this.changesReply(page) : page;
  }
  async pin(
    target: FileTarget,
    version?: FileVersion,
    signal?: AbortSignal,
  ): Promise<ReadOutcome<VersionLease>> {
    this.pins++;
    await this.beforePin?.();
    const selected = await this.source.pin(target, version, signal);
    if (selected.kind !== "ok") return selected;
    const lease = selected.value;
    let closing: Promise<void> | undefined;
    return {
      kind: "ok",
      value: {
        stat: lease.stat,
        read: async (range, readSignal) => {
          if (!range) throw new Error("search requested an unbounded range");
          this.ranges.push(range);
          const result = await lease.read(range, readSignal);
          await this.readReply?.(result);
          return result;
        },
        close: () => (closing ??= this.closeLease(lease)),
      },
    };
  }
  private async closeLease(lease: VersionLease) {
    this.closes++;
    await lease.close();
    await this.closeReply?.();
  }
}
async function fixture(tinyRing = false) {
  const configuration: Parameters<typeof createFilesystemConnection>[1] = tinyRing
    ? {
        observe: true,
        limits: {
          ...workspacePublication.limits,
          logRecords: 2,
          logBytes: 16384,
          effectBytes: 8192,
        },
      }
    : { workspace: true };
  const pair = createFilesystemConnection(undefined, configuration);
  const service = new FilesystemService(new MemoryBackend());
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  const workspace = createWorkspaceVfs(client);
  const boundary = new Boundaries(workspace);
  const searches = new Set<WorkspaceSearch>();
  return {
    client,
    workspace,
    boundary,
    service,
    search(limits?: Partial<SearchLimits>) {
      const search = createWorkspaceSearch(
        { workspace: boundary, vfs: getVfsDescriptor("memory") },
        limits,
      );
      searches.add(search);
      return search;
    },
    async write(path: string, content: string | Uint8Array = "TODO") {
      await client.asyncCall(
        "writeFile",
        [path],
        typeof content === "string" ? bytes(content) : content,
      );
    },
    async [Symbol.asyncDispose]() {
      for (const search of searches) await search.close().catch(() => {});
      await workspace.close();
      client.dispose();
      await service.drainForOwner();
      expect(service.resources().workspaceCursors).toBe(0);
      expect(service.resources().readerLeases ?? 0).toBe(0);
      expect(service.resources().readerOperations ?? 0).toBe(0);
      expect(service.resources().readerResultBytes ?? 0).toBe(0);
      expect(client.completions.size).toBe(0);
      service.dispose();
      pair.client.port.close();
      pair.server.port.close();
    },
  };
}
class Consumer {
  hits: SearchHit[] = [];
  cut?: NamespaceCut;
  accept(page: SearchPage) {
    if (page.kind === "checkpoint") return;
    if (page.kind !== "delta") {
      this.hits = [];
      return;
    }
    for (const removal of page.retract) {
      expect(removal).toEqual({ kind: "all" });
      this.hits = [];
    }
    this.hits = this.hits.concat(page.add);
    this.cut = page.cut;
  }
}
async function caughtUp(cursor: SearchCursor, consumer = new Consumer()) {
  for (let turn = 0; turn < 1000; turn++) {
    const page = await cursor.next();
    consumer.accept(page);
    if (page.kind === "checkpoint") return { consumer, stamp: page.stamp };
    if (page.kind !== "delta")
      throw new Error(
        `search returned ${JSON.stringify(page, (_, v) => (typeof v === "bigint" ? String(v) : v))}`,
      );
  }
  throw new Error("search did not reach its checkpoint");
}

test("real public memory search returns exact identities and literal UTF-8 offsets", async () => {
  await using value = await fixture();
  await value.write("/src/a", "zééé");
  await value.write("/src2/b", "éé");
  const search = value.search({ chunkBytes: 2, pageHits: 1 });
  const cursor = search.search({ kind: "text", prefix: "/src", text: "éé" });
  const { consumer, stamp } = await caughtUp(cursor);
  expect(consumer.hits.map((hit) => (hit.kind === "text" ? hit.offset : -1))).toEqual([1, 3]);
  const stat = await value.workspace.stat("/src/a");
  if (stat.kind !== "ok") throw new Error(stat.kind);
  expect(consumer.hits).toEqual(
    [1, 3].map((offset) => ({
      kind: "text",
      id: stat.value.id,
      version: stat.value.version,
      path: "/src/a",
      offset,
      length: 4,
    })),
  );
  expect(stamp.workspace).toBe(stat.value.cut.workspace);
  expect(value.boundary.ranges.every((range) => range.length <= 2)).toBe(true);
  expect(value.boundary.closes).toBe(value.boundary.pins);
  await cursor.close();
  expect((await value.workspace.read("/src/a", { offset: 0, length: 1 })).kind).toBe("ok");
});

test("snapshot-subscribe race uses the actual change feed before publishing any hit", async () => {
  await using value = await fixture();
  await value.write("/file");
  let changed = false;
  value.boundary.snapshotReply = async (page) => {
    if (page.kind !== "complete" || changed) return;
    changed = true;
    await value.write("/file", "gone");
    await value.write("/new");
  };
  const { consumer } = await caughtUp(value.search().search(query));
  expect(consumer.hits.map((hit) => hit.path)).toEqual(["/new"]);
  expect(value.boundary.changesCalls).toBeGreaterThan(0);
});

test("real write retracts delivered matches at the new cut and rebuilds", async () => {
  await using value = await fixture();
  await value.write("/file");
  const cursor = value.search().search(query);
  const { consumer, stamp } = await caughtUp(cursor);
  expect(consumer.hits).toHaveLength(1);
  await value.write("/file", "gone");
  const page = await cursor.next();
  expect(page.kind).toBe("delta");
  consumer.accept(page);
  expect(consumer.hits).toHaveLength(0);
  expect(consumer.cut!.watermark.seq).toBeGreaterThan(stamp.watermark.seq);
  expect((await caughtUp(cursor, consumer)).consumer.hits).toHaveLength(0);
});

test("held old-version read describes only its sampled cut, then retracts before advancing", async () => {
  await using value = await fixture();
  await value.write("/file");
  const entered = gate(),
    release = gate();
  value.boundary.readReply = async () => {
    entered.release();
    await release.wait;
  };
  const cursor = value.search().search(query),
    consumer = new Consumer();
  try {
    const pending = cursor.next();
    await entered.wait;
    const before = await value.workspace.stat("/file");
    await value.write("/file", "gone");
    expect(await cursor.next()).toEqual({ kind: "pressure", resource: "pull" });
    release.release();
    const old = await pending;
    consumer.accept(old);
    expect(old.kind).toBe("delta");
    if (old.kind !== "delta" || before.kind !== "ok") throw new Error("missing old cut");
    expect(old.cut.watermark.seq).toBe(before.value.cut.watermark.seq);
    expect(consumer.hits).toHaveLength(1);
    consumer.accept(await cursor.next());
    expect(consumer.hits).toHaveLength(0);
  } finally {
    release.release();
  }
});

test("directory move, replacement, hardlink and unlink rebuild actual names without prefix collateral", async () => {
  await using value = await fixture();
  await value.write("/a/child");
  await value.write("/ab/child");
  const root = await value.client.asyncCall("preopen", ["/"]);
  const from = await value.client.asyncCall("resolve", [root, "a/child"]);
  const to = await value.client.asyncCall("resolve", [root, "alias"]);
  expect(await value.client.asyncCall("link", [from, to])).toBe(0);
  const cursor = value.search().search(query);
  const initial = await caughtUp(cursor);
  expect(initial.consumer.hits).toHaveLength(3);
  await value.client.asyncCall("move", ["/a", "/b"]);
  const renamed = await caughtUp(cursor, initial.consumer);
  expect(renamed.consumer.hits.map((hit) => hit.path).sort()).toEqual([
    "/ab/child",
    "/alias",
    "/b/child",
  ]);
  const id = renamed.consumer.hits.find((hit) => hit.path === "/b/child")!.id;
  await value.client.asyncCall("remove", ["/b/child"]);
  await value.write("/b/child", "new TODO");
  const replaced = await caughtUp(cursor, initial.consumer);
  expect(replaced.consumer.hits.find((hit) => hit.path === "/b/child")!.id).not.toBe(id);
  expect(replaced.consumer.hits.find((hit) => hit.path === "/alias")!.id).toBe(id);
  await value.client.asyncCall("remove", ["/alias"]);
  expect(
    (await caughtUp(cursor, initial.consumer)).consumer.hits.map((hit) => hit.path).sort(),
  ).toEqual(["/ab/child", "/b/child"]);
});

test("real overwritten ring gap is terminal, clears results, and a fresh cursor resnapshots", async () => {
  await using value = await fixture(true);
  await value.write("/file");
  const search = value.search(),
    cursor = search.search(query);
  const { consumer } = await caughtUp(cursor);
  for (let index = 0; index < 5; index++) await value.write(`/new${index}`);
  const page = await cursor.next();
  expect(page.kind).toBe("gap");
  consumer.accept(page);
  expect(consumer.hits).toHaveLength(0);
  expect(await cursor.next()).toEqual(page);
  if (page.kind !== "gap") throw new Error("missing authority gap");
  expect((await value.workspace.changes(page.current.watermark)).kind).toBe("gap");
  expect((await caughtUp(search.search(query))).consumer.hits).toHaveLength(6);
});

for (const stage of ["snapshot", "changes", "read", "close"] as const) {
  test(`abort during held ${stage} joins borrowed resources and rejects late additions`, async () => {
    await using value = await fixture();
    await value.write("/file");
    const entered = gate(),
      release = gate(),
      controller = new AbortController();
    const hold = async () => {
      entered.release();
      await release.wait;
    };
    if (stage === "snapshot") value.boundary.snapshotReply = hold;
    if (stage === "changes")
      value.boundary.changesReply = async (page) => {
        await hold();
        return page;
      };
    if (stage === "read") value.boundary.readReply = hold;
    if (stage === "close") value.boundary.closeReply = hold;
    const search = value.search(),
      cursor = search.search(query, controller.signal);
    try {
      const pending = cursor.next();
      await entered.wait;
      controller.abort();
      let closed = false;
      const closing = cursor.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(await search.search(query).next()).toEqual({ kind: "pressure", resource: "query" });
      release.release();
      expect(await pending).toEqual({ kind: "cancelled" });
      await closing;
      expect(await cursor.next()).toEqual({ kind: "cancelled" });
      expect(value.boundary.pins).toBe(value.boundary.closes);
      value.boundary.snapshotReply = undefined;
      value.boundary.changesReply = undefined;
      value.boundary.readReply = undefined;
      value.boundary.closeReply = undefined;
      expect((await caughtUp(search.search(query))).consumer.hits).toHaveLength(1);
    } finally {
      release.release();
    }
  });
}

test("one pull scans one bounded range, releases the lease, and never runs while idle", async () => {
  await using value = await fixture();
  await value.write("/big", new Uint8Array(65536).fill(65));
  const root = await value.client.asyncCall("preopen", ["/"]);
  const handle = (await value.client.asyncCall("resolve", [root, "big"])).node;
  value.client.retain(handle);
  for (let part = 0; part < 2; part++)
    await value.client.asyncCall("append", [handle], new Uint8Array(65536).fill(65));
  await value.client.asyncCall("append", [handle], new Uint8Array(3).fill(65));
  const cursor = value.search().search({ kind: "text", prefix: "/", text: "not there" });
  expect(value.boundary.snapshots).toBe(0);
  expect(value.boundary.pins).toBe(0);
  const page = await cursor.next();
  expect(page.kind).toBe("delta");
  expect(value.boundary.ranges).toEqual([{ offset: 0, length: 65536 }]);
  expect(value.boundary.closes).toBe(1);
  await Promise.resolve();
  expect(value.boundary.ranges).toHaveLength(1);
  const result = await caughtUp(cursor);
  expect(result.consumer.hits).toHaveLength(0);
  expect(value.boundary.ranges).toHaveLength(4);
});

for (const [limit, amount, resource] of [
  ["nameBytes", 0, "index"],
  ["entries", 0, "index"],
  ["queueBytes", 0, "queue"],
  ["resultBytes", 0, "results"],
  ["outputBytes", 256, "results"],
  ["totalBytes", 0, "index"],
] as const) {
  test(`tiny ${limit} returns ${resource} pressure without an incomplete checkpoint`, async () => {
    await using value = await fixture();
    await value.write("/file");
    const cursor = value.search({ [limit]: amount }).search(query);
    const page = await cursor.next();
    expect(page).toEqual({ kind: "pressure", resource });
    expect(await cursor.next()).toEqual(page);
    expect(value.boundary.pins).toBe(value.boundary.closes);
  });
}

test("path-only search is segment-scoped and never acquires a byte lease", async () => {
  await using value = await fixture();
  await value.write("/src/a");
  await value.write("/src2/a");
  const { consumer } = await caughtUp(
    value.search().search({ kind: "files", prefix: "/src", text: "a" }),
  );
  expect(consumer.hits.map((hit) => hit.path)).toEqual(["/src/a"]);
  expect(consumer.hits[0]!.kind).toBe("file");
  expect(value.boundary.pins).toBe(0);
});

test("manifest freshness uses a new real snapshot and distinguishes invalid, stale and gap", async () => {
  await using value = await fixture();
  await value.write("/file");
  const search = value.search(),
    cursor = search.search(query);
  const { stamp } = await caughtUp(cursor);
  expect(await search.validateIndex(stamp, query)).toEqual({ kind: "pressure", resource: "query" });
  await cursor.close();
  expect((await search.validateIndex(stamp, query)).kind).toBe("valid");
  const variants: readonly [
    unknown,
    (IndexValidation | SearchTerminal)["kind"],
    Extract<IndexValidation, { kind: "gap" | "stale" }>["reason"] | undefined,
  ][] = [
    [null, "invalid", undefined],
    [{ ...stamp, generation: -1n }, "invalid", undefined],
    [{ ...stamp, workspace: crypto.randomUUID() }, "gap", "workspace"],
    [
      { ...stamp, watermark: { ...stamp.watermark, history: crypto.randomUUID() } },
      "gap",
      "history",
    ],
    [{ ...stamp, format: "other" }, "stale", "format"],
    [{ ...stamp, schema: 2 }, "stale", "schema"],
    [{ ...stamp, filesystem: { ...stamp.filesystem, format: "other" } }, "stale", "format"],
    [{ ...stamp, filesystem: { ...stamp.filesystem, schema: 2 } }, "stale", "schema"],
    [{ ...stamp, query: { kind: "files", prefix: "/", text: "" } }, "stale", "query"],
    [{ ...stamp, generation: stamp.generation + 1n }, "gap", "position"],
  ];
  for (const [saved, kind, reason] of variants) {
    const result = await search.validateIndex(saved, query);
    expect(result.kind).toBe(kind);
    if (reason) expect("reason" in result && result.reason).toBe(reason);
  }
  await value.write("/file", "new");
  expect(await search.validateIndex(stamp, query)).toMatchObject({
    kind: "stale",
    reason: "behind",
    action: "rebuild",
  });
});

test("already aborted and invalid queries do no work; close leaves the borrowed workspace usable", async () => {
  await using value = await fixture();
  const search = value.search(),
    controller = new AbortController();
  controller.abort();
  expect(await search.search(query, controller.signal).next()).toEqual({ kind: "cancelled" });
  for (const prefix of ["relative", "/a/../b", "/a//b", "/a/", "/a\0b"]) {
    expect(await search.search({ ...query, prefix }).next()).toEqual({
      kind: "invalid",
      field: "query",
    });
  }
  expect(await search.search({ ...query, text: "" }).next()).toEqual({
    kind: "invalid",
    field: "query",
  });
  expect(value.boundary.snapshots).toBe(0);
  await search.close();
  await value.write("/still-live");
  expect((await value.workspace.stat("/still-live")).kind).toBe("ok");
  expect(await search.search(query).next()).toEqual({ kind: "stopped" });
});

test("lease cleanup rejection stays failed and never releases the query slot as clean", async () => {
  await using value = await fixture();
  await value.write("/file");
  value.boundary.closeReply = async () => {
    throw new Error("held release failed");
  };
  const search = value.search(),
    cursor = search.search(query);
  expect(await cursor.next()).toMatchObject({
    kind: "cleanup-failed",
    message: "held release failed",
  });
  await expect(cursor.close()).rejects.toThrow("held release failed");
  expect(await search.search(query).next()).toEqual({ kind: "pressure", resource: "query" });
  await expect(search.close()).rejects.toThrow("held release failed");
});

test("public search types retain the authoritative identity, version and cut brands", () => {
  expectTypeOf<SearchHit["version"]>().toEqualTypeOf<FileVersion>();
  expectTypeOf<IndexStamp["generation"]>().toEqualTypeOf<NamespaceCut["generation"]>();
  expectTypeOf<Extract<SearchTerminal, { kind: "read-failed" }>["failure"]>().toEqualTypeOf<
    import("../fs").ReadFailure
  >();
  expectTypeOf<
    Extract<IndexValidation, { kind: "valid" }>["current"]
  >().toEqualTypeOf<NamespaceCut>();
  expect(WORKSPACE_SEARCH_LIMITS.chunkBytes).toBe(65536);
});

test("many overlapping matches stop at output credits without retaining a lease or skipping bytes", async () => {
  await using value = await fixture();
  await value.write("/file", "aaaaaa");
  const search = value.search({ pageHits: 1, chunkBytes: 6 });
  const { consumer } = await caughtUp(search.search({ ...query, text: "aa" }));
  expect(consumer.hits.map((hit) => (hit.kind === "text" ? hit.offset : -1))).toEqual([
    0, 1, 2, 3, 4,
  ]);
  expect(value.boundary.pins).toBe(value.boundary.closes);
  expect(value.boundary.ranges.map((range) => range.offset)).toEqual([0, 2, 3, 4, 5]);
});

test("a competing actual snapshot at a newer cut cannot silently replace the search feed position", async () => {
  await using value = await fixture();
  await value.write("/file");
  const search = value.search(),
    cursor = search.search(query);
  await caughtUp(cursor);
  await value.write("/file", "new TODO");
  const foreign = value.workspace.snapshot();
  try {
    while ((await foreign.next()).kind === "entries") {}
  } finally {
    await foreign.close();
  }
  expect((await cursor.next()).kind).toBe("gap");
  expect((await caughtUp(search.search(query))).consumer.hits).toHaveLength(1);
});

test("actual unfinished snapshot mutation returns restart before any bytes or hits", async () => {
  await using value = await fixture();
  await value.write("/file");
  let mutated = false;
  value.boundary.snapshotReply = async (page) => {
    if (mutated || page.kind !== "entries") return;
    mutated = true;
    await value.write("/new");
  };
  const page = await value.search().search(query).next();
  expect(page.kind).toBe("restart");
  expect(value.boundary.pins).toBe(0);
});

test("a real version disappearing between feed pull and pin cannot certify completeness", async () => {
  await using value = await fixture();
  await value.write("/file");
  value.boundary.beforePin = async () => {
    await value.write("/file", "changed");
  };
  const page = await value.search().search(query).next();
  expect(page).toMatchObject({ kind: "read-failed", failure: { kind: "version-gone" } });
});

test("actual reader lease pressure propagates instead of skipping a file", async () => {
  await using value = await fixture();
  await value.write("/file");
  const leases: VersionLease[] = [];
  try {
    for (let index = 0; index < 16; index++) {
      const pin = await value.workspace.pin("/file");
      if (pin.kind !== "ok") throw new Error(pin.kind);
      leases.push(pin.value);
    }
    expect(await value.search().search(query).next()).toMatchObject({
      kind: "read-failed",
      failure: { kind: "pressure", resource: "leases" },
    });
  } finally {
    for (const lease of leases) await lease.close();
  }
});

test("real read permission denial is explicit rather than a successful empty result", async () => {
  await using value = await fixture();
  await value.write("/file");
  const root = await value.client.asyncCall("preopen", ["/"]);
  const handle = (await value.client.asyncCall("resolve", [root, "file"])).node;
  value.client.retain(handle);
  await value.client.asyncCall("setMode", [handle, 0]);
  expect(await value.search().search(query).next()).toMatchObject({
    kind: "read-failed",
    failure: { kind: "denied" },
  });
});

test("file queries retain their UTF-16 bound when validating their own non-ASCII stamp", async () => {
  await using value = await fixture();
  const search = value.search(),
    names: SearchQuery = { kind: "files", prefix: "/", text: "é".repeat(4096) };
  const cursor = search.search(names);
  const { stamp } = await caughtUp(cursor);
  await cursor.close();
  expect((await search.validateIndex(stamp, names)).kind).toBe("valid");
});

test("validator reports snapshot cleanup failure as a tag and keeps the failed admission", async () => {
  await using value = await fixture();
  const search = value.search(),
    cursor = search.search(query);
  const { stamp } = await caughtUp(cursor);
  await cursor.close();
  value.boundary.snapshotCloseReply = async () => {
    throw new Error("snapshot close failed");
  };
  expect(await search.validateIndex(stamp, query)).toEqual({
    kind: "cleanup-failed",
    message: "snapshot close failed",
  });
  expect(await search.search(query).next()).toEqual({ kind: "pressure", resource: "query" });
  await expect(search.close()).rejects.toThrow("snapshot close failed");
});

test("unknown checkpoint getters are invalid input rather than rejected promises", async () => {
  await using value = await fixture();
  const saved = {
    get workspace() {
      throw new Error("foreign getter");
    },
    generation: 0n,
    watermark: {},
    format: "other",
    schema: 1,
    filesystem: {},
    query,
  };
  expect(await value.search().validateIndex(saved, query)).toEqual({
    kind: "invalid",
    field: "index",
  });
  expect(value.boundary.snapshots).toBe(0);
});

test("an output budget below page overhead cannot certify a matchless scan", async () => {
  await using value = await fixture();
  await value.write("/file", "no matches");
  const page = await value.search({ outputBytes: 255 }).search(query).next();
  expect(page).toEqual({ kind: "pressure", resource: "results" });
  expect(value.boundary.pins).toBe(0);
});

test("memoized owners reuse their bounds and reject attempts to silently reconfigure them", async () => {
  await using value = await fixture();
  const search = value.search({ chunkBytes: 2 });
  const owner = { workspace: value.boundary, vfs: getVfsDescriptor("memory") };
  expect(createWorkspaceSearch(owner)).toBe(search);
  expect(createWorkspaceSearch(owner, { chunkBytes: 2 })).toBe(search);
  expect(() => createWorkspaceSearch(owner, { chunkBytes: 1 })).toThrow("different search limits");
  expect(() => createWorkspaceSearch(owner, { chunkBytes: 65537 })).toThrow("Invalid search limit");
});

test("signal registration reserves admission before a reentrant query", async () => {
  await using value = await fixture();
  await value.write("/file");
  const search = value.search();
  const controller = new AbortController();
  const add = controller.signal.addEventListener.bind(controller.signal);
  let nested: SearchCursor | undefined;
  controller.signal.addEventListener = (...args) => {
    add(...args);
    nested = search.search(query);
  };
  const outer = search.search(query, controller.signal);
  try {
    await search.close();
    expect(await nested?.next()).toEqual({ kind: "pressure", resource: "query" });
    expect(await outer.next()).toEqual({ kind: "stopped" });
    expect(value.boundary.snapshots).toBe(0);
  } finally {
    await outer.close();
    await nested?.close();
  }
});

test("query getters cannot reenter admission or reopen a closed owner", async () => {
  await using value = await fixture();
  const search = value.search();
  let nested: SearchCursor | undefined;
  let closing: Promise<void> | undefined;
  const input: SearchQuery = {
    kind: "text",
    prefix: "/",
    get text() {
      nested = search.search(query);
      closing = search.close();
      return "TODO";
    },
  };
  const cursor = search.search(input);
  try {
    await closing;
    expect(await nested?.next()).toEqual({ kind: "pressure", resource: "query" });
    expect(await cursor.next()).toEqual({ kind: "stopped" });
    expect(value.boundary.snapshots).toBe(0);
  } finally {
    await cursor.close();
    await nested?.close();
  }
});

async function rejectsWith(promise: Promise<unknown>, failure: unknown) {
  let rejected = false;
  try {
    await promise;
  } catch (reason) {
    rejected = true;
    expect(reason).toBe(failure);
  }
  expect(rejected).toBe(true);
}

for (const failure of [undefined, null, false, 0, ""]) {
  test(`failed signal registration preserves ${String(failure)} and unwinds its listener`, async () => {
    await using value = await fixture();
    const search = value.search();
    const controller = new AbortController();
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    let removals = 0;
    controller.signal.addEventListener = (...args) => {
      add(...args);
      throw failure;
    };
    controller.signal.removeEventListener = (...args) => {
      removals++;
      remove(...args);
    };
    const cursor = search.search(query, controller.signal);
    expect(await cursor.next()).toEqual({ kind: "cleanup-failed", message: String(failure) });
    await rejectsWith(cursor.close(), failure);
    await rejectsWith(search.close(), failure);
    expect(removals).toBe(1);
    expect(value.boundary.snapshots).toBe(0);
  });

  test(`registration failure ${String(failure)} survives reentrant owner close`, async () => {
    await using value = await fixture();
    const search = value.search();
    const controller = new AbortController();
    const add = controller.signal.addEventListener.bind(controller.signal);
    let closing: Promise<void> | undefined;
    controller.signal.addEventListener = (...args) => {
      add(...args);
      closing = search.close();
      throw failure;
    };
    const cursor = search.search(query, controller.signal);
    expect(await cursor.next()).toEqual({ kind: "cleanup-failed", message: String(failure) });
    expect(cursor.close()).toBe(closing);
    await rejectsWith(cursor.close(), failure);
    expect(value.boundary.snapshots).toBe(0);
  });

  test(`failed signal removal preserves ${String(failure)} after joining a held real reader`, async () => {
    await using value = await fixture();
    await value.write("/file");
    const entered = gate();
    const release = gate();
    value.boundary.readReply = async () => {
      entered.release();
      await release.wait;
    };
    const search = value.search();
    const controller = new AbortController();
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    let reentrant: Promise<void> | undefined;
    controller.signal.removeEventListener = (...args) => {
      remove(...args);
      reentrant = cursor.close();
      throw failure;
    };
    const cursor = search.search(query, controller.signal);
    const pending = cursor.next();
    let closing: Promise<void> | undefined;
    try {
      await entered.wait;
      closing = cursor.close();
      let delivered = false;
      const repeated = cursor.next().then((page) => {
        delivered = true;
        return page;
      });
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(delivered).toBe(false);
      expect(reentrant).toBe(closing);
      expect(value.service.resources().readerLeases).toBe(1);
      expect(value.boundary.closes).toBe(0);
      expect(await search.search(query).next()).toEqual({ kind: "pressure", resource: "query" });
      release.release();
      const terminal = { kind: "cleanup-failed", message: String(failure) };
      expect(await repeated).toEqual(terminal);
      expect(await pending).toEqual(terminal);
      await rejectsWith(closing, failure);
      expect(cursor.close()).toBe(closing);
      expect(value.service.resources().readerLeases).toBe(0);
      expect(value.boundary.closes).toBe(1);
      expect(await search.search(query).next()).toEqual({ kind: "pressure", resource: "query" });
      await rejectsWith(search.close(), failure);
    } finally {
      controller.signal.removeEventListener = remove;
      release.release();
      await pending;
      await closing?.catch(() => {});
      await reentrant?.catch(() => {});
      await cursor.close().catch(() => {});
    }
  });
}

test("only charged query fields survive admission and checkpoint creation", async () => {
  await using value = await fixture();
  await value.write("/file");
  const extra = new Uint8Array(32 * 1024 * 1024);
  const input: SearchQuery & { unrelated?: Uint8Array } = { ...query, unrelated: extra };
  const cursor = value.search({ totalBytes: 2048 }).search(input);
  delete input.unrelated;
  const { stamp } = await caughtUp(cursor);
  expect(Object.keys(stamp.query).sort()).toEqual(["kind", "prefix", "text"]);
  expect(Reflect.get(stamp.query, "unrelated")).toBeUndefined();
  await cursor.close();
});

test("limit normalization never reads unrelated caller fields", async () => {
  await using value = await fixture();
  const limits: Partial<SearchLimits> & { unrelated?: Uint8Array } = {
    totalBytes: 2048,
    get unrelated() {
      throw new Error("unrelated limit getter must not be read");
    },
  };
  const cursor = value.search(limits).search(query);
  expect((await caughtUp(cursor)).stamp.query).toEqual(query);
  await cursor.close();
});

test("already aborted admission does not read caller query getters", async () => {
  await using value = await fixture();
  const controller = new AbortController();
  controller.abort();
  const input: SearchQuery = {
    kind: "text",
    prefix: "/",
    get text() {
      throw new Error("cancelled admission must not compile");
    },
  };
  const cursor = value.search().search(input, controller.signal);
  expect(await cursor.next()).toEqual({ kind: "cancelled" });
  await cursor.close();
  expect(value.boundary.snapshots).toBe(0);
});
