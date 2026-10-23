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
} from "../fs";
import { MemFS } from "../fs/memory";
import { nextReservation } from "../fs/file-identity";
import { publicationObserver, type PublicationLimits } from "../fs/publication-internal";
import type { PersistedIndex } from "../fs/storage";
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
      await backend.close?.();
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
    expect(batch.seq).toBe(initial.cut.watermark.seq + 1n);
    expect(batch.generation).toBe(initial.cut.generation + 1n);
    expect(batch.actor.length).toBeGreaterThan(0);
    expect(batch.transaction.sequence).toBeGreaterThan(0);
    expect(batch.changes).toContainEqual(expect.objectContaining({ kind: "write", paths: ["/src/c"], range: { offset: 0, length: 3 }, size: 3 }));
    expect((await current.workspace.changes(page.next)).kind).toBe("changes");
  } finally { await current.stop(); }
});

test("direct writes and metadata invalidate partial scans without holding the writer lock", async () => {
  const current = await fixture();
  try {
    for (let index = 0; index < WORKSPACE_LIMITS.pageEntries + 5; index++) await write(current, `/f${index}`);
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
    expect(complete.entries.find((entry) => entry.path === "/f0")?.version).toBe(current.backend.identity(handle).version);
    expect(current.service.resources().workspaceCursors).toBe(0);
  } finally { await current.stop(); }
});

test("actual WASI writer appears after snapshot and invalidates an unfinished attempt", async () => {
  const current = await fixture();
  const wasi = new Wasi({ fs: current.client, args: [], env: {}, preopens: {}, stdout() {}, stderr() {} });
  try {
    await write(current, "/file", "abc");
    const handle = await current.handle("/file");
    const resource = { kind: "file", handle, offset: 0, append: false } as const;
    shareFileResource(resource, current.client.connection);
    const module = guestModule("fd_write", [0x7f, 0x7f, 0x7f, 0x7f]);
    const instance = new WebAssembly.Instance(module, wasi.imports(module));
    wasi.start(instance);
    const fd = wasi.descriptors.open(resource, 1n << 6n, 0n);
    const initial = await snapshot(current.workspace);
    const memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("fixture memory missing");
    const view = new DataView(memory.buffer);
    view.setUint32(0, 32, true);
    view.setUint32(4, 1, true);
    new Uint8Array(memory.buffer)[32] = 88;
    expect(guestFunction(instance, "run")(fd, 0, 1, 16)).toBe(0);
    const page = await changed(current.workspace, initial.cut);
    expect(page.batches.flatMap((batch) => batch.changes)).toContainEqual(expect.objectContaining({ kind: "write", paths: ["/file"] }));
  } finally { wasi.descriptors.dispose(); await current.stop(); }
});

test("historical paths survive directory move, hardlinks, replacement, unlink and later writes", async () => {
  const current = await fixture();
  try {
    await write(current, "/dir/source", "one");
    await write(current, "/dest", "old");
    const source = await current.handle("/dir/source"), dest = await current.handle("/dest");
    const root = await current.client.asyncCall("preopen", ["/"]);
    const from = await current.client.asyncCall("resolve", [root, "dir/source"]);
    const to = await current.client.asyncCall("resolve", [root, "link"]);
    const initial = await snapshot(current.workspace);
    expect(await current.client.asyncCall("link", [from, to])).toBe(0);
    await current.client.asyncCall("move", ["/dir", "/moved"]);
    await current.client.asyncCall("move", ["/moved/source", "/dest"]);
    expect(current.client.tryWrite(dest, [bytes("Z")], 0)).toBe(1);
    await current.client.asyncCall("remove", ["/link"]);
    await write(current, "/dest", "later");
    const page = await changed(current.workspace, initial.cut);
    expect(page.batches).toHaveLength(6);
    const replacement = page.batches[2]!;
    expect(replacement.changes).toContainEqual(expect.objectContaining({ kind: "entry", beforePath: "/moved/source", afterPath: null }));
    expect(replacement.changes).toContainEqual(expect.objectContaining({ kind: "entry", beforePath: "/dest", afterPath: "/dest", before: expect.objectContaining({ id: current.backend.identity(dest).id }), after: expect.objectContaining({ id: current.backend.identity(source).id }) }));
    expect(page.batches[3]!.changes).toContainEqual(expect.objectContaining({ kind: "write", id: current.backend.identity(dest).id, paths: [] }));
    const earlierVersion = page.batches[0]!.changes.find((change) => change.kind === "entry")!;
    expect(earlierVersion).not.toEqual(replacement.changes.find((change) => change.kind === "entry"));
    const final = await snapshot(current.workspace);
    expect(final.entries.find((entry) => entry.path === "/dest")?.id).toBe(current.backend.identity(source).id);
  } finally { await current.stop(); }
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
  } finally { await current.stop(); }
});

test("tiny real ring reports oldestAvailable and requires resnapshot, including foreign/future positions", async () => {
  const limits: PublicationLimits = { sessions: 8, operations: 16, inputBytes: 1024, argumentBytes: 1024, effectBytes: 8192, effects: 64, resultBytes: 256, logRecords: 2, logBytes: 16384, pins: 1, pinBytes: 64 };
  const current = await fixture(new MemoryBackend(), limits);
  try {
    const initial = await snapshot(current.workspace);
    for (let index = 0; index < 4; index++) await write(current, `/f${index}`);
    const gap = await current.workspace.changes(initial.cut.watermark);
    expect(gap.kind).toBe("gap");
    if (gap.kind !== "gap") throw new Error("expected real gap");
    expect(gap.resync).toBe("snapshot");
    expect(gap.oldestAvailable.seq).toBe(gap.current.watermark.seq - 1n);
    expect((await current.workspace.changes(gap.current.watermark)).kind).toBe("gap");
    const rebuilt = await snapshot(current.workspace);
    expect((await changed(current.workspace, rebuilt.cut)).batches).toHaveLength(0);
    expect((await current.workspace.changes({ ...rebuilt.cut.watermark, history: crypto.randomUUID() })).kind).toBe("gap");
    expect((await current.workspace.changes({ ...rebuilt.cut.watermark, seq: rebuilt.cut.watermark.seq + 1n })).kind).toBe("gap");
  } finally { await current.stop(); }
});

test("held snapshots, cancellation before and between pulls, and owner close release remote slots", async () => {
  const current = await fixture();
  try {
    const aborted = new AbortController();
    aborted.abort();
    expect((await current.workspace.snapshot(undefined, aborted.signal).next()).kind).toBe("cancelled");
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
  } finally { await current.stop(); }
});

test("root observer access is not inherited by a real guest fork", async () => {
  const current = await fixture();
  const guest = new FilesystemClient(current.client.fork());
  try {
    expect(guest.connection.publication?.observer).toBeUndefined();
    expect(() => createWorkspaceVfs(guest)).toThrow();
    await expect(guest.asyncCall("publicationNamespaceNext", [current.client.connection.publication!.observer, 1])).rejects.toMatchObject({ errno: 2 });
  } finally { guest.dispose(); await current.stop(); }
});

test("cold persistent scan reads zero payload and creates no per-node shared handles", async () => {
  let reads = 0;
  const count = 4200;
  const root: PersistedIndex = { version: 1, generation: 1, root: 100, nodes: [{ ino: 100, kind: "dir", mode: 0o700, size: 0, mtime: 1, children: Array.from({ length: count }, (_, index) => [`f${index}`, index + 101]) }].concat(Array.from({ length: count }, (_, index) => ({ ino: index + 101, kind: "file" as const, mode: 0o600, size: index + 1, mtime: 1, data: `payload-${index}` }))) };
  const backend = await PersistentBackend.open({ async reserveIdentity() { return nextReservation(undefined); }, async load() { return root; }, async read() { reads++; throw new Error("metadata scan hydrated payload"); }, async persist() {}, async flush() {}, async close() {} }, { intervalMs: 0 });
  const current = await fixture(backend);
  try {
    const before = backend.shared.registeredHandles().length;
    const complete = await snapshot(current.workspace, "/", false);
    expect(complete.entries).toHaveLength(count);
    expect(reads).toBe(0);
    expect(backend.shared.registeredHandles().length).toBe(before);
    expect(current.service.resources().workspaceCursors).toBe(0);
  } finally { await current.stop(); }
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
  } finally { await current.stop(); }
});

test("stopped history is terminal rather than empty success", async () => {
  const current = await fixture();
  try {
    const initial = await snapshot(current.workspace);
    current.backend.shared.publication!.stop();
    expect((await current.workspace.changes(initial.cut.watermark)).kind).toBe("stopped");
    expect((await current.workspace.snapshot().next()).kind).toBe("stopped");
  } finally { await current.stop(); }
});
