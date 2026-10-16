import { PersistentBackend } from "../../runtime/fs/persistent";
import { IndexedDBStorage } from "../../runtime/fs/indexeddb";
import type { StorageBackend, PersistenceBatch } from "../../runtime/fs/storage";
import corpus from "./fixtures/persistence-corpus.json";
import { runStorageTests } from "../../runtime/tests/storage-browser";

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
// Observe the real browser transaction boundary, after checksumming/serialization, rather
// than adding production test hooks or merely closing before persistence starts.
const transaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
  const result = transaction.apply(this, args);
  if (announceCommit && args[1] === "readwrite") self.postMessage({ event: "persist-started" });
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
  storageTests: runStorageTests,
  async open({ name }: { name: string }) {
    if (backend) await backend.close();
    reads = 0; readBytes = 0; commits = 0; nativePayloadRequests = 0; announceCommit = false;
    const start = performance.now();
    const storage = await IndexedDBStorage.open(name);
    const observed: StorageBackend = {
      load: () => storage.load(),
      async read(key: string) { reads++; const bytes = await storage.read(key); readBytes += bytes.length; return bytes; },
      async persist(batch: PersistenceBatch) {
        commits++;
        await storage.persist(batch);
      },
      flush: () => storage.flush(),
      close: () => storage.close(),
    };
    backend = await PersistentBackend.open(observed, { intervalMs: 0 });
    return { ms: performance.now() - start, reads, readBytes, nativePayloadRequests };
  },
  async close() { if (backend) await backend.close(); backend = undefined; },
  async seedInterrupted() {
    await write("/victim", new Uint8Array(1024 * 1024).fill(17));
    await write("/old-only", new Uint8Array(3).fill(17));
    await backend!.flush();
    return snapshotInterrupted();
  },
  async interruptCommit() {
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
        const checkpoint = performance.now(); await backend!.flush(); checkpointMs += performance.now() - checkpoint;
      }
      if ((i + 1) % 1000 === 0) self.postMessage({ event: "progress", value: `created ${i + 1}/${paths.length}` });
    }
    const final = performance.now(); await backend!.flush();
    const finalFlushMs = performance.now() - final;
    return { files: paths.length, bytes, persistMs: performance.now() - start, finalFlushMs, checkpointMs: checkpointMs + finalFlushMs, payloadPrepareMs, commits, batchFiles: 256, sourceArtifactSha256: corpus.sourceArtifactSha256, resources: backend!.resources() };
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
    return { ms: performance.now() - start, files: files.length, reads, readBytes, nativePayloadRequests, resources: backend!.resources() };
  },
  async firstData() {
    const index = sizes.findIndex(size => size > 0), start = performance.now();
    const bytes = await execute("readFile", [paths[index]!]);
    if (!valid(bytes, index, sizes[index]!)) throw new Error("first payload integrity failure");
    return { ms: performance.now() - start, path: paths[index], bytes: bytes.length, reads, readBytes, nativePayloadRequests };
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
    return { ms: performance.now() - start, bytes, files: paths.length, bad, fullByteValidation: true, reads, readBytes, nativePayloadRequests, resources: backend!.resources() };
  },
};
self.onmessage = async ({ data }) => {
  try {
    const operation = commands[data.command];
    if (!operation) throw new Error(`Unknown persistence test command ${data.command}`);
    self.postMessage({ id: data.id, value: await operation(data.args) });
  } catch (error) { self.postMessage({ id: data.id, error: error instanceof Error ? error.stack : String(error) }); }
};
