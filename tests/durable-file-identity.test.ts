import { expect, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent";
import { MemoryBackend } from "../fs/backend";
import { FilesystemClient, FilesystemService, createFilesystemConnection } from "../fs";
import { publicationObserver } from "../fs/publication-internal";
import type { PublicationLimits } from "../fs/publication-internal";
import { snapshotBatch, type PersistedIndex, type PersistenceBatch, type StorageBackend } from "../fs/storage";
import type { IdentityReservation } from "../fs/file-identity";

const bytes = (value: string) => new TextEncoder().encode(value);
const limits: PublicationLimits = {
  sessions: 8, operations: 16, inputBytes: 256, argumentBytes: 1024,
  effectBytes: 8192, effects: 64, resultBytes: 256, logRecords: 32,
  logBytes: 32768, pins: 4, pinBytes: 256,
};

class IdentityStore implements StorageBackend {
  index?: PersistedIndex;
  readonly data = new Map<string, Uint8Array>();
  reservation?: IdentityReservation;
  reserveCalls = 0;
  persistCalls = 0;
  holdReserve?: Promise<void>;
  failReserve = false;
  holdPersist?: Promise<void>;
  failPersist = false;
  holdFlush?: Promise<void>;
  failFlush = false;
  entered = Promise.withResolvers<void>();
  async reserveIdentity(workspace?: string): Promise<IdentityReservation> {
    this.reserveCalls++;
    this.entered.resolve();
    await this.holdReserve;
    if (this.failReserve) throw new Error("reservation failed");
    if (workspace && workspace !== this.reservation?.workspace) throw new Error("workspace mismatch");
    this.reservation = { workspace: this.reservation?.workspace ?? crypto.randomUUID(), era: (this.reservation?.era ?? 0n) + 1n };
    return this.reservation;
  }
  async load() { return this.index && structuredClone(this.index); }
  async read(key: string) {
    const data = this.data.get(key);
    if (!data) throw new Error("missing payload");
    return data.slice();
  }
  async persist(batch: PersistenceBatch) {
    const copy = snapshotBatch(batch);
    this.persistCalls++;
    this.entered.resolve();
    await this.holdPersist;
    if (this.failPersist) throw new Error("persist failed");
    const nodes = new Map(this.index?.nodes.map(node => [node.ino, node]));
    for (const node of copy.upserts) nodes.set(node.ino, node);
    for (const ino of copy.removes) nodes.delete(ino);
    for (const [key, data] of copy.data) this.data.set(key, data);
    this.index = { version: 1, generation: copy.generation, root: copy.root, nodes: Array.from(nodes.values()) };
  }
  async flush() {
    this.entered.resolve();
    await this.holdFlush;
    if (this.failFlush) throw new Error("flush failed");
  }
  async close() {}
}

async function fixture(backend: MemoryBackend) {
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, undefined, { limits, observe: true });
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  await client.asyncCall("writeFile", ["/file"], bytes("seed"));
  const root = await client.asyncCall("preopen", ["/"]);
  const resolved = await client.asyncCall("resolve", [root, "file"]);
  const handle: number = resolved.node;
  client.retain(handle);
  await client.asyncCall("stat", [handle]);
  return { backend, service, client, handle, stop() { client.dispose(); service.dispose(); } };
}

function handle(backend: MemoryBackend, path: string) {
  const node = backend.fs.lookup(path);
  if (!node) throw new Error(`missing ${path}`);
  return backend.fs.handleForNode(node);
}

test("surviving identity and version reopen while discarded FAST births and revisions never alias", async () => {
  const store = new IdentityStore();
  const first = await PersistentBackend.open(store, { intervalMs: 0 });
  let second: PersistentBackend | undefined;
  try {
    first.execute("writeFile", ["/survivor"], bytes("saved"));
    const original = first.identity(handle(first, "/survivor"));
    expect(typeof original.id).toBe("bigint");
    await first.flush();
    first.execute("writeFile", ["/discarded"], bytes("lost"));
    const discarded = first.identity(handle(first, "/discarded"));
    first.execute("setMtime", [handle(first, "/survivor"), 123], new Uint8Array());
    const discardedVersion = first.identity(handle(first, "/survivor")).version;
    first.dispose();
    second = await PersistentBackend.open(store, { intervalMs: 0 });
    expect(second.identity(handle(second, "/survivor"))).toEqual(original);
    expect(second.fs.lookup("/discarded")).toBeUndefined();
    second.execute("writeFile", ["/later"], bytes("later"));
    expect(second.identity(handle(second, "/later")).id).not.toBe(discarded.id);
    second.execute("setMtime", [handle(second, "/survivor"), 124], new Uint8Array());
    expect(second.identity(handle(second, "/survivor")).version).not.toBe(discardedVersion);
  } finally { first.dispose(); second?.dispose(); }
});

test("actual service and direct commits update one general revision, metadata included; no effect does not", async () => {
  const current = await fixture(new MemoryBackend());
  const { backend, client } = current;
  const observer = publicationObserver(client);
  try {
    const first = backend.identity(current.handle);
    const start = await observer.cut();
    await client.asyncCall("setMtime", [current.handle, 42]);
    const metadata = backend.identity(current.handle);
    expect(metadata.id).toBe(first.id);
    expect(metadata.version).not.toBe(first.version);
    expect((await observer.cut()).generation).toBe(start.generation + 1);
    const unchanged = await observer.cut();
    await client.asyncCall("setMtime", [current.handle, 42]);
    await client.asyncCall("write", [current.handle, 0], new Uint8Array());
    expect(backend.identity(current.handle)).toEqual(metadata);
    expect(await observer.cut()).toEqual(unchanged);
    expect(client.tryWrite(current.handle, [bytes("x")], 0)).toBe(1);
    const direct = backend.identity(current.handle);
    expect(direct.version).not.toBe(metadata.version);
    expect(direct.id).toBe(first.id);
    const beforeMode = direct.version;
    await client.asyncCall("setMode", [current.handle, 0o400]);
    expect(backend.identity(current.handle).version).not.toBe(beforeMode);
    const denied = backend.identity(current.handle);
    await expect(client.asyncCall("write", [current.handle, 0], bytes("z"))).rejects.toMatchObject({ errno: 2 });
    expect(backend.identity(current.handle)).toEqual(denied);
  } finally { current.stop(); }
});

test("startup waits for its independent durable reservation and preserves old root on failure", async () => {
  const store = new IdentityStore();
  const gate = Promise.withResolvers<void>();
  store.holdReserve = gate.promise;
  let exposed = false;
  const opening = PersistentBackend.open(store, { intervalMs: 0 }).then(value => { exposed = true; return value; });
  await Promise.resolve();
  try {
    expect(store.reserveCalls).toBe(1);
    expect(exposed).toBe(false);
  } finally {
    gate.resolve();
    (await opening).dispose();
  }
  store.failReserve = true;
  const saved = structuredClone(store.index);
  await expect(PersistentBackend.open(store, { intervalMs: 0 })).rejects.toThrow("reservation failed");
  expect(store.index).toEqual(saved);
});
