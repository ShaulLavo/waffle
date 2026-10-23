import { expect, test } from "bun:test";
import {
  createFilesystemConnection,
  createWorkspaceVfs,
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  PersistentBackend,
  WORKSPACE_LIMITS,
  type NamespaceEntry,
  type NamespaceCut,
  type WorkspaceVfs,
  type ChangeBatch,
  type Watermark,
  type WorkspaceChange,
} from "../fs";
import { MemFS } from "../fs/memory";
import { nextReservation } from "../fs/file-identity";
import { type PublicationLimits } from "../fs/publication-internal";
import type { PersistedIndex, PersistedNode } from "../fs/storage";
import { Wasi } from "../core/wasi";
import { shareFileResource } from "../core/open-file";
import { guestFunction, guestModule } from "./fixtures/publication-wasm";

const bytes = (value: string) => new TextEncoder().encode(value);
async function fixture(backend = new MemoryBackend(), limits?: PublicationLimits) {
  const pair = limits
    ? createFilesystemConnection(undefined, { limits, observe: true })
    : createFilesystemConnection(undefined, { workspace: true });
  const service = new FilesystemService(backend);
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  const workspace = createWorkspaceVfs(client);
  return {
    backend,
    serverPort: pair.server.port,
    service,
    client,
    workspace,
    async handle(path: string) {
      const root = await client.asyncCall("preopen", ["/"]);
      const result = await client.asyncCall("resolve", [root, path.slice(1)]);
      client.retain(result.node);
      return result.node as number;
    },
    async stop() {
      await workspace.close();
      client.dispose();
      service.dispose();
      if (backend instanceof PersistentBackend) await backend.close();
    },
  };
}
async function snapshot(workspace: WorkspaceVfs, prefix = "/", includeDirs = true) {
  const cursor = workspace.snapshot({ prefix, includeDirs });
  const entries: NamespaceEntry[] = [];
  try {
    for (;;) {
      const page = await cursor.next();
      if (page.kind === "complete") return { entries, cut: page.cut };
      if (page.kind !== "entries") throw new Error(`snapshot returned ${page.kind}`);
      expect(page.entries.length).toBeLessThanOrEqual(WORKSPACE_LIMITS.pageEntries);
      entries.push(...page.entries);
    }
  } finally {
    await cursor.close();
  }
}
async function changed(workspace: WorkspaceVfs, cut: NamespaceCut) {
  const page = await workspace.changes(cut.watermark);
  if (page.kind !== "changes") throw new Error(`changes returned ${page.kind}`);
  return page;
}
async function write(current: Awaited<ReturnType<typeof fixture>>, path: string, value = path) {
  await current.client.asyncCall("writeFile", [path], bytes(value));
}

test("public root activation, streaming prefix and no-notification snapshot handoff", async () => {
  const current = await fixture();
  try {
    await write(current, "/src/a");
    await write(current, "/src2/b");
    const initial = await snapshot(current.workspace, "/src", false);
    expect(initial.entries.map((entry) => entry.path)).toEqual(["/src/a"]);
    expect(typeof initial.entries[0]!.id).toBe("bigint");
    expect(typeof initial.entries[0]!.version).toBe("bigint");
    expect(typeof initial.cut.generation).toBe("bigint");
    expect(typeof initial.cut.watermark.seq).toBe("bigint");
    await write(current, "/src/c", "new");
    const page = await changed(current.workspace, initial.cut);
    expect(page.batches).toHaveLength(1);
    const batch = page.batches[0]!;
    expect(batch.seq - initial.cut.watermark.seq).toBe(1n);
    expect(batch.generation - initial.cut.generation).toBe(1n);
    expect(batch.actor.length).toBeGreaterThan(0);
    expect(batch.transaction.sequence).toBeGreaterThan(0);
    expect(batch.changes).toContainEqual(
      expect.objectContaining({
        kind: "write",
        paths: ["/src/c"],
        range: { offset: 0, length: 3 },
        size: 3,
      }),
    );
    expect((await current.workspace.changes(page.next)).kind).toBe("changes");
  } finally {
    await current.stop();
  }
});

test("direct writes and metadata invalidate partial scans without holding the writer lock", async () => {
  const current = await fixture();
  try {
    for (let index = 0; index < WORKSPACE_LIMITS.pageEntries + 5; index++)
      await write(current, `/f${index}`);
    const handle = await current.handle("/f0");
    const first = current.workspace.snapshot();
    expect((await first.next()).kind).toBe("entries");
    expect(current.client.tryWrite(handle, [bytes("D")], 0)).toBe(1);
    expect((await first.next()).kind).toBe("restart");
    const second = current.workspace.snapshot();
    expect((await second.next()).kind).toBe("entries");
    await current.client.asyncCall("setMtime", [handle, 123]);
    expect((await second.next()).kind).toBe("restart");
    const complete = await snapshot(current.workspace);
    expect(complete.entries.find((entry) => entry.path === "/f0")?.mtime).toBe(123);
    expect(complete.entries.find((entry) => entry.path === "/f0")?.version).toBe(
      current.backend.identity(handle).version,
    );
    expect(current.service.resources().workspaceCursors).toBe(0);
  } finally {
    await current.stop();
  }
});

test("actual WASI writer appears after snapshot and invalidates an unfinished attempt", async () => {
  const current = await fixture();
  const guest = new FilesystemClient(current.client.fork());
  const memory = new WebAssembly.Memory({ initial: 4 });
  const wasi = new Wasi({
    fs: guest,
    args: [],
    env: {},
    preopens: {},
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {
      throw new Error("WASI must not wait");
    },
  });
  try {
    await write(current, "/file", "abc");
    const root = await guest.asyncCall("preopen", ["/"]);
    const handle = (await guest.asyncCall("resolve", [root, "file"])).node;
    guest.retain(handle);
    const resource = { kind: "file", handle, offset: 0, append: false } as const;
    shareFileResource(resource, guest.connection);
    const module = guestModule("wasi_snapshot_preview1", [
      { name: "fd_write", parameters: ["i32", "i32", "i32", "i32"] },
    ]);
    const instance = new WebAssembly.Instance(module, { ...wasi.imports(module), env: { memory } });
    wasi.start(instance);
    const fd = wasi.descriptors.open(resource, 1n << 6n, 0n);
    const initial = await snapshot(current.workspace);
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("fixture memory missing");
    const view = new DataView(memory.buffer);
    view.setUint32(0, 32, true);
    view.setUint32(4, 1, true);
    new Uint8Array(memory.buffer)[32] = 88;
    expect(guestFunction(instance, "fd_write")(fd, 0, 1, 16)).toBe(0);
    const page = await changed(current.workspace, initial.cut);
    expect(page.batches.flatMap((batch) => batch.changes)).toContainEqual(
      expect.objectContaining({ kind: "write", paths: ["/file"] }),
    );
  } finally {
    wasi.descriptors.dispose();
    guest.dispose();
    await current.stop();
  }
});

test("historical paths survive directory move, hardlinks, replacement, unlink and later writes", async () => {
  const current = await fixture();
  try {
    await write(current, "/dir/source", "one");
    await write(current, "/dest", "old");
    const source = await current.handle("/dir/source"),
      dest = await current.handle("/dest");
    const root = await current.client.asyncCall("preopen", ["/"]);
    const from = await current.client.asyncCall("resolve", [root, "dir/source"]);
    const to = await current.client.asyncCall("resolve", [root, "link"]);
    const initial = await snapshot(current.workspace);
    expect(await current.client.asyncCall("link", [from, to])).toBe(0);
    const linkedVersion = current.backend.identity(source).version;
    await current.client.asyncCall("move", ["/dir", "/moved"]);
    await current.client.asyncCall("move", ["/moved/source", "/dest"]);
    expect(current.client.tryWrite(dest, [bytes("Z")], 0)).toBe(1);
    await current.client.asyncCall("remove", ["/link"]);
    await write(current, "/dest", "later");
    const page = await changed(current.workspace, initial.cut);
    expect(page.batches).toHaveLength(6);
    const replacement = page.batches[2]!;
    expect(replacement.changes).toContainEqual(
      expect.objectContaining({ kind: "entry", beforePath: "/moved/source", afterPath: null }),
    );
    expect(replacement.changes).toContainEqual(
      expect.objectContaining({
        kind: "entry",
        beforePath: "/dest",
        afterPath: "/dest",
        before: expect.objectContaining({ id: current.backend.identity(dest).id }),
        after: expect.objectContaining({ id: current.backend.identity(source).id }),
      }),
    );
    expect(page.batches[3]!.changes).toContainEqual(
      expect.objectContaining({ kind: "write", id: current.backend.identity(dest).id, paths: [] }),
    );
    expect(page.batches[0]!.changes).toContainEqual(
      expect.objectContaining({
        kind: "entry",
        after: { id: current.backend.identity(source).id, version: linkedVersion },
        afterPath: "/link",
      }),
    );
    expect(linkedVersion).not.toBe(current.backend.identity(source).version);
    const final = await snapshot(current.workspace);
    expect(final.entries.find((entry) => entry.path === "/dest")?.id).toBe(
      current.backend.identity(source).id,
    );
  } finally {
    await current.stop();
  }
});

test("no-effect mutations preserve generation and do not restart enumeration", async () => {
  const current = await fixture();
  try {
    await write(current, "/file", "abc");
    const handle = await current.handle("/file");
    const initial = await snapshot(current.workspace);
    const cursor = current.workspace.snapshot();
    expect((await cursor.next()).kind).toBe("entries");
    expect(current.client.tryWrite(handle, [new Uint8Array()], 0)).toBe(0);
    expect(await current.client.asyncCall("setMode", [handle, 0o600])).toBe(0);
    const complete = await cursor.next();
    expect(complete.kind).toBe("complete");
    if (complete.kind !== "complete") throw new Error("no completion");
    expect(complete.cut).toEqual(initial.cut);
    expect((await changed(current.workspace, initial.cut)).batches).toHaveLength(0);
  } finally {
    await current.stop();
  }
});

test("tiny real ring reports oldestAvailable and requires resnapshot, including foreign/future positions", async () => {
  const limits: PublicationLimits = {
    sessions: 8,
    operations: 16,
    inputBytes: 1024,
    argumentBytes: 1024,
    effectBytes: 8192,
    effects: 64,
    resultBytes: 256,
    logRecords: 2,
    logBytes: 16384,
    pins: 1,
    pinBytes: 64,
  };
  const current = await fixture(new MemoryBackend(), limits);
  try {
    const initial = await snapshot(current.workspace);
    for (let index = 0; index < 4; index++) await write(current, `/f${index}`);
    const gap = await current.workspace.changes(initial.cut.watermark);
    expect(gap.kind).toBe("gap");
    if (gap.kind !== "gap") throw new Error("expected real gap");
    expect(gap.resync).toBe("snapshot");
    expect(gap.current.watermark.seq - gap.oldestAvailable.seq).toBe(1n);
    expect((await current.workspace.changes(gap.current.watermark)).kind).toBe("gap");
    const rebuilt = await snapshot(current.workspace);
    expect((await changed(current.workspace, rebuilt.cut)).batches).toHaveLength(0);
    expect(
      (await current.workspace.changes({ ...rebuilt.cut.watermark, history: crypto.randomUUID() }))
        .kind,
    ).toBe("gap");
    expect(
      (
        await current.workspace.changes({
          ...rebuilt.cut.watermark,
          seq: (rebuilt.cut.watermark.seq + 1n) as typeof rebuilt.cut.watermark.seq,
        })
      ).kind,
    ).toBe("gap");
  } finally {
    await current.stop();
  }
});

test("held snapshots, cancellation before and between pulls, and owner close release remote slots", async () => {
  const current = await fixture();
  try {
    const aborted = new AbortController();
    aborted.abort();
    expect((await current.workspace.snapshot(undefined, aborted.signal).next()).kind).toBe(
      "cancelled",
    );
    const controller = new AbortController();
    const first = current.workspace.snapshot(undefined, controller.signal);
    const second = current.workspace.snapshot();
    expect((await first.next()).kind).toBe("entries");
    expect((await second.next()).kind).toBe("entries");
    expect((await current.workspace.snapshot().next()).kind).toBe("pressure");
    expect(current.service.resources().workspaceCursors).toBe(2);
    controller.abort();
    expect((await first.next()).kind).toBe("cancelled");
    await first.close();
    await write(current, "/still-writable");
    await second.close();
    expect(current.service.resources().workspaceCursors).toBe(0);
    const late = current.workspace.snapshot();
    const pending = late.next();
    await current.workspace.close();
    expect((await pending).kind).toBe("stopped");
    expect((await late.next()).kind).toBe("stopped");
    expect(current.service.resources().workspaceCursors).toBe(0);
  } finally {
    await current.stop();
  }
});

test("root observer access is not inherited by a real guest fork", async () => {
  const current = await fixture();
  const guest = new FilesystemClient(current.client.fork());
  try {
    expect(guest.connection.publication?.observer).toBeUndefined();
    expect(() => createWorkspaceVfs(guest)).toThrow();
    await expect(
      guest.asyncCall("publicationNamespaceNext", [
        current.client.connection.publication!.observer,
        1,
      ]),
    ).rejects.toMatchObject({ errno: 2 });
  } finally {
    guest.dispose();
    await current.stop();
  }
});

test("cold persistent scan reads zero payload and creates no per-node shared handles", async () => {
  let reads = 0;
  const count = 4200;
  const directories: PersistedNode[] = [
    {
      ino: 100,
      kind: "dir",
      mode: 0o700,
      size: 0,
      mtime: 1,
      children: Array.from({ length: count }, (_, index): [string, number] => [
        `f${index}`,
        index + 101,
      ]),
    },
  ];
  const root: PersistedIndex = {
    version: 1,
    generation: 1,
    root: 100,
    nodes: directories.concat(
      Array.from({ length: count }, (_, index) => ({
        ino: index + 101,
        kind: "file" as const,
        mode: 0o600,
        size: index + 1,
        mtime: 1,
        data: `payload-${index}`,
      })),
    ),
  };
  const backend = await PersistentBackend.open(
    {
      async reserveIdentity() {
        return nextReservation(undefined);
      },
      async load() {
        return root;
      },
      async read() {
        reads++;
        throw new Error("metadata scan hydrated payload");
      },
      async persist() {},
      async flush() {},
      async close() {},
    },
    { intervalMs: 0 },
  );
  const current = await fixture(backend);
  try {
    const before = backend.shared.registeredHandles().length;
    const complete = await snapshot(current.workspace, "/", false);
    expect(complete.entries).toHaveLength(count);
    expect(reads).toBe(0);
    expect(backend.shared.registeredHandles().length).toBe(before);
    expect(current.service.resources().workspaceCursors).toBe(0);
  } finally {
    await current.stop();
  }
});

test("path and depth pressure terminate without truncated completion", async () => {
  const fs = new MemFS();
  fs.writeFile(`/${"a".repeat(WORKSPACE_LIMITS.pathUnits + 1)}`, bytes("x"));
  const current = await fixture(new MemoryBackend(fs));
  try {
    const cursor = current.workspace.snapshot();
    expect((await cursor.next()).kind).toBe("pressure");
    expect((await cursor.next()).kind).toBe("pressure");
    expect(current.service.resources().workspaceCursors).toBe(0);
  } finally {
    await current.stop();
  }
});

test("stopped history is terminal rather than empty success", async () => {
  const current = await fixture();
  try {
    const initial = await snapshot(current.workspace);
    current.backend.shared.publication!.stop();
    expect((await current.workspace.changes(initial.cut.watermark)).kind).toBe("stopped");
    expect((await current.workspace.snapshot().next()).kind).toBe("stopped");
  } finally {
    await current.stop();
  }
});

test("two cursors may start in either creation order", async () => {
  const current = await fixture();
  try {
    const first = current.workspace.snapshot(),
      second = current.workspace.snapshot();
    expect((await second.next()).kind).toBe("entries");
    expect((await first.next()).kind).toBe("entries");
    await first.close();
    await second.close();
    expect(current.service.resources().workspaceCursors).toBe(0);
  } finally {
    await current.stop();
  }
});

function holdResponse(port: MessagePort) {
  const post = port.postMessage.bind(port);
  const held = Promise.withResolvers<void>();
  let response: unknown;
  port.postMessage = (value: unknown) => {
    port.postMessage = post;
    response = value;
    held.resolve();
  };
  return {
    held: held.promise,
    release() {
      port.postMessage = post;
      post(response);
    },
  };
}

test("cancellation wakes an in-flight response and late delivery cannot resurrect a cursor", async () => {
  const current = await fixture();
  const held = holdResponse(current.serverPort);
  try {
    const abort = new AbortController();
    const cursor = current.workspace.snapshot(undefined, abort.signal);
    const pending = cursor.next();
    await held.held;
    expect(current.service.resources().workspaceCursors).toBe(1);
    abort.abort();
    expect(await Promise.race([pending, Bun.sleep(30).then(() => ({ kind: "timeout" }))])).toEqual({
      kind: "cancelled",
    });
    await cursor.close();
    expect(current.service.resources().workspaceCursors).toBe(0);
    held.release();
    expect((await cursor.next()).kind).toBe("cancelled");
    expect((await snapshot(current.workspace)).entries).toHaveLength(1);
  } finally {
    held.release();
    await current.stop();
  }
});

test("index and depth limits return typed pressure and free held scan slots", async () => {
  const fs = new MemFS();
  for (let index = 0; index < 8000; index++) fs.writeFile(`/f${index}`, bytes("x"));
  fs.mkdirp(`/${Array.from({ length: WORKSPACE_LIMITS.depth + 1 }, () => "d").join("/")}`);
  const current = await fixture(new MemoryBackend(fs));
  try {
    const cursor = current.workspace.snapshot();
    let result = await cursor.next();
    while (result.kind === "entries") result = await cursor.next();
    expect(result).toEqual({ kind: "pressure", resource: "index" });
    expect(current.service.resources().workspaceCursors).toBe(0);
    const deep = new MemFS();
    deep.mkdirp(`/${Array.from({ length: WORKSPACE_LIMITS.depth + 1 }, () => "d").join("/")}`);
    const other = await fixture(new MemoryBackend(deep));
    try {
      const scan = other.workspace.snapshot();
      expect((await scan.next()).kind).toBe("entries");
      expect(await scan.next()).toEqual({ kind: "pressure", resource: "depth" });
      expect(other.service.resources().workspaceCursors).toBe(0);
    } finally {
      await other.stop();
    }
  } finally {
    await current.stop();
  }
});

test("long hardlink expansion gives bounded change pressure and requires a new snapshot", async () => {
  const fs = new MemFS();
  fs.writeFile("/file", bytes("x"));
  const root = fs.preopen("/");
  const from = fs.resolve(root, "file");
  if (typeof from === "number") throw new Error("missing source");
  for (let index = 0; index < 180; index++) {
    const to = fs.resolve(root, `${index}-${"a".repeat(2000)}`);
    if (typeof to === "number") throw new Error("missing target");
    expect(fs.link(from, to)).toBe(0);
  }
  const current = await fixture(new MemoryBackend(fs));
  try {
    const initial = await snapshot(current.workspace);
    const handle = await current.handle("/file");
    expect(current.client.tryWrite(handle, [bytes("y")], 0)).toBe(1);
    expect(await current.workspace.changes(initial.cut.watermark)).toEqual({
      kind: "pressure",
      resource: "changes",
    });
    expect((await current.workspace.changes(initial.cut.watermark)).kind).toBe("gap");
    const rebuilt = await snapshot(current.workspace);
    expect((await changed(current.workspace, rebuilt.cut)).batches).toHaveLength(0);
    expect(current.service.resources().workspaceCursors).toBe(0);
  } finally {
    await current.stop();
  }
});

test("prefix traversal follows real directory rules and never silently omits denied subtrees", async () => {
  const current = await fixture();
  try {
    await write(current, "/dir/file");
    expect(
      (await snapshot(current.workspace, "/dir/../dir/", false)).entries.map((entry) => entry.path),
    ).toEqual(["/dir/file"]);
    expect((await snapshot(current.workspace, "/missing")).entries).toHaveLength(0);
    const notDirectory = current.workspace.snapshot({ prefix: "/dir/file/../" });
    const failed = await notDirectory.next().catch((error: unknown) => error);
    expect(failed).toMatchObject({ errno: 54 });
    const dir = await current.handle("/dir");
    await current.client.asyncCall("setMode", [dir, 0o000]);
    const denied = current.workspace.snapshot();
    const failure = await denied.next().catch((error: unknown) => error);
    expect(failure).toMatchObject({ errno: 2 });
    expect(current.service.resources().workspaceCursors).toBe(0);
  } finally {
    await current.stop();
  }
});

test("owner disposal cancels a held response and cannot install late completed state", async () => {
  const current = await fixture();
  const cursor = current.workspace.snapshot();
  await cursor.next();
  const held = holdResponse(current.serverPort);
  try {
    const pending = cursor.next();
    await held.held;
    await current.workspace.close();
    expect(await pending).toEqual({ kind: "stopped" });
    held.release();
    expect((await cursor.next()).kind).toBe("stopped");
    expect((await current.workspace.snapshot().next()).kind).toBe("stopped");
    expect(current.service.resources().workspaceCursors).toBe(0);
    expect(current.client.completions.size).toBe(0);
  } finally {
    held.release();
    await current.stop();
  }
});

test("a root saturated with receipts cannot starve a new public guest writer", async () => {
  const current = await fixture();
  let guest: FilesystemClient | undefined;
  try {
    for (let index = 0; index < 80; index++) await write(current, "/file", `${index}`);
    const initial = await snapshot(current.workspace);
    guest = new FilesystemClient(current.client.fork());
    await guest.asyncCall("writeFile", ["/guest"], bytes("first"));
    expect((await changed(current.workspace, initial.cut)).batches).toHaveLength(1);
  } finally {
    guest?.dispose();
    await current.stop();
  }
});

test("bounded change pulls keep complete rename groups ordered across pages", async () => {
  const limits: PublicationLimits = {
    sessions: 4,
    operations: 8,
    inputBytes: 4096,
    argumentBytes: 1024,
    effectBytes: 4096,
    effects: 32,
    resultBytes: 256,
    logRecords: 8,
    logBytes: 32768,
    pins: 1,
    pinBytes: 64,
  };
  const current = await fixture(new MemoryBackend(), limits);
  try {
    await write(current, "/file", "initial");
    const initial = await snapshot(current.workspace);
    for (let index = 0; index < 5; index++)
      await write(current, "/file", String(index).repeat(3000));
    await current.client.asyncCall("move", ["/file", "/renamed"]);
    let after = initial.cut.watermark;
    let batches = 0,
      pulls = 0;
    for (;;) {
      const page = await current.workspace.changes(after);
      if (page.kind !== "changes") throw new Error(`unexpected ${page.kind}`);
      if (!page.batches.length) break;
      expect(page.batches.length).toBeLessThan(6);
      after = assertBatches(page.batches, after);
      batches += page.batches.length;
      expect(page.next).toEqual(after);
      pulls++;
    }
    expect(batches).toBe(6);
    expect(pulls).toBeGreaterThan(1);
    expect(current.client.completions.size).toBe(0);
  } finally {
    await current.stop();
  }
});

test("change cancellation and concurrent pulls release receipts without late index installation", async () => {
  const current = await fixture();
  try {
    const initial = await snapshot(current.workspace);
    const before = new AbortController();
    before.abort();
    expect(await current.workspace.changes(initial.cut.watermark, before.signal)).toEqual({
      kind: "cancelled",
    });
    const held = holdResponse(current.serverPort);
    try {
      const abort = new AbortController();
      const pending = current.workspace.changes(initial.cut.watermark, abort.signal);
      await held.held;
      expect(await current.workspace.changes(initial.cut.watermark)).toEqual({
        kind: "pressure",
        resource: "pull",
      });
      abort.abort();
      expect(await pending).toEqual({ kind: "cancelled" });
      expect(current.client.completions.size).toBe(0);
      held.release();
      expect((await current.workspace.changes(initial.cut.watermark)).kind).toBe("gap");
    } finally {
      held.release();
    }
    const rebuilt = await snapshot(current.workspace);
    const stopped = holdResponse(current.serverPort);
    try {
      const pending = current.workspace.changes(rebuilt.cut.watermark);
      await stopped.held;
      await current.workspace.close();
      expect(await pending).toEqual({ kind: "stopped" });
      stopped.release();
      expect(current.client.completions.size).toBe(0);
    } finally {
      stopped.release();
    }
  } finally {
    await current.stop();
  }
});

test("snapshot preserves finite recovered timestamps without narrowing the storage contract", async () => {
  const fs = new MemFS();
  fs.writeFile("/file", bytes("x"));
  const resolved = fs.resolve(fs.preopen("/"), "file");
  if (typeof resolved === "number" || resolved.node === undefined) throw new Error("missing file");
  expect(fs.setMtime(resolved.node, -1.5)).toBe(0);
  const current = await fixture(new MemoryBackend(fs));
  try {
    const initial = await snapshot(current.workspace);
    expect(initial.entries.find((entry) => entry.path === "/file")?.mtime).toBe(-1.5);
  } finally {
    await current.stop();
  }
});

function assertRename(entries: readonly Extract<WorkspaceChange, { kind: "entry" }>[]): void {
  if (!entries.length) return;
  expect(entries).toHaveLength(2);
  expect(entries[0]!.beforePath).toBe("/file");
  expect(entries[1]!.afterPath).toBe("/renamed");
}

function assertBatches(batches: readonly ChangeBatch[], after: Watermark): Watermark {
  for (const batch of batches) {
    expect(batch.seq).toBe(after.seq + 1n);
    assertRename(batch.changes.filter((change) => change.kind === "entry"));
    after = { history: after.history, seq: batch.seq };
  }
  return after;
}
