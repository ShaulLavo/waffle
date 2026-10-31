import { expect, spyOn, test } from "bun:test";
import { openFilesystemBackend } from "../browser/filesystem-backend.js";
import { MemoryBackend } from "../fs/backend.js";
import { MemFS } from "../fs/memory.js";
import { createFilesystemIdentity } from "../fs/protocol.js";
import { PersistentBackend } from "../fs/persistent.js";
import { MetadataStore } from "./fixtures/metadata-enumeration-r173-store.js";
import { SharedFilesystemState } from "../fs/shared.js";
import {
  PipePublicationRegistry,
  PipeController,
  attachPipePublicationRegistry,
} from "../proc/pipes.js";
import { sharedArrayBufferMaxByteLength } from "../proc/intrinsics.js";

const lifecycle = {
  onOwnershipLost() {
    throw new Error("unexpected ownership loss");
  },
  retainStorage() {
    throw new Error("memory mode opened persistent storage");
  },
};

test("filesystem worker backend imports its connection root without a provisional root", async () => {
  const connection = createFilesystemIdentity(undefined, undefined, { workspace: true });
  const allocation = spyOn(SharedFilesystemState, "createBuffer");
  try {
    const backend = await openFilesystemBackend({ mode: "memory", connect: connection }, lifecycle);
    expect(allocation).toHaveBeenCalledTimes(0);
    expect(backend.shared.buffer === connection.shared).toBe(true);
    expect(backend.shared.publication).toBeUndefined();
    expect(() =>
      backend.attachShared(
        SharedFilesystemState.createBuffer(),
        connection.maxBytes,
        connection.segments,
        connection.publication?.buffers,
      ),
    ).toThrow("filesystem service cannot attach a second shared tree");
    backend.attachShared(
      structuredClone(connection.shared),
      connection.maxBytes,
      connection.segments,
      connection.publication?.buffers,
    );
    expect(backend.shared.publication?.buffers).toBe(connection.publication?.buffers);
    const attached = backend.shared;
    backend.attachShared(
      connection.shared,
      connection.maxBytes,
      connection.segments,
      connection.publication?.buffers,
    );
    expect(backend.shared).toBe(attached);
    expect(() =>
      backend.attachShared(
        SharedFilesystemState.createBuffer(),
        connection.maxBytes,
        connection.segments,
        connection.publication?.buffers,
      ),
    ).toThrow("filesystem service cannot attach a second shared tree");
  } finally {
    allocation.mockRestore();
  }
});

test("seeded memory backend keeps its identities and bytes on an imported root", () => {
  const connection = createFilesystemIdentity();
  const fs = new MemFS();
  fs.writeFile("/seed", new Uint8Array([65, 66]));
  const backend = new MemoryBackend(fs, undefined, undefined, undefined, connection);
  expect(backend.shared.buffer === connection.shared).toBe(true);
  const node = fs.lookup("/seed");
  if (!node) throw new Error("missing seed");
  const identity = node.identity;
  if (!identity) throw new Error("seed identity was not assigned");
  const handle = fs.handleForNode(node);
  expect(backend.execute("readFile", ["/seed"], new Uint8Array())).toEqual(
    new Uint8Array([65, 66]),
  );
  expect(backend.identity(handle)).toEqual(identity);
  expect(backend.fs.root.identity?.id).not.toBe(identity?.id);
});

test("default pipe registry declares 16 MiB of permanent cursors with unchanged initial backing", () => {
  const registry = new PipePublicationRegistry();
  expect(registry.handle().buffer.byteLength).toBe(2105360);
  expect(sharedArrayBufferMaxByteLength(registry.handle().buffer)).toBe(16785424);
});

test("persistent recovery imports the root without replacing durable identities or payloads", async () => {
  const storage = new MetadataStore();
  const connection = createFilesystemIdentity();
  const allocation = spyOn(SharedFilesystemState, "createBuffer");
  let backend: PersistentBackend | undefined;
  try {
    backend = await PersistentBackend.open(storage, { intervalMs: 0, sharedRoot: connection });
    expect(allocation).toHaveBeenCalledTimes(0);
    expect(backend.shared.buffer === connection.shared).toBe(true);
    backend.execute("writeFile", ["/saved"], new Uint8Array([65, 66]));
    const original = backend.fs.lookup("/saved")?.identity;
    await backend.close();
    backend = undefined;
    const reopened = createFilesystemIdentity();
    backend = await PersistentBackend.open(storage, { intervalMs: 0, sharedRoot: reopened });
    expect(allocation).toHaveBeenCalledTimes(0);
    expect(backend.shared.buffer === reopened.shared).toBe(true);
    expect(backend.fs.lookup("/saved")?.identity).toEqual(original);
    await backend.prepare("readFile", ["/saved"]);
    expect(backend.execute("readFile", ["/saved"], new Uint8Array())).toEqual(
      new Uint8Array([65, 66]),
    );
  } finally {
    allocation.mockRestore();
    await backend?.close();
  }
});

test("pipe registry keeps explicit maxCells and never aliases collected cursors", () => {
  const registry = new PipePublicationRegistry({
    processCapacity: 2,
    cellsPerProcess: 128,
    maxCells: 3,
  });
  const clone = attachPipePublicationRegistry(structuredClone(registry.handle()));
  expect(registry.handle().buffer.byteLength).toBe(80);
  expect(sharedArrayBufferMaxByteLength(registry.handle().buffer)).toBe(80);
  registry.registerProcess(1);
  const old = clone.canonical(clone.allocate(1));
  registry.collectProcess(1);
  registry.registerProcess(2);
  const fresh = registry.canonical(registry.allocate(2));
  Atomics.store(fresh, 0, 99n);
  clone.allocate(2);
  expect(() => registry.allocate(2)).toThrow("pipe cursor registry limit reached");
  expect(registry.handle().buffer.byteLength).toBe(80);
  expect(Atomics.load(old, 0) & (1n << 32n)).toBe(1n << 32n);
  expect(Atomics.load(fresh, 0)).toBe(99n);
  registry.collectProcess(2);
});

test("persistent identity migration finishes before publication attaches to the imported root", async () => {
  const storage = new MetadataStore();
  await storage.persist({
    generation: 1,
    root: 1,
    upserts: [{ ino: 1, kind: "dir", mtime: 0, mode: 0o700, size: 0, children: [] }],
    removes: [],
    data: new Map(),
  });
  const connection = createFilesystemIdentity(undefined, undefined, { workspace: true });
  const backend = await PersistentBackend.open(storage, { intervalMs: 0, sharedRoot: connection });
  try {
    expect(backend.shared.publication).toBeUndefined();
    expect((await storage.load())?.nodes[0]?.identity).toBeDefined();
    backend.attachShared(
      connection.shared,
      connection.maxBytes,
      connection.segments,
      connection.publication?.buffers,
    );
    expect(backend.shared.publication?.buffers).toBe(connection.publication?.buffers);
    backend.execute("writeFile", ["/after-migration"], new Uint8Array([65]));
    await backend.flush();
    expect((await storage.load())?.nodes.some((node) => node.kind === "file")).toBe(true);
  } finally {
    await backend.close();
  }
});

test("explicit large pipe capacity remains available and one reader/writer pair uses four cells", () => {
  const registry = new PipePublicationRegistry({ maxCells: 1 << 24 });
  expect(sharedArrayBufferMaxByteLength(registry.handle().buffer)).toBe(268443664);
  registry.registerProcess(1);
  const controller = new PipeController({
    registry,
    maxReaders: 1,
    maxWriters: 1,
    relay: "manual",
  });
  try {
    const reader = controller.retain(1, "read");
    const writer = controller.retain(1, "write");
    expect(Atomics.load(new Int32Array(registry.handle().buffer, 0, 1), 0)).toBe(4);
    reader.close();
    writer.close();
  } finally {
    controller.dispose();
    registry.collectProcess(1);
  }
});

test("actual filesystem worker allocates no new MiB-sized backing before its first connection is ready", async () => {
  const { createFilesystemConnection, FilesystemClient } = await import("../fs/index.js");
  const connection = createFilesystemConnection();
  const client = new FilesystemClient(connection.client);
  const worker = new Worker(
    new URL("./fixtures/reservation-waste-worker.ts", import.meta.url).href,
  );
  type Observation = {
    loaded?: boolean;
    message?: { type: string; status?: string };
    allocations?: number[];
  };
  const loaded = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<Observation>();
  void ready.promise.catch(() => {});
  worker.onmessage = ({ data }: MessageEvent<Observation>) => {
    if (data.loaded) loaded.resolve();
    if (data.message?.type === "filesystem-state" && data.message.status === "ready")
      ready.resolve(data);
  };
  worker.onerror = (event) => {
    loaded.reject(new Error(event.message));
    ready.reject(new Error(event.message));
  };
  try {
    await loaded.promise;
    worker.postMessage({ mode: "memory", connect: connection.server }, [connection.server.port]);
    const observation = await ready.promise;
    expect(observation.allocations).toBeDefined();
    expect(observation.allocations?.filter((bytes) => bytes >= 1024 * 1024)).toEqual([]);
    expect(observation.allocations).toEqual([]);
    await client.asyncCall("writeFile", ["/real-worker"], new Uint8Array([65, 66]));
    expect(await client.asyncCall("readFile", ["/real-worker"])).toEqual(new Uint8Array([65, 66]));
  } finally {
    client.dispose();
    connection.server.port.close();
    await worker.terminate();
  }
});

test("standalone memory backends still own their original fixed root", () => {
  const backend = new MemoryBackend();
  expect(backend.shared.buffer.byteLength).toBe(62341840);
  backend.execute("writeFile", ["/standalone"], new Uint8Array([65]));
  expect(backend.execute("readFile", ["/standalone"], new Uint8Array())).toEqual(
    new Uint8Array([65]),
  );
});
