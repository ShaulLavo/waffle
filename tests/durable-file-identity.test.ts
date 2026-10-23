import { expect, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent";
import { MemoryBackend } from "../fs/backend";
import { FilesystemClient, FilesystemService, createFilesystemConnection } from "../fs";
import { publicationObserver, type PublicationLimits } from "../fs/publication-internal";
import {
  snapshotBatch,
  type PersistedIndex,
  type PersistenceBatch,
  type StorageBackend,
} from "../fs/storage";
import { MAX_IDENTITY_PART, storeIdentity, type IdentityReservation } from "../fs/file-identity";

const bytes = (value: string) => new TextEncoder().encode(value);
const limits: PublicationLimits = {
  sessions: 8,
  operations: 16,
  inputBytes: 256,
  argumentBytes: 1024,
  effectBytes: 8192,
  effects: 64,
  resultBytes: 256,
  logRecords: 32,
  logBytes: 262144,
  pins: 4,
  pinBytes: 256,
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
  flushCalls = 0;
  failFlushAt?: number;
  entered = Promise.withResolvers<void>();
  async reserveIdentity(workspace?: string): Promise<IdentityReservation> {
    this.reserveCalls++;
    this.entered.resolve();
    await this.holdReserve;
    if (this.failReserve) throw new Error("reservation failed");
    if (workspace && workspace !== this.reservation?.workspace)
      throw new Error("workspace mismatch");
    this.reservation = {
      workspace: this.reservation?.workspace ?? crypto.randomUUID(),
      era: (this.reservation?.era ?? 0n) + 1n,
    };
    return this.reservation;
  }
  async load() {
    return this.index && structuredClone(this.index);
  }
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
    const nodes = new Map(this.index?.nodes.map((node) => [node.ino, node]));
    for (const node of copy.upserts) nodes.set(node.ino, node);
    for (const ino of copy.removes) nodes.delete(ino);
    for (const [key, data] of copy.data) this.data.set(key, data);
    this.index = {
      version: 1,
      generation: copy.generation,
      root: copy.root,
      nodes: Array.from(nodes.values()),
    };
  }
  async flush() {
    this.entered.resolve();
    await this.holdFlush;
    this.flushCalls++;
    if (this.failFlush || this.flushCalls === this.failFlushAt) throw new Error("flush failed");
  }
  async close() {}
}

async function fixture(backend: MemoryBackend) {
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, { limits, observe: true });
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  await client.asyncCall("writeFile", ["/file"], bytes("seed"));
  const root = await client.asyncCall("preopen", ["/"]);
  const resolved = await client.asyncCall("resolve", [root, "file"]);
  const handle: number = resolved.node;
  client.retain(handle);
  await client.asyncCall("stat", [handle]);
  return {
    backend,
    service,
    client,
    handle,
    stop() {
      client.dispose();
      service.dispose();
    },
  };
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
  } finally {
    first.dispose();
    second?.dispose();
  }
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
    const deniedCut = await observer.cut();
    const failing = client.asyncCall("write", [current.handle, 0], bytes("z"));
    let failure: unknown;
    try {
      await failing;
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ errno: 2 });
    expect(backend.identity(current.handle)).toEqual(denied);
    expect(await observer.cut()).toEqual(deniedCut);
  } finally {
    current.stop();
  }
});

test("startup waits for its independent durable reservation and preserves old root on failure", async () => {
  const store = new IdentityStore();
  const gate = Promise.withResolvers<void>();
  store.holdReserve = gate.promise;
  let exposed = false;
  const opening = PersistentBackend.open(store, { intervalMs: 0 }).then((value) => {
    exposed = true;
    return value;
  });
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
  await expect(PersistentBackend.open(store, { intervalMs: 0 })).rejects.toThrow(
    "reservation failed",
  );
  expect(store.index).toEqual(saved);
});

test("real links, rename and retained replacement keep node identities and group versions", async () => {
  const current = await fixture(new MemoryBackend());
  const { backend, client, handle: source } = current;
  const observer = publicationObserver(client);
  try {
    const root = await client.asyncCall("preopen", ["/"]);
    const resolve = (name: string) => client.asyncCall("resolve", [root, name]);
    await client.asyncCall("writeFile", ["/target"], bytes("target"));
    const target = (await resolve("target")).node;
    client.retain(target);
    const original = backend.identity(source),
      destination = backend.identity(target);
    const rootBefore = backend.identity(root);
    const beforeLinkTokens = backend.shared.identities.available;
    await client.asyncCall("link", [await resolve("file"), await resolve("alias")]);
    expect(beforeLinkTokens - backend.shared.identities.available).toBe(2n);
    expect(backend.identity((await resolve("alias")).node).id).toBe(original.id);
    expect(backend.identity(root).version).not.toBe(rootBefore.version);
    const beforeMove = backend.identity(source);
    const beforeRenameTokens = backend.shared.identities.available;
    await client.asyncCall("rename", [await resolve("file"), await resolve("target")]);
    expect(beforeRenameTokens - backend.shared.identities.available).toBe(3n);
    expect(backend.identity((await resolve("target")).node).id).toBe(original.id);
    expect(backend.identity(source).version).not.toBe(beforeMove.version);
    expect(backend.identity(target).id).toBe(destination.id);
    expect(backend.identity(target).version).not.toBe(destination.version);
    expect(client.tryWrite(target, [bytes("T")], 0)).toBe(1);
    expect(backend.identity(target).id).toBe(destination.id);
    const before = backend.identity(source),
      cut = await observer.cut();
    await client.asyncCall("rename", [await resolve("alias"), await resolve("target")]);
    expect(backend.identity(source)).toEqual(before);
    expect(await observer.cut()).toEqual(cut);
  } finally {
    current.stop();
  }
});

import { Wasi } from "../core/wasi";
import { shareFileResource } from "../core/open-file";
import { guestFunction, guestModule } from "./fixtures/publication-wasm";

test("real WASI guest direct byte and size groups assign exactly one general version", async () => {
  const current = await fixture(new MemoryBackend());
  const guestClient = new FilesystemClient(current.client.fork());
  const memory = new WebAssembly.Memory({ initial: 4 });
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: guestClient,
    preopens: {},
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {
      throw new Error("unexpected sleep");
    },
  });
  try {
    const root = await guestClient.asyncCall("preopen", ["/"]);
    const file = (await guestClient.asyncCall("resolve", [root, "file"])).node;
    guestClient.retain(file);
    const resource = { kind: "file" as const, handle: file, offset: 0, append: false };
    shareFileResource(resource, guestClient.connection);
    const fd = wasi.descriptors.open(
      resource,
      (1n << 1n) | (1n << 2n) | (1n << 6n) | (1n << 22n),
      0n,
    );
    const module = guestModule("wasi_snapshot_preview1", [
      { name: "fd_pwrite", parameters: ["i32", "i32", "i32", "i64", "i32"] },
      { name: "fd_filestat_set_size", parameters: ["i32", "i64"] },
    ]);
    const guest = new WebAssembly.Instance(module, wasi.imports(module));
    wasi.start(guest);
    const view = new DataView(memory.buffer);
    view.setUint32(0, 256, true);
    view.setUint32(4, 1, true);
    new Uint8Array(memory.buffer)[256] = 90;
    const before = current.backend.identity(file);
    const available = current.backend.shared.identities.available;
    expect(guestFunction(guest, "fd_pwrite")(fd, 0, 1, 1n, 32)).toBe(0);
    expect(available - current.backend.shared.identities.available).toBe(1n);
    expect(current.backend.identity(file).version).not.toBe(before.version);
    expect(current.backend.identity(file).id).toBe(before.id);
    const previous = current.backend.identity(file);
    const beforeResize = current.backend.shared.identities.available;
    expect(guestFunction(guest, "fd_filestat_set_size")(fd, 5n)).toBe(0);
    expect(beforeResize - current.backend.shared.identities.available).toBe(1n);
    expect(current.backend.identity(file).version).not.toBe(previous.version);
    expect(current.backend.shared.stat(file)?.size).toBe(5);
  } finally {
    wasi.descriptors.dispose();
    guestClient.dispose();
    current.stop();
  }
});

test("highest deleted ID and discarded versions never recur on reopen", async () => {
  const store = new IdentityStore();
  const first = await PersistentBackend.open(store, { intervalMs: 0 });
  first.execute("writeFile", ["/highest"], bytes("x"));
  const highest = first.identity(handle(first, "/highest"));
  first.execute("remove", ["/highest"], new Uint8Array());
  await first.flush();
  first.dispose();
  const second = await PersistentBackend.open(store, { intervalMs: 0 });
  try {
    second.execute("writeFile", ["/new"], bytes("y"));
    expect(second.identity(handle(second, "/new")).id).toBeGreaterThan(highest.id);
  } finally {
    second.dispose();
  }
});

test("serial exhaustion rejects namespace and direct changes before effect or publication", async () => {
  const current = await fixture(new MemoryBackend());
  const { backend, client } = current;
  const observer = publicationObserver(client);
  try {
    const before = backend.identity(current.handle),
      cut = await observer.cut();
    const original = client.shared.snapshot(current.handle)!.data;
    backend.shared.identities.configure(
      { workspace: backend.workspaceId, era: 1n },
      MAX_IDENTITY_PART,
    );
    expect(() => backend.execute("writeFile", ["/new"], bytes("x"))).toThrow("exhausted");
    expect(backend.fs.lookup("/new")).toBeUndefined();
    for (let attempt = 0; attempt <= limits.operations; attempt++) {
      expect(client.tryWrite(current.handle, [bytes("z")], 0)).toBe(-33);
      expect(client.resize(current.handle, 5, false)).toBe(33);
      expect(client.setMtime(current.handle, 17)).toBe(33);
    }
    expect(backend.identity(current.handle)).toEqual(before);
    expect(client.shared.snapshot(current.handle)!.data).toEqual(original);
    expect(await observer.cut()).toEqual(cut);
    backend.shared.identities.configure({ workspace: backend.workspaceId, era: 2n });
    expect(client.tryWrite(current.handle, [bytes("r")], 0)).toBe(1);
    expect((await observer.cut()).generation).toBe(cut.generation + 1);
  } finally {
    current.stop();
  }
});

test("coherent identity, metadata and payload capture precedes a writer during held storage", async () => {
  const store = new IdentityStore();
  const backend = await PersistentBackend.open(store, { intervalMs: 0 });
  const current = await fixture(backend);
  const gate = Promise.withResolvers<void>();
  try {
    await backend.flush();
    expect(current.client.tryWrite(current.handle, [bytes("a")], 0)).toBe(1);
    const captured = backend.identity(current.handle);
    store.holdPersist = gate.promise;
    store.entered = Promise.withResolvers<void>();
    const saving = backend.checkpoint();
    await store.entered.promise;
    expect(current.client.tryWrite(current.handle, [bytes("b")], 0)).toBe(1);
    const later = backend.identity(current.handle);
    expect(later.version).not.toBe(captured.version);
    gate.resolve();
    await saving;
    store.holdPersist = undefined;
    const node = store.index!.nodes.find(
      (node) => node.ino === backend.fs.nodeForHandle(current.handle).ino,
    )!;
    expect(node.identity).toEqual(storeIdentity(captured, backend.workspaceId));
    expect(store.data.get(node.data!)![0]).toBe(97);
    await backend.checkpoint();
    expect(store.index!.nodes.find((entry) => entry.ino === node.ino)!.identity).toEqual(
      storeIdentity(later, backend.workspaceId),
    );
  } finally {
    gate.resolve();
    current.stop();
    backend.dispose();
  }
});

function legacyStore() {
  const store = new IdentityStore();
  store.data.set("old", bytes("old"));
  store.index = {
    version: 1,
    generation: 1,
    root: 1,
    nodes: [
      { ino: 1, kind: "dir", mode: 0o700, mtime: 1, size: 0, children: [["old", 2]] },
      { ino: 2, kind: "file", mode: 0o600, mtime: 1, size: 3, data: "old" },
    ],
  };
  return store;
}

for (const stage of ["reserve", "payload-flush", "persist", "root-flush"] as const) {
  test(`interrupted old-root adoption at ${stage} never exposes partial metadata or resets root`, async () => {
    const store = legacyStore(),
      original = structuredClone(store.index);
    if (stage === "reserve") store.failReserve = true;
    if (stage === "persist") store.failPersist = true;
    if (stage === "payload-flush") store.failFlushAt = 1;
    if (stage === "root-flush") store.failFlushAt = 2;
    let rejected = false;
    try {
      (await PersistentBackend.open(store, { intervalMs: 0 })).dispose();
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    if (stage !== "root-flush") expect(store.index).toEqual(original);
    const savedIdentity = store.index!.nodes[1]!.identity;
    store.failReserve = false;
    store.failPersist = false;
    store.failFlushAt = undefined;
    const restored = await PersistentBackend.open(store, { intervalMs: 0 });
    try {
      expect(new TextDecoder().decode(await store.read("old"))).toBe("old");
      expect(restored.fs.lookup("/old")).toBeDefined();
      if (savedIdentity)
        expect(
          storeIdentity(restored.identity(handle(restored, "/old")), restored.workspaceId),
        ).toEqual(savedIdentity);
      expect(store.index!.nodes.every((node) => node.identity !== undefined)).toBe(true);
    } finally {
      restored.dispose();
    }
  });
}

test("renewal waits outside mutation lock and an interrupted reservation cannot change node metadata", async () => {
  const store = new IdentityStore();
  const backend = await PersistentBackend.open(store, { intervalMs: 0 });
  const current = await fixture(backend),
    gate = Promise.withResolvers<void>();
  try {
    const before = backend.identity(current.handle);
    store.holdReserve = gate.promise;
    store.entered = Promise.withResolvers<void>();
    const renewal = backend.renewIdentityReservation();
    await store.entered.promise;
    expect(backend.shared.cells[1]).toBe(0);
    expect(current.client.tryWrite(current.handle, [bytes("q")], 0)).toBe(1);
    const during = backend.identity(current.handle);
    expect(during.version).not.toBe(before.version);
    gate.resolve();
    await renewal;
    expect(backend.identity(current.handle)).toEqual(during);
    expect(current.client.tryWrite(current.handle, [bytes("r")], 0)).toBe(1);
    expect(backend.identity(current.handle).version >> 64n).toBe(2n);
  } finally {
    gate.resolve();
    current.stop();
    backend.dispose();
  }
});

for (const invalid of [
  "0",
  "1",
  "10000000000000000",
  "01",
  "fffffffffffffffffffffffffffffffff",
  "-1",
  "xyz",
]) {
  test(`external malformed token ${invalid} is rejected before reservation or exposure`, async () => {
    const store = new IdentityStore();
    const backend = await PersistentBackend.open(store, { intervalMs: 0 });
    backend.execute("writeFile", ["/saved"], bytes("x"));
    await backend.flush();
    backend.dispose();
    store.index!.nodes[0]!.identity = { ...store.index!.nodes[0]!.identity!, id: invalid };
    const reservations = store.reserveCalls;
    let rejected = false;
    try {
      (await PersistentBackend.open(store, { intervalMs: 0 })).dispose();
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(store.reserveCalls).toBe(reservations);
  });
}

test("failed renewal preserves the active serial and FAST admission has no durable barrier", async () => {
  const store = new IdentityStore();
  const backend = await PersistentBackend.open(store, { intervalMs: 0 });
  const current = await fixture(backend);
  try {
    const reservationCalls = store.reserveCalls;
    const flushes = store.flushCalls;
    const before = backend.identity(current.handle);
    store.failReserve = true;
    await expect(backend.renewIdentityReservation()).rejects.toThrow("reservation failed");
    expect(backend.identity(current.handle)).toEqual(before);
    expect(current.client.tryWrite(current.handle, [bytes("a")], 0)).toBe(1);
    await current.client.asyncCall("setMtime", [current.handle, 71]);
    expect(store.reserveCalls).toBe(reservationCalls + 1);
    expect(store.flushCalls).toBe(flushes);
    expect(backend.identity(current.handle).version >> 64n).toBe(1n);
  } finally {
    current.stop();
    backend.dispose();
  }
});

for (const corruption of ["partial", "duplicate", "workspace", "regressed-version"] as const) {
  test(`external ${corruption} identity metadata rejects before reservation or exposure`, async () => {
    const store = new IdentityStore();
    const backend = await PersistentBackend.open(store, { intervalMs: 0 });
    backend.execute("writeFile", ["/saved"], bytes("x"));
    await backend.flush();
    backend.dispose();
    const root = store.index!.nodes[0]!,
      file = store.index!.nodes[1]!;
    if (corruption === "partial") delete file.identity;
    if (corruption === "duplicate") file.identity = { ...file.identity!, id: root.identity!.id };
    if (corruption === "workspace")
      file.identity = { ...file.identity!, workspace: crypto.randomUUID() };
    if (corruption === "regressed-version")
      file.identity = { ...file.identity!, version: root.identity!.id };
    const reservations = store.reserveCalls;
    await expect(PersistentBackend.open(store, { intervalMs: 0 })).rejects.toThrow("Invalid");
    expect(store.reserveCalls).toBe(reservations);
  });
}
