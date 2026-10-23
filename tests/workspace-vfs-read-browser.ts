import {
  FilesystemClient,
  FilesystemService,
  PersistentBackend,
  IndexedDBStorage,
  OpfsStorage,
  createFilesystemConnection,
  createWorkspaceVfs,
  type StorageBackend,
  type PersistenceBatch,
} from "../fs/index.js";

const SIZE = 128 * 1024 * 1024;
const PAGE = 65536;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function batch(generation: number, key: string, bytes?: Uint8Array): PersistenceBatch {
  return {
    generation,
    root: 1,
    upserts: [
      { ino: 1, kind: "dir", size: 0, mtime: generation, children: [["file", 2]] },
      { ino: 2, kind: "file", size: bytes?.length ?? SIZE, mtime: generation, data: key },
    ],
    removes: [],
    data: new Map(bytes ? [[key, bytes]] : []),
  };
}
async function projection(storage: StorageBackend) {
  const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
  const pair = createFilesystemConnection(undefined, { workspace: true });
  const service = new FilesystemService(backend);
  let client: FilesystemClient | undefined;
  let workspace: ReturnType<typeof createWorkspaceVfs> | undefined;
  const close = async () => {
    await workspace?.close();
    client?.dispose();
    await service.drainForOwner();
    service.dispose();
    await backend.close();
    pair.client.port.close();
    pair.server.port.close();
  };
  try {
    service.connect(pair.server);
    client = new FilesystemClient(pair.client);
    workspace = createWorkspaceVfs(client);
    return { backend, client, workspace, service, close };
  } catch (error) {
    await close();
    throw error;
  }
}
interface Counters {
  buffers: number[];
  native: number[];
  keys: string[];
  whole: number;
  sync: number;
}
async function measured<T>(storage: StorageBackend, action: () => Promise<T>) {
  const counters: Counters = { buffers: [], native: [], keys: [], whole: 0, sync: 0 };
  const ArrayType = Uint8Array;
  const whole = storage.read;
  const get = IDBObjectStore.prototype.get;
  const blob = Blob.prototype.arrayBuffer;
  const sync = FileSystemFileHandle.prototype.createSyncAccessHandle;
  storage.read = (...args) => {
    counters.whole++;
    return whole.apply(storage, args);
  };
  IDBObjectStore.prototype.get = function (key) {
    const request = get.call(this, key);
    if (this.name !== "data") return request;
    counters.keys.push(JSON.stringify(key));
    request.addEventListener("success", () => {
      const result: unknown = request.result;
      if (
        result &&
        typeof result === "object" &&
        "bytes" in result &&
        result.bytes instanceof ArrayType
      )
        counters.native.push(result.bytes.buffer.byteLength);
    });
    return request;
  };
  Blob.prototype.arrayBuffer = async function () {
    const result = await blob.call(this);
    counters.native.push(result.byteLength);
    return result;
  };
  FileSystemFileHandle.prototype.createSyncAccessHandle = function () {
    counters.sync++;
    return sync.call(this);
  };
  globalThis.Uint8Array = new Proxy(ArrayType, {
    construct(target, args) {
      const value = Reflect.construct(target, args);
      counters.buffers.push(value.buffer.byteLength);
      return value;
    },
  });
  try {
    return { value: await action(), counters };
  } finally {
    globalThis.Uint8Array = ArrayType;
    storage.read = whole;
    IDBObjectStore.prototype.get = get;
    Blob.prototype.arrayBuffer = blob;
    FileSystemFileHandle.prototype.createSyncAccessHandle = sync;
  }
}
function holdCheckpoint(kind: "indexeddb" | "opfs") {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let captured = false;
  const hold = async () => {
    if (captured) return;
    captured = true;
    entered.resolve();
    await release.promise;
  };
  const digest = crypto.subtle.digest;
  const get = FileSystemDirectoryHandle.prototype.getFileHandle;
  if (kind === "indexeddb")
    crypto.subtle.digest = async function (...args) {
      await hold();
      return digest.apply(this, args);
    };
  else
    FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, options) {
      if (name.startsWith("snapshot-") && options?.create) await hold();
      return get.call(this, name, options);
    };
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    restore() {
      release.resolve();
      crypto.subtle.digest = digest;
      FileSystemDirectoryHandle.prototype.getFileHandle = get;
    },
  };
}
async function ownershipLoss(name: string, storage: IndexedDBStorage): Promise<void> {
  const view = await projection(storage);
  let replacement: IndexedDBStorage | undefined;
  let reading: ReturnType<typeof view.workspace.read> | undefined;
  const held = holdCheckpoint("indexeddb");
  try {
    const pinned = await view.workspace.pin("/file");
    check(pinned.kind === "ok", "ownership-loss lease missing");
    reading = pinned.value.read({ offset: 0, length: 1 });
    await held.entered;
    replacement = await IndexedDBStorage.open(name);
    held.release();
    const result = await reading;
    check(result.kind === "io", `stale native reader returned ${result.kind}`);
    await pinned.value.close();
    check(storage.resources().indexeddbReaderWork === 0, "stale native read debt survived close");
    check(storage.resources().readerStorageBytes === 0, "stale lease retention survived close");
    check((await replacement.load())?.nodes.find((node) => node.ino === 2)?.size === 1,
      "takeover recovered reader-only metadata");
  } finally {
    held.restore();
    await reading;
    await view.close();
    await replacement?.close();
  }
}
async function adapter(kind: "indexeddb" | "opfs") {
  const name = `waffle-public-range-${kind}-${crypto.randomUUID()}`;
  const open = () =>
    kind === "indexeddb"
      ? IndexedDBStorage.open(name, { compactEvery: 2 })
      : OpfsStorage.open(name);
  const owners: StorageBackend[] = [];
  let view: Awaited<ReturnType<typeof projection>> | undefined;
  try {
    const initial = await open();
    owners.push(initial);
    await initial.persist(batch(1, "original", new Uint8Array(SIZE).fill(65)));
    await initial.close();
    const cold = await open();
    owners.push(cold);
    view = await projection(cold);
    const live = view;
    const before = live.backend.shared.resources().usedBytes;
    const recoveryToken = cold.retainPayload("original", SIZE);
    recoveryToken.release();
    check(
      cold.resources().readerStorageBytes === 0 && cold.resources().readerStorageDebt === 0,
      "normal recovery root became reader-only debt",
    );
    const ranges = [];
    for (const offset of [65539, PAGE - 3, SIZE - 4096]) {
      const observed = await measured(cold, () =>
        live.workspace.read("/file", { offset, length: 4096 }),
      );
      const read = observed.value,
        counters = observed.counters;
      check(read.kind === "ok", `${kind} public range failed: ${read.kind}`);
      check(
        read.value.bytes.length === 4096 && read.value.bytes.every((byte) => byte === 65),
        "wrong range bytes",
      );
      check(
        counters.whole === 0 && counters.sync === 0,
        "public range hydrated or acquired sync handle",
      );
      check(
        counters.buffers.every((bytes) => bytes <= PAGE),
        `range allocated a whole payload buffer: ${JSON.stringify(counters)}`,
      );
      check(
        counters.buffers.reduce((sum, bytes) => sum + bytes, 0) < 2 * 1024 * 1024,
        "range raw allocation bound",
      );
      check(
        counters.native.every((bytes) => bytes <= PAGE),
        "native range returned a whole payload buffer",
      );
      if (kind === "opfs")
        check(counters.native.join() === "4096", "OPFS must read exactly requested bytes");
      else
        check(
          counters.keys.length === (offset % PAGE > PAGE - 4096 ? 3 : 2),
          "IDB manifest and intersecting chunks only",
        );
      check(live.backend.shared.resources().usedBytes === before, "range increased residency");
      check(live.backend.shared.registeredHandles().length === 0, "range registered cold file");
      ranges.push(counters);
    }
    const full = await measured(cold, () => live.workspace.pin("/file"));
    check(full.value.kind === "ok", `full lease failed: ${full.value.kind}`);
    const lease = full.value.value;
    check(full.counters.native.length === 0 && full.counters.whole === 0, "pin copied payload");
    check(
      full.counters.buffers.every((bytes) => bytes <= PAGE),
      "pin allocated whole payload",
    );
    for (let generation = 2; generation <= 9; generation++) {
      await live.client.asyncCall("writeFile", ["/file"], new Uint8Array([generation]));
      await live.backend.flush();
    }
    const old = await lease.read({ offset: SIZE - 3, length: 3 });
    check(
      old.kind === "ok" && old.value.bytes.join() === "65,65,65",
      "GC deleted distant leased bytes",
    );
    await lease.close();
    const resources = cold.resources();
    check(resources.readerStorageDebt === SIZE, "reader close hid deferred physical debt");
    check(resources.readerStorageMetadataBytes > 0, "reader close hid deferred key metadata");
    await live.client.asyncCall("writeFile", ["/file"], new Uint8Array([10]));
    const held = holdCheckpoint(kind);
    let pending: Promise<unknown> | undefined;
    try {
      pending = live.backend.flush();
      await held.entered;
      const racing = cold.retainPayload("original", SIZE);
      try {
        held.release();
        await pending;
        const distant = await cold.readRange("original", { offset: SIZE - 1, length: 1 });
        check(distant[0] === 65, "captured GC batch deleted newly retained key");
      } finally {
        racing.release();
      }
    } finally {
      held.restore();
      await pending;
    }
    check(cold.resources().readerStorageDebt === SIZE, "racing release hid physical debt");
    for (let generation = 11; generation <= 15; generation++) {
      await live.client.asyncCall("writeFile", ["/file"], new Uint8Array([generation]));
      await live.backend.flush();
    }
    check(
      cold.resources().readerStorageDebt === 0 && cold.resources().readerStorageBytes === 0 &&
        cold.resources().readerStorageMetadataBytes === 0,
      "native deletion did not retire reader debt",
    );
    const missing = await cold.readRange("original", { offset: SIZE - 1, length: 1 }).then(
      () => false,
      () => true,
    );
    check(missing, "original payload survived actual GC");
    check(
      (await live.workspace.read(lease.stat.id, { offset: 0, length: 1 }, lease.stat.version))
        .kind === "version-gone",
      "unretained cold version was relabelled",
    );
    await live.close();
    view = undefined;
    const reopened = await open();
    owners.push(reopened);
    const index = await reopened.load();
    check(
      index?.nodes.find((node) => node.ino === 2)?.size === 1,
      "recovery selected reader-only version",
    );
    if (reopened instanceof IndexedDBStorage) await ownershipLoss(name, reopened);
    return { kind, ranges, resources };
  } finally {
    await view?.close();
    for (const owner of owners) await owner.close();
    if (kind === "indexeddb") await removeDatabase(name);
    else
      await (
        await navigator.storage.getDirectory()
      ).removeEntry(`bun-wasm-${encoded(name)}`, { recursive: true });
  }
}
function encoded(name: string): string {
  return btoa(JSON.stringify(name)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function removeDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("public range database still owned"));
  });
}
if (
  typeof document === "undefined" &&
  typeof location !== "undefined" &&
  location.pathname === "/read-worker.js"
) {
  void (async () => {
    try {
      const results = [];
      for (const kind of ["indexeddb", "opfs"] as const) results.push(await adapter(kind));
      postMessage({ results });
    } catch (error) {
      postMessage({ failure: error instanceof Error ? error.stack : String(error) });
    } finally {
      close();
    }
  })();
}
