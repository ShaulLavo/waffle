import { afterEach, expect, test } from "bun:test";
import { FilesystemClient } from "../fs/client.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemService } from "../fs/service.js";
import {
  createFilesystemConnection,
  pack,
  revokeFilesystem,
  reapFilesystem,
} from "../fs/protocol.js";
import type { WalkPage, WalkCursor } from "../fs/walk.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
class TrackingBackend extends MemoryBackend {
  readonly pins = new Map<number, number>();
  beforeRetain?: (handle: number) => void;
  retain(handle: number): void {
    this.beforeRetain?.(handle);
    super.retain(handle);
    this.pins.set(handle, (this.pins.get(handle) ?? 0) + 1);
  }
  release(handle: number): void {
    super.release(handle);
    const count = this.pins.get(handle)!;
    if (count === 1) this.pins.delete(handle);
    else this.pins.set(handle, count - 1);
  }
}
function fixture() {
  const backend = new TrackingBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  cleanups.push(() => {
    client.dispose();
    service.dispose();
  });
  return { backend, service, client };
}
async function walkPage(
  client: FilesystemClient,
  cursor: unknown,
  options: unknown,
): Promise<WalkPage> {
  const completion = client.submit("walkPage", [cursor, options], undefined, 65536);
  try {
    return await completion.value();
  } finally {
    completion.release();
  }
}
const plan = { include: [], exclude: [], excludeDirectories: [], hidden: false, maxDepth: null };

test("walk pages include file grants and prune directories before visiting", async () => {
  const { client, service } = fixture();
  await client.asyncCall("writeFile", ["/ok.ts"], new Uint8Array([65]));
  await client.asyncCall("mkdirp", ["/vendor"]);
  await client.asyncCall("writeFile", ["/vendor/no.ts"], new Uint8Array([66]));
  const root: number = await client.asyncCall("preopen", ["/"]);
  const cursor = await client.asyncCall("walkOpen", [
    root,
    {
      ...plan,
      excludeDirectories: [{ kind: "basename", glob: "vendor" }],
    },
  ]);
  const page = await walkPage(client, cursor, { grant: true, maxEntries: 128 });
  expect(page.entries).toEqual([
    { kind: "file", path: "ok.ts", size: 1, handle: expect.any(Number), grant: expect.any(Number) },
  ]);
  expect(page.next).toBeNull();
  await client.asyncCall("walkRelease", [tokens(page)]);
  await client.asyncCall("walkClose", [cursor]);
  expect(service.resources().walks).toBe(0);
  expect(service.resources().walkGrants).toBe(0);
});

test("a session admits four walks and rejects the fifth without leaking", async () => {
  const { client } = fixture();
  const root = await client.asyncCall("preopen", ["/"]);
  const cursors = [];
  for (let index = 0; index < 4; index++)
    cursors.push(await client.asyncCall("walkOpen", [root, plan]));
  const failure = await client.asyncCall("walkOpen", [root, plan]).catch((error: unknown) => error);
  expect(failure).toMatchObject({ errno: 6 });
  for (const cursor of cursors) await client.asyncCall("walkClose", [cursor]);
});

test("128 entries per page and 256 grant credits across all walks", async () => {
  const { client, service } = fixture();
  for (let index = 0; index < 300; index++)
    await client.asyncCall("writeFile", [`/f${index}`], new Uint8Array([index % 256]));
  const root = await client.asyncCall("preopen", ["/"]);
  const first = await client.asyncCall("walkOpen", [root, plan]);
  const second = await client.asyncCall("walkOpen", [root, plan]);
  const a = await walkPage(client, first, { grant: true, maxEntries: 128 });
  const b = await walkPage(client, second, { grant: true, maxEntries: 128 });
  expect(a.entries.length).toBe(128);
  expect(b.entries.length).toBe(128);
  expect(grantedFile(a).handle).toBe(grantedFile(b).handle);
  expect(grantedFile(a).grant).not.toBe(grantedFile(b).grant);
  expect(service.resources().walkGrants).toBe(256);
  const error = await walkPage(client, a.next, { grant: true, maxEntries: 1 }).catch(
    (error: unknown) => error,
  );
  expect(error).toMatchObject({ errno: 6 });
  await client.asyncCall("walkRelease", [[grantedFile(a).grant]]);
  expect(service.resources().walkGrants).toBe(255);
  const c = await walkPage(client, a.next, { grant: true, maxEntries: 128 });
  expect(c.entries.length).toBe(1);
  expect(c.entries[0]?.path).toBe("f128");
  expect(service.resources().walkGrants).toBe(256);
  await client.asyncCall("walkClose", [first]);
  expect(service.resources().walkGrants).toBe(128);
  await client.asyncCall("walkClose", [second]);
  expect(service.resources().walkGrants).toBe(0);
  expect(service.resources().walks).toBe(0);
});

test("whole packed reply fits 64 KiB including Unicode paths and cursor", async () => {
  const { client, service } = fixture();
  const prefix = "/" + "💡".repeat(400);
  await client.asyncCall("mkdirp", [prefix]);
  for (let index = 0; index < 100; index++)
    await client.asyncCall("writeFile", [`${prefix}/${"x".repeat(230)}${index}`], new Uint8Array());
  const root = await client.asyncCall("preopen", ["/"]);
  const initial = await client.asyncCall("walkOpen", [root, plan]);
  let cursor: WalkCursor | null = initial;
  let seen = 0,
    pages = 0;
  while (cursor) {
    const page = await walkPage(client, cursor, { grant: true, maxEntries: 128 });
    expect(pack(page).length).toBeLessThanOrEqual(65536);
    expect(page.entries.length).toBeLessThanOrEqual(128);
    expect(page.entries.length).toBeGreaterThan(0);
    seen += page.entries.length;
    pages++;
    await client.asyncCall("walkRelease", [tokens(page)]);
    cursor = page.next;
  }
  expect(pages).toBeGreaterThan(1);
  expect(seen).toBe(100);
  expect(service.resources().walkGrants).toBe(0);
  expect(service.resources().walks).toBe(0);
});

test("invalid page options and insufficient output capacity do not consume the cursor", async () => {
  const { client, service } = fixture();
  await client.asyncCall("writeFile", ["/a"], new Uint8Array());
  const root = await client.asyncCall("preopen", ["/"]);
  const cursor = await client.asyncCall("walkOpen", [root, plan]);
  for (const maxEntries of [0, 129, -1, 1.5, "128"]) {
    const error = await walkPage(client, cursor, { grant: true, maxEntries }).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ errno: 28 });
  }
  const tooSmall = client.submit(
    "walkPage",
    [cursor, { grant: true, maxEntries: 1 }],
    undefined,
    1024,
  );
  const error = await tooSmall.value().catch((error: unknown) => error);
  tooSmall.release();
  expect(error).toMatchObject({ errno: 28 });
  expect(service.resources().walkGrants).toBe(0);
  const page = await walkPage(client, cursor, { grant: true, maxEntries: 1 });
  expect(page.entries[0]?.path).toBe("a");
  await client.asyncCall("walkClose", [cursor]);
});

test("stale, replayed, future and foreign cursors do not advance the owner", async () => {
  const { client, service } = fixture();
  for (const name of ["a", "b", "c"])
    await client.asyncCall("writeFile", [`/${name}`], new Uint8Array());
  const root = await client.asyncCall("preopen", ["/"]);
  const cursor = await client.asyncCall("walkOpen", [root, plan]);
  const first = await walkPage(client, cursor, { grant: false, maxEntries: 1 });
  for (const stale of [
    cursor,
    { id: cursor.id, sequence: 99 },
    { id: cursor.id + 999, sequence: 0 },
  ]) {
    const error = await walkPage(client, stale, { grant: true, maxEntries: 1 }).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ errno: 8 });
  }
  const peer = createFilesystemConnection(client.connection);
  service.connect(peer.server);
  const other = new FilesystemClient(peer.client);
  cleanups.push(() => other.dispose());
  const foreign = await walkPage(other, first.next, { grant: true, maxEntries: 1 }).catch(
    (error: unknown) => error,
  );
  expect(foreign).toMatchObject({ errno: 8 });
  const second = await walkPage(client, first.next, { grant: false, maxEntries: 1 });
  expect(second.entries[0]?.path).toBe("b");
  expect(fileEntry(second).handle).toBeNull();
  await client.asyncCall("walkClose", [cursor]);
  await client.asyncCall("walkClose", [cursor]);
  expect(service.resources().walks).toBe(0);
});

test("snapshot excludes additions and reports removed and replaced entries", async () => {
  const { client } = fixture();
  for (const name of ["a", "b", "c"])
    await client.asyncCall("writeFile", [`/${name}`], new Uint8Array());
  const root = await client.asyncCall("preopen", ["/"]);
  const cursor = await client.asyncCall("walkOpen", [root, plan]);
  const first = await walkPage(client, cursor, { grant: false, maxEntries: 1 });
  await client.asyncCall("remove", ["/b"]);
  await client.asyncCall("remove", ["/c"]);
  await client.asyncCall("writeFile", ["/c"], new Uint8Array([1]));
  await client.asyncCall("writeFile", ["/d"], new Uint8Array([1]));
  const second = await walkPage(client, first.next, { grant: true, maxEntries: 128 });
  expect(second.entries).toEqual([
    { kind: "error", path: "b", errno: 44 },
    { kind: "error", path: "c", errno: 44 },
  ]);
  expect(second.next).toBeNull();
});

test("permission is checked on every directory, file and later ancestor visit", async () => {
  const { client, backend } = fixture();
  await client.asyncCall("mkdirp", ["/blocked"]);
  await client.asyncCall("mkdirp", ["/later"]);
  await client.asyncCall("writeFile", ["/blocked/no"], new Uint8Array());
  await client.asyncCall("writeFile", ["/later/a"], new Uint8Array());
  await client.asyncCall("writeFile", ["/later/b"], new Uint8Array());
  backend.fs.lookup("/blocked")!.mode = 0o400;
  const root = await client.asyncCall("preopen", ["/"]);
  const cursor = await client.asyncCall("walkOpen", [root, plan]);
  const first = await walkPage(client, cursor, { grant: false, maxEntries: 2 });
  expect(first.entries[0]).toEqual({ kind: "error", path: "blocked", errno: 2 });
  expect(first.entries[1]?.path).toBe("later/a");
  backend.fs.lookup("/later")!.mode = 0o100;
  const second = await walkPage(client, first.next, { grant: true, maxEntries: 128 });
  expect(second.entries).toEqual([{ kind: "error", path: "later/b", errno: 2 }]);
});

test("hidden, depth, includes, excludes, symlinks and opaque sockets are explicit", async () => {
  const { client, backend } = fixture();
  await client.asyncCall("mkdirp", ["/src/deep"]);
  for (const name of ["a.ts", "skip.ts", ".hidden.ts", "src/b.ts", "src/deep/c.ts", "a.js"])
    await client.asyncCall("writeFile", [`/${name}`], new Uint8Array());
  const root = await client.asyncCall("preopen", ["/"]);
  const link = backend.fs.resolve(root, "link");
  const socket = backend.fs.resolve(root, "socket");
  if (typeof link === "number" || typeof socket === "number")
    throw new Error("fixture resolution failed");
  backend.fs.symlink(link, "/src");
  backend.fs.create(socket, "socket");
  const cursor = await client.asyncCall("walkOpen", [
    root,
    {
      ...plan,
      include: [{ kind: "path", glob: "**/*.ts" }],
      exclude: [{ kind: "basename", glob: "skip.*" }],
      maxDepth: 2,
    },
  ]);
  const page = await walkPage(client, cursor, { grant: false, maxEntries: 128 });
  expect(page.entries.map((entry: { path: string }) => entry.path)).toEqual(["src/b.ts", "a.ts"]);
  const hiddenCursor = await client.asyncCall("walkOpen", [
    root,
    { ...plan, hidden: true, maxDepth: 1 },
  ]);
  const hidden = await walkPage(client, hiddenCursor, { grant: false, maxEntries: 128 });
  expect(hidden.entries.map((entry: { path: string }) => entry.path)).toEqual([
    "a.ts",
    "skip.ts",
    ".hidden.ts",
    "a.js",
  ]);
});

function tokens(page: WalkPage): number[] {
  return page.entries.flatMap((entry) =>
    entry.kind === "file" && entry.grant !== null ? [entry.grant] : [],
  );
}

test("grant release rejects duplicates, unknown and foreign tokens atomically", async () => {
  const { client, service } = fixture();
  await client.asyncCall("writeFile", ["/a"], new Uint8Array([65]));
  const root = await client.asyncCall("preopen", ["/"]);
  const cursor = await client.asyncCall("walkOpen", [root, plan]);
  const page = await walkPage(client, cursor, { grant: true, maxEntries: 1 });
  const granted = tokens(page);
  for (const invalid of [
    [granted[0], granted[0]],
    [granted[0], -999],
    ["1"],
    Array.from({ length: 257 }, () => 1),
  ]) {
    const error = await client.asyncCall("walkRelease", [invalid]).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(service.resources().walkGrants).toBe(1);
  }
  const peer = createFilesystemConnection(client.connection);
  service.connect(peer.server);
  const other = new FilesystemClient(peer.client);
  cleanups.push(() => other.dispose());
  const foreign = await other.asyncCall("walkRelease", [granted]).catch((error: unknown) => error);
  expect(foreign).toMatchObject({ errno: 8 });
  expect(service.resources().walkGrants).toBe(1);
  await client.asyncCall("walkRelease", [granted]);
  expect(service.resources().walkGrants).toBe(0);
  const stale = await client.asyncCall("walkRelease", [granted]).catch((error: unknown) => error);
  expect(stale).toMatchObject({ errno: 8 });
});

test("a grant's exact reference release preserves an independently opened handle", async () => {
  const { client, service, backend } = fixture();
  await client.asyncCall("writeFile", ["/a"], new Uint8Array([65]));
  const root = await client.asyncCall("preopen", ["/"]);
  const cursor = await client.asyncCall("walkOpen", [root, plan]);
  const page = await walkPage(client, cursor, { grant: true, maxEntries: 1 });
  const file = grantedFile(page);
  client.retain(file.handle);
  await client.asyncCall("remove", ["/a"]);
  await client.asyncCall("walkRelease", [tokens(page)]);
  const bytes = new Uint8Array(1);
  expect(client.read(file.handle, [bytes], 0)).toBe(1);
  expect(bytes[0]).toBe(65);
  expect(backend.pins.get(file.handle)).toBe(1);
  client.release(file.handle);
  await client.asyncCall("stat", [root]);
  expect(service.resources().walkGrants).toBe(0);
  expect(backend.pins.has(file.handle)).toBe(false);
});

test("failed grant admission releases prior staged grants and permits retry of the same cursor", async () => {
  const { client, service, backend } = fixture();
  for (const name of ["a", "b"])
    await client.asyncCall("writeFile", [`/${name}`], new Uint8Array());
  const root = await client.asyncCall("preopen", ["/"]);
  const baseline = Array.from(backend.pins);
  const cursor = await client.asyncCall("walkOpen", [root, plan]);
  let calls = 0;
  backend.beforeRetain = () => {
    if (++calls === 2) throw new Error("injected grant admission failure");
  };
  const error = await walkPage(client, cursor, { grant: true, maxEntries: 128 }).catch(
    (error: unknown) => error,
  );
  backend.beforeRetain = undefined;
  expect(error).toMatchObject({ errno: 29 });
  expect(service.resources().walkGrants).toBe(0);
  expect(service.resources().retained).toBe(1);
  const page = await walkPage(client, cursor, { grant: true, maxEntries: 128 });
  expect(page.entries.map((entry: { path: string }) => entry.path)).toEqual(["a", "b"]);
  await client.asyncCall("walkClose", [cursor]);
  expect(Array.from(backend.pins)).toEqual(baseline);
});

for (const stop of [revokeFilesystem, reapFilesystem]) {
  test(`${stop.name} releases walks, root pins and every outstanding grant`, async () => {
    const { client, service, backend } = fixture();
    for (const name of ["a", "b"])
      await client.asyncCall("writeFile", [`/${name}`], new Uint8Array());
    const root = await client.asyncCall("preopen", ["/"]);
    const first = await client.asyncCall("walkOpen", [root, plan]);
    const second = await client.asyncCall("walkOpen", [root, plan]);
    await walkPage(client, first, { grant: true, maxEntries: 1 });
    await walkPage(client, second, { grant: true, maxEntries: 1 });
    expect(service.resources().walkGrants).toBe(2);
    stop(client.connection);
    service.sweep();
    expect(service.resources().walkGrants).toBe(0);
    expect(service.resources().walks).toBe(0);
    expect(backend.pins.size).toBe(0);
  });
}

test("cancelled open and page replies release staged or delivered authority", async () => {
  const { client, service, backend } = fixture();
  await client.asyncCall("writeFile", ["/a"], new Uint8Array());
  const root = await client.asyncCall("preopen", ["/"]);
  const baseline = Array.from(backend.pins);
  const abandoned = client.submit("walkOpen", [root, plan]);
  await abandoned.value();
  abandoned.cancel();
  abandoned.release();
  await client.asyncCall("stat", [root]);
  expect(service.resources().walks).toBe(0);
  expect(Array.from(backend.pins)).toEqual(baseline);
  const cursor = await client.asyncCall("walkOpen", [root, plan]);
  const pending = client.submit("walkPage", [cursor, { grant: true, maxEntries: 1 }]);
  backend.beforeRetain = () => pending.cancel();
  const error = await pending.value().catch((error: unknown) => error);
  pending.release();
  backend.beforeRetain = undefined;
  expect(error).toMatchObject({ errno: 11 });
  expect(service.resources().walkGrants).toBe(0);
  const retry = await walkPage(client, cursor, { grant: true, maxEntries: 1 });
  expect(retry.entries[0]?.path).toBe("a");
  await client.asyncCall("walkClose", [cursor]);
  expect(Array.from(backend.pins)).toEqual(baseline);
});

test("invalid plans and unowned roots never allocate walk state", async () => {
  const { client, service, backend } = fixture();
  await client.asyncCall("writeFile", ["/a"], new Uint8Array());
  const root = await client.asyncCall("preopen", ["/"]);
  const before = Array.from(backend.pins);
  for (const invalid of [
    null,
    { ...plan, hidden: 1 },
    { ...plan, maxDepth: -1 },
    { ...plan, include: [{ kind: "path", glob: "[" }] },
  ]) {
    const error = await client
      .asyncCall("walkOpen", [root, invalid])
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ errno: 28 });
  }
  const node = backend.fs.lookup("/a")!;
  const unowned = backend.fs.handleForNode(node);
  const error = await client
    .asyncCall("walkOpen", [unowned, plan])
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ errno: 8 });
  expect(service.resources().walks).toBe(0);
  expect(Array.from(backend.pins)).toEqual(before);
});

test("synchronous process-worker client consumes and releases the real service pages", async () => {
  const { client, service } = fixture();
  await client.asyncCall("writeFile", ["/a"], new Uint8Array([65]));
  await client.asyncCall("writeFile", ["/b"], new Uint8Array([66]));
  const child = createFilesystemConnection(client.connection);
  service.connect(child.server);
  const worker = new Worker(new URL("./fixtures/filesystem-walk-worker.ts", import.meta.url).href);
  cleanups.push(() => worker.terminate());
  const reply = new Promise<unknown>((resolve, reject) => {
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = reject;
  });
  worker.postMessage(child.client, [child.client.port]);
  expect(await reply).toEqual({ paths: ["a", "b"], bytes: [65, 66] });
  service.sweep();
  expect(service.resources().walkGrants).toBe(0);
  expect(service.resources().walks).toBe(0);
});

function fileEntry(page: WalkPage) {
  const entry = page.entries[0];
  if (!entry || entry.kind !== "file") throw new Error("missing file entry");
  return entry;
}
function grantedFile(page: WalkPage) {
  const entry = fileEntry(page);
  if (entry.handle === null || entry.grant === null) throw new Error("missing grant");
  return { ...entry, handle: entry.handle, grant: entry.grant };
}

test("failed output publication rolls back the page and its exact grant references", async () => {
  const { client, service, backend } = fixture();
  await client.asyncCall("writeFile", ["/a"], new Uint8Array());
  const root = await client.asyncCall("preopen", ["/"]);
  const cursor = await client.asyncCall("walkOpen", [root, plan]);
  const before = Array.from(backend.pins);
  const write = Reflect.get(service, "writeResponse");
  if (typeof write !== "function") throw new Error("missing service reply writer");
  Object.defineProperty(service, "writeResponse", {
    configurable: true,
    value: () => {
      throw new Error("injected output failure");
    },
  });
  const error = await walkPage(client, cursor, { grant: true, maxEntries: 1 }).catch(
    (error: unknown) => error,
  );
  Reflect.deleteProperty(service, "writeResponse");
  expect(error).toMatchObject({ errno: 29 });
  expect(service.resources().walkGrants).toBe(0);
  expect(Array.from(backend.pins)).toEqual(before);
  const page = await walkPage(client, cursor, { grant: true, maxEntries: 1 });
  expect(page.entries[0]?.path).toBe("a");
  await client.asyncCall("walkClose", [cursor]);
});

test("depth-limited and glob-excluded entries are pruned before their access checks", async () => {
  const { client, backend } = fixture();
  await client.asyncCall("mkdirp", ["/denied"]);
  await client.asyncCall("writeFile", ["/ignored.txt"], new Uint8Array());
  await client.asyncCall("writeFile", ["/ok.ts"], new Uint8Array());
  backend.fs.lookup("/denied")!.mode = 0;
  backend.fs.lookup("/ignored.txt")!.mode = 0;
  const root = await client.asyncCall("preopen", ["/"]);
  const cursor = await client.asyncCall("walkOpen", [
    root,
    { ...plan, maxDepth: 1, include: [{ kind: "basename", glob: "*.ts" }] },
  ]);
  const page = await walkPage(client, cursor, { grant: true, maxEntries: 128 });
  expect(page.entries).toEqual([
    { kind: "file", path: "ok.ts", size: 0, handle: expect.any(Number), grant: expect.any(Number) },
  ]);
  await client.asyncCall("walkClose", [cursor]);
});

test("cancelling a published page releases its final-page grants and cursor", async () => {
  const { client, service, backend } = fixture();
  await client.asyncCall("writeFile", ["/a"], new Uint8Array());
  const root = await client.asyncCall("preopen", ["/"]);
  const baseline = Array.from(backend.pins);
  const cursor = await client.asyncCall("walkOpen", [root, plan]);
  const pending = client.submit("walkPage", [cursor, { grant: true, maxEntries: 128 }]);
  await pending.value();
  expect(service.resources().walkGrants).toBe(1);
  pending.cancel();
  pending.release();
  await client.asyncCall("stat", [root]);
  expect(service.resources().walkGrants).toBe(0);
  expect(service.resources().walks).toBe(0);
  expect(Array.from(backend.pins)).toEqual(baseline);
});
