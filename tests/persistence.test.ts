import { fixturePayloadHooks } from "./fixtures/publication-storage";
import { nextReservation, storeReservation, type StoredReservation } from "../fs/file-identity";
import { DescriptorTable } from "../core/descriptors.js";
import { ProcessABI } from "../proc/abi.js";
import { ProcessSupervisor } from "../proc/supervisor.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { permissionStorageCase } from "./fixtures/permissions-storage.js";
import { afterEach, expect, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent";
import { validatePersistedIndex, type StorageBackend } from "../fs/storage";
import {
  FilesystemService,
  FilesystemClient,
  createFilesystemConnection,
  createFilesystemIdentity,
  connectFilesystemIdentity,
} from "../fs";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array) => new TextDecoder().decode(data);
class Store {
  private identityReservation?: StoredReservation;
  async reserveIdentity(workspace?: string) {
    const value = nextReservation(this.identityReservation, workspace);
    this.identityReservation = storeReservation(value);
    return value;
  }
  index: any;
  payloads = new Map<string, Uint8Array>();
  ranges: { offset: number; length: number }[] = [];
  readRange = (key: string, range: Parameters<StorageBackend["readRange"]>[1]) => {
    this.ranges.push({ offset: range.offset, length: range.length });
    return fixturePayloadHooks(this.payloads).readRange(key, range);
  };
  retainPayload = fixturePayloadHooks(this.payloads).retainPayload;
  reads = 0;
  batches: any[] = [];
  fail = false;
  gate?: Promise<void>;
  async load() {
    return this.index && structuredClone(this.index);
  }
  async read(key: string) {
    this.reads++;
    const data = this.payloads.get(key);
    if (!data) throw new Error("missing data");
    return data.slice();
  }
  async persist(batch: any) {
    if (this.gate) await this.gate;
    if (this.fail) throw new Error("storage failed");
    this.batches.push(batch);
    const nodes = new Map<number, any>(
      (this.index?.nodes ?? []).map((node: any) => [node.ino, node]),
    );
    for (const node of batch.upserts) nodes.set(node.ino, structuredClone(node));
    for (const ino of batch.removes) nodes.delete(ino);
    for (const [key, data] of batch.data) this.payloads.set(key, data.slice());
    this.index = {
      version: 1,
      generation: batch.generation,
      root: batch.root,
      nodes: Array.from(nodes.values()),
    };
  }
  async flush() {}
  async close() {}
}
async function fixture(store: Store, maxBytes?: number, intervalMs = 0) {
  const backend = await PersistentBackend.open(store, { intervalMs });
  const service = new FilesystemService(backend);
  const connection =
    maxBytes === undefined
      ? createFilesystemConnection()
      : connectFilesystemIdentity(createFilesystemIdentity(undefined, maxBytes));
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  cleanup.push(() => {
    client.dispose();
    service.dispose();
    backend.dispose();
  });
  return { backend, service, client };
}
test("flush preserves data, metadata, hard links and renames; reload loads no payloads", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/dir/a"], encode("saved"));
  const root = await first.client.asyncCall("preopen", ["/"]);
  const a = await first.client.asyncCall("resolve", [root, "dir/a"]);
  const b = await first.client.asyncCall("resolve", [root, "dir/b"]);
  expect(await first.client.asyncCall("link", [a, b])).toBe(0);
  expect((await first.client.asyncCall("stat", [a.node])).nlink).toBe(2);
  expect(await first.client.asyncCall("setMtime", [a.node, 123456])).toBe(0);
  await first.client.asyncCall("move", ["/dir/a", "/dir/renamed"]);
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  expect(store.reads).toBe(0);
  const restoredRoot = await second.client.asyncCall("preopen", ["/"]);
  const restored = await second.client.asyncCall("resolve", [restoredRoot, "dir/b"]);
  expect((await second.client.asyncCall("stat", [restored.node])).nlink).toBe(2);
  const listing = await second.client.asyncCall("lookup", ["/dir"]);
  expect(listing.children.get("b").ino).toBe(listing.children.get("renamed").ino);
  expect(listing.children.get("renamed").mtime).toBe(123456);
  expect(store.reads).toBe(0);
  expect(decode(await second.client.asyncCall("readFile", ["/dir/renamed"]))).toBe("saved");
  expect(store.reads).toBe(1);
});
test("a blocked background commit never stalls writes or reads and errors reach flush", async () => {
  const store = new Store();
  const { client, backend } = await fixture(store);
  await client.asyncCall("writeFile", ["/a"], encode("first"));
  let release!: () => void;
  store.gate = new Promise<void>((done) => {
    release = done;
  });
  const flushing = client.asyncCall("flush");
  await new Promise((done) => setTimeout(done, 10));
  await client.asyncCall("writeFile", ["/b"], encode("second"));
  expect(decode(await client.asyncCall("readFile", ["/b"]))).toBe("second");
  release();
  await flushing;
  store.gate = undefined;
  store.fail = true;
  await expect(backend.flush()).rejects.toThrow("storage failed");
  store.fail = false;
  await backend.flush();
  const second = await fixture(store);
  expect(decode(await second.client.asyncCall("readFile", ["/b"]))).toBe("second");
});
test("unlinked open files retain bytes while persisted names disappear", async () => {
  const store = new Store();
  const { client } = await fixture(store);
  await client.asyncCall("writeFile", ["/a"], encode("open"));
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "a"]);
  await client.asyncCall("retain", [path.node]);
  await client.asyncCall("removePath", [path, false]);
  expect(decode(await client.asyncCall("read", [path.node, 8, 0]))).toBe("open");
  await client.asyncCall("flush");
  const second = await fixture(store);
  expect(await second.client.asyncCall("readFile", ["/a"])).toBeUndefined();
});
test("one file edit writes bounded metadata instead of the entire tree", async () => {
  const store = new Store();
  const { client } = await fixture(store);
  for (let i = 0; i < 100; i++)
    await client.asyncCall("writeFile", [`/pkg/file${i}`], encode("old"));
  await client.asyncCall("flush");
  await client.asyncCall("writeFile", ["/pkg/file42"], encode("new"));
  await client.asyncCall("flush");
  expect(store.batches.at(-1).upserts.length).toBeLessThan(5);
});
test("direct shared writes are checkpointed, including writes during an older commit", async () => {
  const store = new Store();
  const { client } = await fixture(store);
  await client.asyncCall("writeFile", ["/direct"], encode("old data"));
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "direct"]);
  client.retain(path.node);
  await client.asyncCall("flush");
  let release!: () => void;
  store.gate = new Promise<void>((done) => {
    release = done;
  });
  expect(client.write(path.node, [encode("first")], 0)).toBe(5);
  const older = client.asyncCall("flush");
  await new Promise((done) => setTimeout(done, 10));
  expect(client.write(path.node, [encode("later")], 0)).toBe(5);
  release();
  await older;
  store.gate = undefined;
  await client.asyncCall("flush");
  client.release(path.node);
  const second = await fixture(store);
  expect(decode(await second.client.asyncCall("readFile", ["/direct"]))).toBe("laterata");
});
test("lazy stat and descriptor retain do not read payloads; first direct read stays bounded", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/lazy"], encode("payload"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  const root = await second.client.asyncCall("preopen", ["/"]);
  const path = await second.client.asyncCall("resolve", [root, "lazy"]);
  second.client.retain(path.node);
  expect(second.client.stat(path.node).size).toBe(7);
  expect(store.reads).toBe(0);
  expect(store.ranges).toEqual([]);
  expect(decode(await second.client.asyncCall("read", [path.node, 100, 0]))).toBe("payload");
  expect(store.reads).toBe(0);
  expect(store.ranges).toEqual([{ offset: 0, length: 7 }]);
  expect(second.backend.shared.isResident(path.node)).toBe(false);
  second.client.release(path.node);
});
test("metadata-only edits to a lazy open file persist without loading its bytes", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/metadata"], encode("payload"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  const root = await second.client.asyncCall("preopen", ["/"]);
  const path = await second.client.asyncCall("resolve", [root, "metadata"]);
  second.client.retain(path.node);
  expect(second.client.setMtime(path.node, 777)).toBe(0);
  await second.client.asyncCall("flush");
  expect(store.reads).toBe(0);
  const third = await fixture(store);
  expect((await third.client.asyncCall("lookup", ["/metadata"])).mtime).toBe(777);
  second.client.release(path.node);
});

test("clean persisted contents can exceed the resident pool even with few large files", async () => {
  const store = new Store();
  const { client } = await fixture(store, 16 * 1024 * 1024);
  const bytes = new Uint8Array(4 * 1024 * 1024).fill(7);
  for (let i = 0; i < 6; i++) {
    await client.asyncCall("writeFile", [`/large${i}`], bytes);
    await client.asyncCall("flush");
  }
  expect((await client.asyncCall("readFile", ["/large0"])).length).toBe(bytes.length);
});
test("persisted files spanning segments reload lazily beyond the resident pool", async () => {
  const store = new Store();
  const first = await fixture(store, 64 * 1024 * 1024);
  const bytes = new Uint8Array(32 * 1024 * 1024).fill(7);
  for (let i = 0; i < 3; i++) {
    await first.client.asyncCall("writeFile", [`/spanning${i}`], bytes);
    await first.client.asyncCall("flush");
  }
  const second = await fixture(store, 64 * 1024 * 1024);
  expect(store.reads).toBe(0);
  for (let i = 0; i < 3; i++) {
    const loaded = await second.client.asyncCall("readFile", [`/spanning${i}`]);
    expect(loaded.length).toBe(bytes.length);
    expect(loaded[0]).toBe(7);
    expect(loaded.at(-1)).toBe(7);
  }
  expect(second.backend.shared.resources().usedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
});
test("memory-only worker sync acknowledges success with a zero errno", async () => {
  const { MemoryBackend } = await import("../fs");
  const service = new FilesystemService(new MemoryBackend());
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  cleanup.push(() => {
    client.dispose();
    service.dispose();
  });
  const root = await client.asyncCall("preopen", ["/"]);
  expect(await client.asyncCall("sync", [root])).toBe(0);
});

test("background persistence coalesces writes while an earlier checkpoint is blocked", async () => {
  const store = new Store();
  let release!: () => void;
  store.gate = new Promise<void>((done) => {
    release = done;
  });
  cleanup.push(release);
  const { client, backend } = await fixture(store, undefined, 2);
  let snapshots = 0;
  const snapshot = backend.shared.snapshot.bind(backend.shared);
  backend.shared.snapshot = (handle) => {
    snapshots++;
    return snapshot(handle);
  };
  await client.asyncCall("writeFile", ["/busy"], encode("zero"));
  await new Promise((done) => setTimeout(done, 10));
  const first = snapshots;
  for (let i = 0; i < 5; i++) {
    await client.asyncCall("writeFile", ["/busy"], encode(`edit${i}`));
    await new Promise((done) => setTimeout(done, 4));
  }
  expect(first).toBeGreaterThan(0);
  expect(snapshots).toBe(first);
  release();
  store.gate = undefined;
  await client.asyncCall("flush");
});

test("a direct write immediately after hydration is not mistaken for clean data", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/race"], encode("OLD"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  const hydrate = second.backend.shared.hydrate.bind(second.backend.shared);
  second.backend.shared.hydrate = (handle, bytes) => {
    hydrate(handle, bytes);
    second.backend.shared.write(handle, [encode("NEW")], 0);
  };
  await second.client.asyncCall("readFile", ["/race"]);
  await second.client.asyncCall("flush");
  const third = await fixture(store);
  expect(decode(await third.client.asyncCall("readFile", ["/race"]))).toBe("NEW");
});

test("capacity reclamation does not evict the cold file being hydrated", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/small"], new Uint8Array(6 * 1024 * 1024).fill(1));
  await first.client.asyncCall("writeFile", ["/large"], new Uint8Array(12 * 1024 * 1024).fill(2));
  await first.client.asyncCall("flush");
  const second = await fixture(store, 16 * 1024 * 1024);
  await second.client.asyncCall("readFile", ["/small"]);
  const bytes = await second.client.asyncCall("readFile", ["/large"]);
  expect(bytes.length).toBe(12 * 1024 * 1024);
  expect(bytes[0]).toBe(2);
});

test("full replacement and truncate-to-zero do not load discarded cold contents", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/replace"], encode("discarded"));
  await first.client.asyncCall("writeFile", ["/truncate"], encode("discarded"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  store.read = async () => {
    throw new Error("old payload must not be read");
  };
  await second.client.asyncCall("writeFile", ["/replace"], encode("new"));
  const root = await second.client.asyncCall("preopen", ["/"]);
  const path = await second.client.asyncCall("resolve", [root, "truncate"]);
  expect(await second.client.asyncCall("resize", [path.node, 0, true])).toBe(0);
  await second.client.asyncCall("flush");
  expect(decode(await second.client.asyncCall("readFile", ["/replace"]))).toBe("new");
  expect((await second.client.asyncCall("readFile", ["/truncate"])).length).toBe(0);
});

test("rename replacement and removal do not walk the unrelated cold namespace", async () => {
  const store = new Store();
  const first = await fixture(store);
  for (let i = 0; i < 100; i++)
    await first.client.asyncCall("writeFile", [`/cold${i}/a`], encode("cold"));
  await first.client.asyncCall("writeFile", ["/a"], encode("hot"));
  await first.client.asyncCall("writeFile", ["/renamed"], encode("replaced"));
  await first.client.asyncCall("writeFile", ["/removed"], encode("removed"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  const children = second.backend.fs.root.children;
  const values = children.values.bind(children);
  let walks = 0;
  children.values = () => {
    walks++;
    return values();
  };
  await second.client.asyncCall("move", ["/a", "/renamed"]);
  await second.client.asyncCall("remove", ["/removed"]);
  await second.client.asyncCall("flush");
  expect(walks).toBe(0);
  expect(store.reads).toBe(0);
});

test("deleted closed files release persistence bookkeeping", async () => {
  const store = new Store();
  const { client, backend } = await fixture(store);
  for (let i = 0; i < 10; i++) {
    await client.asyncCall("writeFile", [`/temporary${i}`], encode("gone"));
    await client.asyncCall("flush");
    await client.asyncCall("remove", [`/temporary${i}`]);
    await client.asyncCall("flush");
  }
  expect((backend as any).registeredNodes.size).toBeLessThanOrEqual(1);
  expect((backend as any).keys.size).toBe(0);
  expect((backend as any).committedKeys.size).toBe(0);
});

test("cold detached descriptors retain their payload key across unrelated failed commits", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/a"], encode("cold"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  const root = await second.client.asyncCall("preopen", ["/"]);
  const path = await second.client.asyncCall("resolve", [root, "a"]);
  second.client.retain(path.node);
  await second.client.asyncCall("removePath", [path, false]);
  await second.client.asyncCall("flush");
  await second.client.asyncCall("writeFile", ["/b"], encode("unrelated"));
  store.fail = true;
  await expect(second.backend.flush()).rejects.toThrow("storage failed");
  store.fail = false;
  await second.backend.flush();
  expect(decode(await second.client.asyncCall("read", [path.node, 20, 0]))).toBe("cold");
  second.client.release(path.node);
});

async function failedCheckpoint(
  backend: PersistentBackend,
  store: Store,
  failure: "capture" | "persist",
  hot: number,
) {
  if (failure === "persist") {
    store.fail = true;
    try {
      await expect(backend.flush()).rejects.toThrow("storage failed");
    } finally {
      store.fail = false;
    }
    return;
  }
  const snapshot = backend.shared.snapshot.bind(backend.shared);
  backend.shared.snapshot = (handle) => {
    if (handle === hot) throw new Error("capture failed");
    return snapshot(handle);
  };
  try {
    await expect(backend.flush()).rejects.toThrow("capture failed");
  } finally {
    backend.shared.snapshot = snapshot;
  }
}

for (const failure of ["capture", "persist"] as const)
  test(`checkpoint rollback preserves cold baselines and retries resident bytes after ${failure} failure`, async () => {
    const store = new Store();
    const first = await fixture(store);
    for (const path of ["/linked", "/detached", "/stale", "/hot"])
      await first.client.asyncCall("writeFile", [path], encode("OLD"));
    await first.client.asyncCall("flush");
    const { client, backend } = await fixture(store);
    const root = await client.asyncCall("preopen", ["/"]);
    const linked = (await client.asyncCall("resolve", [root, "linked"])).node;
    const detached = await client.asyncCall("resolve", [root, "detached"]);
    const stale = await client.asyncCall("resolve", [root, "stale"]);
    const hot = (await client.asyncCall("resolve", [root, "hot"])).node;
    for (const handle of [linked, detached.node, stale.node, hot]) client.retain(handle);
    await client.asyncCall("removePath", [detached, false]);
    await client.asyncCall("removePath", [stale, false]);
    await backend.flush();
    const identities = [backend.identity(linked), backend.identity(detached.node)];
    const staleRevision = backend.shared.revision(stale.node);
    await client.asyncCall("setMtime", [stale.node, 123456]);
    expect(backend.shared.revision(stale.node)).not.toBe(staleRevision);
    expect(backend.shared.isResident(stale.node)).toBe(false);
    await backend.prepare("read", [hot]);
    expect(client.write(hot, [encode("NEW")], 0)).toBe(3);
    const reads = store.reads;
    const residentBytes = backend.shared.resources().usedBytes;
    await failedCheckpoint(backend, store, failure, hot);
    expect(backend.checkpointPressure().pendingOperations).toBe(0);
    expect(decode(await client.asyncCall("read", [linked, 3, 0]))).toBe("OLD");
    expect(decode(await client.asyncCall("read", [detached.node, 3, 0]))).toBe("OLD");
    expect(backend.shared.isResident(linked)).toBe(false);
    expect(backend.shared.isResident(detached.node)).toBe(false);
    expect([backend.identity(linked), backend.identity(detached.node)]).toEqual(identities);
    const ranges = store.ranges.length;
    expect(() => backend.prepareDescriptorRead(stale.node, 0, 3, () => false)).toThrow(
      "cold revision is not retained",
    );
    expect(store.ranges.length).toBe(ranges);
    expect(store.reads).toBe(reads);
    expect(backend.shared.resources().usedBytes).toBe(residentBytes);
    await backend.flush();
    expect(decode(await client.asyncCall("read", [linked, 3, 0]))).toBe("OLD");
    expect(decode(await client.asyncCall("read", [detached.node, 3, 0]))).toBe("OLD");
    expect(store.reads).toBe(reads);
    const reloaded = await fixture(store);
    expect(decode(await reloaded.client.asyncCall("readFile", ["/hot"]))).toBe("NEW");
    expect(await reloaded.client.asyncCall("readFile", ["/detached"])).toBeUndefined();
    for (const handle of [linked, detached.node, stale.node, hot]) client.release(handle);
  });

test("closing a detached descriptor during its commit does not resurrect a payload pin", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/a"], encode("cold"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  const root = await second.client.asyncCall("preopen", ["/"]);
  const path = await second.client.asyncCall("resolve", [root, "a"]);
  second.client.retain(path.node);
  await second.client.asyncCall("removePath", [path, false]);
  let release!: () => void;
  store.gate = new Promise<void>((done) => {
    release = done;
  });
  cleanup.push(release);
  const pending = second.backend.flush();
  await new Promise((done) => setTimeout(done, 5));
  second.client.release(path.node);
  await second.client.asyncCall("stat", [root]);
  const later = second.backend.flush();
  release();
  store.gate = undefined;
  await Promise.all([pending, later]);
  expect((second.backend as any).detachedKeys.size).toBe(0);
});

test("recursive removal empties retained directory capabilities without destroying open file bytes", async () => {
  const { MemFS } = await import("../fs/memory");
  const memory = new MemFS();
  memory.writeFile("/dir/a", "child");
  const directory = memory.preopen("/dir");
  memory.retain(directory);
  memory.remove("/dir");
  expect(memory.readdir(directory).map((entry) => entry.name)).toEqual([".", ".."]);

  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/dir/a"], encode("child"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  const dir = await second.client.asyncCall("preopen", ["/dir"]);
  const file = await second.client.asyncCall("resolve", [dir, "a"]);
  second.client.retain(file.node);
  await second.client.asyncCall("remove", ["/dir"]);
  await second.client.asyncCall("flush");
  expect((await second.client.asyncCall("resolve", [dir, "a"])).node).toBeUndefined();
  expect(decode(await second.client.asyncCall("read", [file.node, 20, 0]))).toBe("child");
  second.client.release(file.node);
});

test("retry after a failed unlink checkpoint respects a later relink", async () => {
  const store = new Store();
  const { client, backend } = await fixture(store);
  await client.asyncCall("writeFile", ["/a"], encode("kept"));
  await client.asyncCall("flush");
  const root = await client.asyncCall("preopen", ["/"]);
  const a = await client.asyncCall("resolve", [root, "a"]);
  client.retain(a.node);
  await client.asyncCall("removePath", [a, false]);
  let release!: () => void;
  store.gate = new Promise<void>((done) => {
    release = done;
  });
  cleanup.push(release);
  const removal = backend.flush();
  const removalFailed = removal.then(
    () => undefined,
    (error) => error,
  );
  await new Promise((done) => setTimeout(done, 5));
  const b = await client.asyncCall("resolve", [root, "b"]);
  expect(await client.asyncCall("link", [{ node: a.node, name: "", parent: undefined }, b])).toBe(
    0,
  );
  const relink = backend.flush();
  const relinkFailed = relink.then(
    () => undefined,
    (error) => error,
  );
  store.fail = true;
  release();
  const failures = await Promise.all([removalFailed, relinkFailed]);
  expect(failures[0]?.message).toContain("storage failed");
  expect(failures[1]?.message).toContain("invalidated");
  store.gate = undefined;
  store.fail = false;
  await backend.flush();
  const second = await fixture(store);
  expect(decode(await second.client.asyncCall("readFile", ["/b"]))).toBe("kept");
  client.release(a.node);
});

test("dirty detached bytes survive relink and last close before durability", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/a"], encode("OLD"));
  await first.client.asyncCall("flush");
  const { client, backend } = await fixture(store);
  const root = await client.asyncCall("preopen", ["/"]);
  const a = await client.asyncCall("resolve", [root, "a"]);
  client.retain(a.node);
  await backend.prepare("read", [a.node]);
  await client.asyncCall("removePath", [a, false]);
  expect(client.write(a.node, [encode("NEW")], 0)).toBe(3);
  const b = await client.asyncCall("resolve", [root, "b"]);
  expect(await client.asyncCall("link", [{ node: a.node, name: "" }, b])).toBe(0);
  client.release(a.node);
  expect(decode(await client.asyncCall("readFile", ["/b"]))).toBe("NEW");
  await client.asyncCall("flush");
  const reloaded = await fixture(store);
  expect(decode(await reloaded.client.asyncCall("readFile", ["/b"]))).toBe("NEW");
});

for (const fail of [false, true])
  test(`cold relink restores its durable payload after deletion${fail ? " and a failed retry" : ""}`, async () => {
    const store = new Store();
    const first = await fixture(store);
    await first.client.asyncCall("writeFile", ["/a"], encode("OLD"));
    await first.client.asyncCall("flush");
    const { client, backend } = await fixture(store);
    const root = await client.asyncCall("preopen", ["/"]);
    const a = await client.asyncCall("resolve", [root, "a"]);
    client.retain(a.node);
    await client.asyncCall("removePath", [a, false]);
    await client.asyncCall("flush");
    const b = await client.asyncCall("resolve", [root, "b"]);
    expect(await client.asyncCall("link", [{ node: a.node, name: "" }, b])).toBe(0);
    if (fail) {
      store.fail = true;
      await expect(backend.flush()).rejects.toThrow("storage failed");
      store.fail = false;
    }
    await backend.flush();
    expect(() => validatePersistedIndex(store.index)).not.toThrow();
    expect(store.reads).toBe(0);
    expect(decode(await client.asyncCall("readFile", ["/b"]))).toBe("OLD");
    await client.asyncCall("writeFile", ["/b"], encode("NEW"));
    await client.asyncCall("flush");
    const revision = backend.shared.revision(a.node)!;
    expect(backend.shared.unload(a.node, revision)).toBe(true);
    expect(decode(await client.asyncCall("readFile", ["/b"]))).toBe("NEW");
    client.release(a.node);
    const reloaded = await fixture(store);
    expect(decode(await reloaded.client.asyncCall("readFile", ["/b"]))).toBe("NEW");
  });

test("a queued deletion checkpoint pins a later cold reattachment until its upsert commits", async () => {
  class CollectingStore extends Store {
    async persist(batch: any) {
      await super.persist(batch);
      const keep = new Set<string>(
        (this.index.nodes as any[])
          .flatMap((node) => (node.data ? [node.data] : []))
          .concat(batch.retainedData ?? []),
      );
      for (const key of this.payloads.keys()) if (!keep.has(key)) this.payloads.delete(key);
    }
  }
  const store = new CollectingStore();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/a"], encode("OLD"));
  await first.client.asyncCall("flush");
  const { client, backend } = await fixture(store);
  const root = await client.asyncCall("preopen", ["/"]);
  const a = await client.asyncCall("resolve", [root, "a"]);
  client.retain(a.node);
  let release!: () => void;
  store.gate = new Promise<void>((done) => {
    release = done;
  });
  cleanup.push(release);
  await client.asyncCall("writeFile", ["/unrelated"], encode("other"));
  const older = backend.flush();
  await new Promise((done) => setTimeout(done, 5));
  await client.asyncCall("removePath", [a, false]);
  const removal = backend.flush();
  const b = await client.asyncCall("resolve", [root, "b"]);
  expect(await client.asyncCall("link", [{ node: a.node, name: "" }, b])).toBe(0);
  const relink = backend.flush();
  release();
  store.gate = undefined;
  await Promise.all([older, removal, relink]);
  validatePersistedIndex(store.index);
  expect(decode(await client.asyncCall("readFile", ["/b"]))).toBe("OLD");
  client.release(a.node);
});

test("inode permission contract uses actual persistence, service and client", async () => {
  const store = new Store();
  await permissionStorageCase(async () => store);
});

test("saved metadata adoption persists defaults without payload reads or format changes", async () => {
  const store = new Store();
  store.index = {
    version: 1,
    generation: 1,
    root: 1,
    nodes: [
      { ino: 1, kind: "dir", mtime: 1, size: 0, children: [["file", 2]] },
      { ino: 2, kind: "file", mtime: 1, size: 1, data: "saved" },
    ],
  };
  store.payloads.set("saved", new Uint8Array([9]));
  const { client } = await fixture(store);
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "file"]);
  expect(await client.asyncCall("permissions", [path.node])).toEqual({
    mode: 0o600,
    modeSupported: 0o600,
    access: 6,
    accessSupported: 6,
  });
  await client.asyncCall("flush");
  expect(store.reads).toBe(0);
  expect(store.index.version).toBe(1);
  expect(store.index.nodes.find((entry: any) => entry.ino === 2)).toMatchObject({
    mode: 0o600,
    data: "saved",
  });
});

async function coldPermissionFixture(mode: number) {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/file"], encode("ABCD"));
  const firstRoot = await first.client.asyncCall("preopen", ["/"]);
  const firstPath = await first.client.asyncCall("resolve", [firstRoot, "file"]);
  expect(await first.client.asyncCall("setMode", [firstPath.node, mode])).toBe(0);
  await first.client.asyncCall("flush");
  const { client, backend } = await fixture(store);
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "file"]);
  const handle: number = path.node;
  client.retain(handle);
  cleanup.push(() => client.release(handle));
  expect(store.reads).toBe(0);
  return { store, client, backend, handle };
}

for (const pollFirst of [false, true]) {
  test(`cold read-only process read stays bounded with read rights, pollFirst=${pollFirst}`, async () => {
    const { client, store, backend, handle } = await coldPermissionFixture(0o400);
    const descriptors = new DescriptorTable();
    const supervisor = new ProcessSupervisor({
      registry: new ExecutableRegistry(),
      launch() {
        throw new Error("no process launch expected");
      },
    });
    cleanup.push(() => supervisor.dispose());
    const pid = supervisor.createRoot({ descriptors });
    const signals = supervisor.get(pid)!;
    const memory = new WebAssembly.Memory({ initial: 1 });
    const abi = new ProcessABI({
      memory,
      descriptors,
      fs: client,
      pid,
      service: supervisor,
      signals,
    });
    const fd = descriptors.open({ kind: "file", handle, offset: 0, append: false }, 2n, 0n);
    const bytes = new Uint8Array(memory.buffer, 1024, 4);
    bytes.fill(0xa5);
    if (pollFirst) expect(client.ioReadiness(handle, false).readable).toBe(false);
    else expect(abi.imports.read!(fd, 1024, 4)).toBe(-6);
    expect(bytes).toEqual(new Uint8Array(4).fill(0xa5));
    while (!client.ioReadiness(handle, false).readable) await Bun.sleep(1);
    expect(abi.imports.read!(fd, 1024, 4)).toBe(4);
    expect(decode(bytes)).toBe("ABCD");
    expect(store.reads).toBe(0);
    expect(store.ranges).toEqual([{ offset: 0, length: 4 }]);
    expect(backend.shared.isResident(handle)).toBe(false);
    expect(client.tryWrite(handle, [encode("deny")], 0)).toBe(-2);
    expect(client.resize(handle, 0, true)).toBe(2);
    expect(client.completions.size).toBe(0);
  });
}

test("cold read denial settles without loading data or retaining a request", async () => {
  const { client, store, handle } = await coldPermissionFixture(0o200);
  expect(client.permissions(handle)?.access).toBe(2);
  const denied = await client.asyncCall("readFile", ["/file"]).catch((error: unknown) => error);
  expect(denied).toMatchObject({ errno: 2 });
  expect(store.reads).toBe(0);
  expect(client.completions.size).toBe(0);
});
