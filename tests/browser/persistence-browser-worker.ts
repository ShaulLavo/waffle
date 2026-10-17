import { PersistentBackend } from "../../runtime/fs/persistent";
import { IndexedDBStorage } from "../../runtime/fs/indexeddb";
import { OpfsStorage } from "../../runtime/fs/opfs";
import type { StorageBackend, PersistenceBatch } from "../../runtime/fs/storage";
import corpus from "./fixtures/persistence-corpus.json";
import { runStorageTests, storageTests } from "../../runtime/tests/storage-browser";
import { runOpfsStorageTests, opfsStorageTests } from "../../runtime/tests/opfs-storage-browser";

let backend: PersistentBackend | undefined;
let reads = 0, readBytes = 0, commits = 0, nativePayloadRequests = 0;
// Count real readonly payload operations as well as the storage adapter calls: an eager
// getAll()/cursor inside load() must not be able to masquerade as an index-only open.
for (const method of ["get", "getAll", "openCursor"] as const) {
  const original = IDBObjectStore.prototype[method];
  Object.defineProperty(IDBObjectStore.prototype, method, { value: new Proxy(original, {
    apply(target, store: IDBObjectStore, args) {
      if (store.name === "data" && store.transaction.mode === "readonly") nativePayloadRequests++;
      return Reflect.apply(target, store, args);
    },
  }) });
}
let announceCommit = false;
let storageName: "indexeddb" | "opfs" = "indexeddb";
let crashBoundary: "payload" | "snapshot" | undefined;
let activeHandles = 0, peakHandles = 0, openedHandles = 0, payloadFlushes = 0, snapshotFlushes = 0;
let nativeTimings: Record<string, { calls: number; ms: number }> = {};
let persistBatches: { generation: number; payloads: number; bytes: number; upserts: number; ms: number }[] = [];
function recordNative(label: string, start: number): void {
  const row = nativeTimings[label] ??= { calls: 0, ms: 0 }; row.calls++; row.ms += performance.now() - start;
}
function timedNative<T>(label: string, action: () => T): T {
  const start = performance.now(); try { return action(); } finally { recordNative(label, start); }
}
async function timedNativeAsync<T>(label: string, action: () => Promise<T>): Promise<T> {
  const start = performance.now(); try { return await action(); } finally { recordNative(label, start); }
}
// Observe and interrupt native OPFS calls in this test worker only. A partial native write
// happens before notification; the production adapter has no test hooks or injected delays.
function kind(name: string): "payload" | "snapshot" | undefined {
  return name.startsWith("p-") ? "payload" : name.startsWith("snapshot-") ? "snapshot" : undefined;
}
function interrupted(name: string): boolean { return announceCommit && crashBoundary === kind(name); }
function announceBoundary(name: string): void { self.postMessage({ event: "persist-started", boundary: kind(name), partialWrite: true }); }
if (typeof FileSystemFileHandle !== "undefined") {
  const prototype = FileSystemFileHandle.prototype as FileSystemFileHandle & {
    createSyncAccessHandle?: () => Promise<any>;
  };
  const getFile = prototype.getFile;
  prototype.getFile = async function () {
    const file = await getFile.call(this);
    if (kind(this.name) === "payload") {
      for (const method of ["arrayBuffer", "text", "stream"] as const) {
        const original = file[method];
        Object.defineProperty(file, method, { value() { nativePayloadRequests++; return Reflect.apply(original, file, []); } });
      }
    }
    return file;
  };
  const createSync = prototype.createSyncAccessHandle;
  if (createSync) prototype.createSyncAccessHandle = async function () {
    const name = this.name, access = await timedNativeAsync(`${kind(name)}.openSync`, () => createSync.call(this));
    activeHandles++; openedHandles++; peakHandles = Math.max(peakHandles, activeHandles);
    let closed = false;
    return {
      read(buffer: Uint8Array, options?: { at?: number }) {
        if (kind(name) === "payload") nativePayloadRequests++;
        return timedNative(`${kind(name)}.read`, () => access.read(buffer, options));
      },
      write(buffer: Uint8Array, options?: { at?: number }) {
        if (interrupted(name)) {
          access.write(buffer.subarray(0, Math.max(1, Math.floor(buffer.byteLength / 2))), options);
          announceBoundary(name);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          throw new Error("Interrupted worker unexpectedly resumed");
        }
        return timedNative(`${kind(name)}.write`, () => access.write(buffer, options));
      },
      getSize: () => access.getSize(),
      truncate: (size: number) => access.truncate(size),
      flush() {
        if (kind(name) === "payload") payloadFlushes++;
        if (kind(name) === "snapshot") snapshotFlushes++;
        return timedNative(`${kind(name)}.flush`, () => access.flush());
      },
      close() { if (!closed) { timedNative(`${kind(name)}.close`, () => access.close()); closed = true; activeHandles--; } },
    };
  };
}
if (typeof FileSystemDirectoryHandle !== "undefined") {
  const prototype = FileSystemDirectoryHandle.prototype, getFileHandle = prototype.getFileHandle, removeEntry = prototype.removeEntry;
  prototype.getFileHandle = function (name, options) {
    return timedNativeAsync(`${this.name}.getFileHandle.${options?.create ? "create" : "lookup"}`, () => getFileHandle.call(this, name, options));
  };
  prototype.removeEntry = function (name, options) {
    return timedNativeAsync(`${this.name}.removeEntry`, () => removeEntry.call(this, name, options));
  };
}
function counters() { return { reads, readBytes, nativePayloadRequests, activeHandles, peakHandles, openedHandles }; }
// Observe the real browser transaction boundary, after checksumming/serialization, rather
// than adding production test hooks or merely closing before persistence starts.
const transaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
  const result = transaction.apply(this, args);
  if (announceCommit && storageName === "indexeddb" && args[1] === "readwrite") self.postMessage({ event: "persist-started" });
  return result;
};
const empty = new Uint8Array();
const pathAt = (i: number) => `/node_modules/pkg${String(Math.floor(i / 100)).padStart(3, "0")}/lib/d${Math.floor(i / 10) % 10}/f${String(i % 10).padStart(2, "0")}.js`;
const paths = Array.from({ length: corpus.smallSizes.length }, (_, i) => pathAt(i)).concat(corpus.largeSizes.map((_, i) => `/large${i}`));
const sizes = corpus.smallSizes.concat(corpus.largeSizes);
// Reproduce the original spike's synthetic input, not any package's source bytes.
// Source: /work/reports/browser-runtime/spikes/3-opfs-fs/fs-worker.js (original local
// benchmark generator, not upstream code). Preserve its seeds and little-endian words.
function word(seed: number, index: number): number {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return (value ^ (value >>> 16)) >>> 0;
}
function seedAt(index: number): number {
  return index < corpus.smallSizes.length ? 17 + index : 10033 + index - corpus.smallSizes.length;
}
function payload(size: number, index: number): Uint8Array {
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer), seed = seedAt(index);
  let offset = 0;
  for (; offset + 4 <= size; offset += 4) view.setUint32(offset, word(seed, offset >>> 2), true);
  for (; offset < size; offset++) bytes[offset] = (word(seed, offset >>> 2) >>> ((offset % 4) * 8)) & 255;
  return bytes;
}
async function execute(operation: string, args: unknown[], bytes: Uint8Array = empty): Promise<any> {
  if (!backend) throw new Error("Open a persistent backend first");
  await backend.prepare(operation, args);
  return backend.execute(operation, args, bytes);
}
async function write(path: string, bytes: Uint8Array): Promise<void> { await execute("writeFile", [path, false], bytes); }
function valid(bytes: Uint8Array, index: number, size: number): boolean {
  if (bytes.length !== size) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), seed = seedAt(index);
  let offset = 0;
  for (; offset + 4 <= size; offset += 4) if (view.getUint32(offset, true) !== word(seed, offset >>> 2)) return false;
  for (; offset < size; offset++) if (bytes[offset] !== ((word(seed, offset >>> 2) >>> ((offset % 4) * 8)) & 255)) return false;
  return true;
}
async function snapshotInterrupted() {
  const files: string[] = (await execute("listFiles", ["/"])).sort();
  const metadata = await Promise.all(files.map(async path => ({ path, ...await execute("lookup", [path]) })));
  const oldShape = JSON.stringify(files) === JSON.stringify(["/old-only", "/victim"]);
  const newShape = JSON.stringify(files) === JSON.stringify(["/new-only", "/renamed"]);
  if (!oldShape && !newShape) return { state: "partial", files, metadata };
  const bytes: Uint8Array = await execute("readFile", [oldShape ? "/victim" : "/renamed"]);
  const sentinel: Uint8Array = await execute("readFile", [oldShape ? "/old-only" : "/new-only"]);
  const wanted = oldShape ? 17 : 34, size = oldShape ? 1024 * 1024 : 8 * 1024 * 1024;
  return { state: bytes.length === size && bytes.every(byte => byte === wanted) && sentinel.length === 3 && sentinel.every(byte => byte === wanted) ? oldShape ? "old" : "new" : "partial", files, size: bytes.length, metadata };
}
const commands: Record<string, (args: any) => Promise<unknown>> = {
  async storageTestNames({ storage = "indexeddb", filter }: { storage?: "indexeddb" | "opfs"; filter?: string } = {}) {
    const registered = storage === "opfs" ? opfsStorageTests() : storageTests();
    return registered.filter(test => !filter || test.label.includes(filter)).map(test => test.label);
  },
  async storageTests({ storage = "indexeddb", filter }: { storage?: "indexeddb" | "opfs"; filter?: string } = {}) {
    return storage === "opfs" ? runOpfsStorageTests(filter) : runStorageTests(filter);
  },
  async deleteDatabase({ name, storage }: { name: string; storage: "indexeddb" | "opfs" }) {
    if (storage === "opfs") await OpfsStorage.delete(name);
    else await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`Cleanup blocked for ${name}`));
    });
  },
  async open({ name, storage: backendName = "indexeddb" }: { name: string; storage?: "indexeddb" | "opfs" }) {
    if (backend) await backend.close();
    reads = 0; readBytes = 0; commits = 0; nativePayloadRequests = 0; announceCommit = false; crashBoundary = undefined;
    storageName = backendName; peakHandles = activeHandles; openedHandles = 0; payloadFlushes = 0; snapshotFlushes = 0; nativeTimings = {}; persistBatches = [];
    const start = performance.now();
    const storage = backendName === "opfs" ? await OpfsStorage.open(name) : await IndexedDBStorage.open(name);
    const observed: StorageBackend = {
      load: () => storage.load(),
      async read(key: string) { reads++; const bytes = await storage.read(key); readBytes += bytes.length; return bytes; },
      async persist(batch: PersistenceBatch) {
        commits++;
        const start = performance.now();
        await storage.persist(batch);
        persistBatches.push({ generation: batch.generation, payloads: batch.data.size, bytes: Array.from(batch.data.values()).reduce((sum, bytes) => sum + bytes.length, 0), upserts: batch.upserts.length, ms: performance.now() - start });
      },
      flush: keys => storage.flush(keys),
      close: () => storage.close(),
    };
    backend = await PersistentBackend.open(observed, { intervalMs: 0 });
    return { ms: performance.now() - start, ...counters() };
  },
  async close() { if (backend) await backend.close(); backend = undefined; },
  async seedInterrupted() {
    await write("/victim", new Uint8Array(1024 * 1024).fill(17));
    await write("/old-only", new Uint8Array(3).fill(17));
    await backend!.flush();
    return snapshotInterrupted();
  },
  async interruptCommit(boundary?: "payload" | "snapshot") {
    crashBoundary = boundary;
    await write("/victim", new Uint8Array(8 * 1024 * 1024).fill(34));
    const error = await execute("move", ["/victim", "/renamed"]);
    if (error) throw new Error(`rename failed: ${error}`);
    await execute("remove", ["/old-only"]);
    await write("/new-only", new Uint8Array(3).fill(34));
    announceCommit = true;
    await backend!.flush();
  },
  inspectInterrupted: snapshotInterrupted,
  async createCorpus() {
    const start = performance.now();
    let bytes = 0, payloadPrepareMs = 0, checkpointMs = 0;
    for (let i = 0; i < paths.length; i++) {
      const prepare = performance.now(), data = payload(sizes[i]!, i);
      payloadPrepareMs += performance.now() - prepare;
      await write(paths[i]!, data); bytes += data.length;
      if ((i + 1) % 256 === 0) {
        const checkpoint = performance.now(); await backend!.checkpoint(); checkpointMs += performance.now() - checkpoint;
      }
      if ((i + 1) % 1000 === 0) self.postMessage({ event: "progress", value: `created ${i + 1}/${paths.length}` });
    }
    const final = performance.now(); await backend!.checkpoint();
    const finalCheckpointMs = performance.now() - final, persistMs = performance.now() - start;
    const persistPayloadFlushes = payloadFlushes, persistSnapshotFlushes = snapshotFlushes;
    const durablePath = paths[sizes.findIndex(size => size > 0)]!, durableStart = performance.now();
    await backend!.flush(durablePath);
    const durableFileFlushMs = performance.now() - durableStart;
    return { files: paths.length, bytes, persistMs, persistMethod: "background close-only checkpoint; payload fsync excluded", persistPayloadFlushes, persistSnapshotFlushes, finalCheckpointMs, checkpointMs: checkpointMs + finalCheckpointMs,
      durableFile: { path: durablePath, bytes: sizes[paths.indexOf(durablePath)], flushMs: durableFileFlushMs, nativePayloadFlushes: payloadFlushes - persistPayloadFlushes, nativeSnapshotFlushes: snapshotFlushes - persistSnapshotFlushes, method: "explicit backend.flush(file path), measured separately after checkpoints" },
      payloadPrepareMs, commits, persistBatches, nativeTimings, nativeTimingMethod: "native method wall duration sums; parallel async waits overlap and are not additive critical-path time", batchFiles: 256, sourceArtifactSha256: corpus.sourceArtifactSha256, ...counters(), resources: backend!.resources() };
  },
  async rawCorpus() {
    // A same-host lower bound, not another storage adapter. Same graph and synthetic bytes,
    // 32 create/write/close workers and one final minimal path/size metadata snapshot.
    // No runtime memory pages, immutable-key bookkeeping, checksums or per-256 snapshots.
    if (backend) await backend.close(); backend = undefined;
    if (activeHandles !== 0) throw new Error(`Native handle leak before raw comparator: ${activeHandles}`);
    const root = await navigator.storage.getDirectory(), name = `bun-wasm-raw-${crypto.randomUUID()}`;
    const directory = await root.getDirectoryHandle(name, { create: true });
    const data = await directory.getDirectoryHandle("data", { create: true });
    nativeTimings = {}; peakHandles = 0; openedHandles = 0; payloadFlushes = 0; snapshotFlushes = 0;
    let result: Record<string, unknown>;
    try {
      const start = performance.now();
      let next = 0, bytes = 0, payloadPrepareMs = 0;
      const concurrency = 32;
      const outcomes = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
        while (next < paths.length) {
          const index = next++, prepare = performance.now(), content = payload(sizes[index]!, index);
          payloadPrepareMs += performance.now() - prepare; bytes += content.length;
          const file = await data.getFileHandle(`p-${index}`, { create: true });
          const access = await (file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<any> }).createSyncAccessHandle();
          try {
            for (let offset = 0; offset < content.length; ) {
              const count = access.write(content.subarray(offset), { at: offset });
              if (!(count > 0)) throw new Error("Raw comparator payload write made no progress");
              offset += count;
            }
          } finally { access.close(); }
        }
      }));
      const failed = outcomes.find(outcome => outcome.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      const payloadPhaseMs = performance.now() - start, snapshotStart = performance.now();
      const directories = new Set<string>(["/"]);
      for (const path of paths) {
        const parts = path.split("/");
        for (let end = 2; end < parts.length; end++) directories.add(parts.slice(0, end).join("/"));
      }
      const manifest = new TextEncoder().encode(JSON.stringify({ directories: Array.from(directories),
        files: paths.map((path, index) => ({ path, size: sizes[index], payload: `p-${index}` })) }));
      const file = await directory.getFileHandle("snapshot-raw.json", { create: true });
      const access = await (file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<any> }).createSyncAccessHandle();
      try {
        for (let offset = 0; offset < manifest.length; ) {
          const count = access.write(manifest.subarray(offset), { at: offset });
          if (!(count > 0)) throw new Error("Raw comparator snapshot write made no progress");
          offset += count;
        }
        access.flush();
      } finally { access.close(); }
      result = { files: paths.length, bytes, persistMs: performance.now() - start, payloadPhaseMs,
        snapshotMs: performance.now() - snapshotStart, snapshotBytes: manifest.length, directories: directories.size,
        payloadPrepareMs, concurrency, snapshots: 1, payloadFlushes, snapshotFlushes, peakHandles, openedHandles,
        sourceArtifactSha256: corpus.sourceArtifactSha256, nativeTimings: structuredClone(nativeTimings),
        method: "same 10,003-file graph and deterministic bytes; 32 native create/write/close workers, one final path/size/directory snapshot+flush; no adapter/runtime/checksum/GC; no payload fsync" };
    } finally { await root.removeEntry(name, { recursive: true }); }
    return { ...result, cleanup: { workspaceDeleted: true, activeHandles } };
  },
  async metadataCorpus() {
    const start = performance.now();
    const files: string[] = await execute("listFiles", ["/"]);
    const expected = new Map(paths.map((path, i) => [path, sizes[i]]));
    for (const path of files) {
      const entry = await execute("lookup", [path]);
      if (entry?.kind !== "file") throw new Error(`missing metadata ${path}`);
      const node = backend!.fs.lookup(path)!;
      const stat = await execute("stat", [backend!.fs.handleForNode(node)]);
      if (stat.size !== expected.get(path)) throw new Error(`wrong cold file size ${path}`);
    }
    return { ms: performance.now() - start, files: files.length, ...counters(), resources: backend!.resources() };
  },
  async firstData() {
    const index = sizes.findIndex(size => size > 0), start = performance.now();
    const bytes = await execute("readFile", [paths[index]!]);
    if (!valid(bytes, index, sizes[index]!)) throw new Error("first payload integrity failure");
    return { ms: performance.now() - start, path: paths[index], bytes: bytes.length, ...counters() };
  },
  async cacheChurn() {
    const count = 1_200, before = reads, openedBefore = openedHandles;
    for (let index = 0; index < count; index++) {
      const data = await execute("readFile", [paths[index]!]);
      if (!valid(data, index, sizes[index]!)) throw new Error(`cache churn integrity ${index}`);
    }
    const first = await execute("readFile", [paths[0]!]);
    if (!valid(first, 0, sizes[0]!)) throw new Error("cache revisit integrity");
    return { distinctFiles: count, additionalReads: reads - before, additionalOpenedHandles: openedHandles - openedBefore, revisitedFirst: true, ...counters(), resources: backend!.resources() };
  },
  async readCorpus() {
    const start = performance.now();
    let bytes = 0, bad = 0;
    for (let i = 0; i < paths.length; i++) {
      const data = await execute("readFile", [paths[i]!]);
      bytes += data.length;
      if (!valid(data, i, sizes[i]!)) bad++;
      if ((i + 1) % 1000 === 0) self.postMessage({ event: "progress", value: `read ${i + 1}/${paths.length}` });
    }
    return { ms: performance.now() - start, bytes, files: paths.length, bad, fullByteValidation: true, ...counters(), resources: backend!.resources() };
  },
};
self.onmessage = async ({ data }) => {
  try {
    const operation = commands[data.command];
    if (!operation) throw new Error(`Unknown persistence test command ${data.command}`);
    self.postMessage({ id: data.id, value: await operation(data.args) });
  } catch (error) { self.postMessage({ id: data.id, error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) }); }
};
