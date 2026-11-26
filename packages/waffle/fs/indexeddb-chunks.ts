import { VfsError } from "./vfs.js";
import { validInteger } from "./storage.js";

export const CHUNK_SIZE = 64 * 1024;
export interface ChunkManifest {
  version: 2;
  size: number;
  chunkSize: typeof CHUNK_SIZE;
  count: number;
}
export interface ChunkRecord {
  bytes: Uint8Array<ArrayBuffer>;
  checksum: string;
}
export interface PreparedPayload {
  manifest: ChunkManifest;
  chunks: ChunkRecord[];
}
export interface IndexedDBRange {
  offset: number;
  length: number;
  signal?: AbortSignal;
}
export function chunkError(key: string): never {
  throw new VfsError(
    "INVALID_VFS_FORMAT",
    "indexeddb",
    `Invalid filesystem payload chunks: ${key}`,
  );
}
export function parseManifest(value: unknown, key: string): ChunkManifest {
  if (!value || typeof value !== "object") chunkError(key);
  if (
    !("version" in value) ||
    value.version !== 2 ||
    !("size" in value) ||
    !validInteger(value.size)
  )
    chunkError(key);
  if (
    !("chunkSize" in value) ||
    value.chunkSize !== CHUNK_SIZE ||
    !("count" in value) ||
    value.count !== Math.ceil(value.size / CHUNK_SIZE)
  )
    chunkError(key);
  return { version: 2, size: value.size, chunkSize: CHUNK_SIZE, count: value.count };
}
export function parseChunk(value: unknown, size: number, key: string): ChunkRecord {
  if (
    !value ||
    typeof value !== "object" ||
    !("bytes" in value) ||
    !(value.bytes instanceof Uint8Array) ||
    !(value.bytes.buffer instanceof ArrayBuffer)
  )
    chunkError(key);
  if (
    value.bytes.length !== size ||
    !("checksum" in value) ||
    typeof value.checksum !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.checksum)
  )
    chunkError(key);
  return { bytes: value.bytes as Uint8Array<ArrayBuffer>, checksum: value.checksum };
}
export function chunkLength(manifest: ChunkManifest, index: number): number {
  return Math.min(CHUNK_SIZE, manifest.size - index * CHUNK_SIZE);
}
const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));
const PREPARE_CONCURRENCY = 32;

export async function chunkChecksum(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (let i = 0; i < digest.length; i++) hex += HEX[digest[i]!]!;
  return hex;
}
async function prepareOwnedPayload(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<PreparedPayload> {
  if (!bytes.length) {
    signal?.throwIfAborted();
    return {
      manifest: { version: 2, size: 0, chunkSize: CHUNK_SIZE, count: 0 },
      chunks: [],
    };
  }
  const count = Math.ceil(bytes.length / CHUNK_SIZE);
  const chunks = Array.from<ChunkRecord>({ length: count });
  let next = 0;
  const workers = Math.min(PREPARE_CONCURRENCY, count);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < count) {
        signal?.throwIfAborted();
        const index = next++;
        const offset = index * CHUNK_SIZE;
        const part = bytes.slice(offset, offset + CHUNK_SIZE);
        chunks[index] = { bytes: part, checksum: await chunkChecksum(part) };
      }
    }),
  );
  signal?.throwIfAborted();
  return {
    manifest: { version: 2, size: bytes.length, chunkSize: CHUNK_SIZE, count },
    chunks,
  };
}
export function preparePayload(bytes: Uint8Array, signal?: AbortSignal): Promise<PreparedPayload> {
  return prepareOwnedPayload(bytes, signal);
}
export function validateRange(range: IndexedDBRange): void {
  if (
    !validInteger(range.offset) ||
    !validInteger(range.length) ||
    !Number.isSafeInteger(range.offset + range.length)
  )
    throw new RangeError("Invalid filesystem byte range");
  range.signal?.throwIfAborted();
}
export function deletePayload(store: IDBObjectStore, key: string): void {
  store.delete(key);
  store.delete(IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]));
}
export function putPayload(store: IDBObjectStore, key: string, payload: PreparedPayload): void {
  for (const [index, chunk] of payload.chunks.entries()) store.put(chunk, [key, index]);
  store.put(payload.manifest, key);
}
/** Scheduling stays inside the publishing transaction; no digest or task awaits here. */
export function checkPayload(
  store: IDBObjectStore,
  key: string,
  value: unknown,
  supplied: PreparedPayload | undefined,
  size: number | undefined,
  finish: () => void,
  abort: (error: unknown) => void,
): void {
  if (value === undefined) {
    if (!supplied) throw new Error(`Missing filesystem payload: ${key}`);
    if (size !== undefined && supplied.manifest.size !== size)
      throw new Error(`Invalid filesystem payload size: ${key}`);
    putPayload(store, key, supplied);
    finish();
    return;
  }
  const manifest = parseManifest(value, key);
  if (size !== undefined && manifest.size !== size)
    throw new Error(`Invalid filesystem payload size: ${key}`);
  if (!supplied) {
    finish();
    return;
  }
  if (manifest.size !== supplied.manifest.size)
    throw new Error(`Cannot overwrite immutable filesystem payload: ${key}`);
  let remaining = manifest.count;
  if (!remaining) {
    finish();
    return;
  }
  const checked = () => {
    if (--remaining === 0) finish();
  };
  for (const [index, chunk] of supplied.chunks.entries()) {
    const get = store.get([key, index]);
    get.onsuccess = () => compareChunk(get.result, chunk, key, checked, abort);
  }
}
function compareChunk(
  value: unknown,
  chunk: ChunkRecord,
  key: string,
  finish: () => void,
  abort: (error: unknown) => void,
): void {
  try {
    const existing = parseChunk(value, chunk.bytes.length, key);
    if (
      existing.checksum !== chunk.checksum ||
      existing.bytes.some((byte, i) => byte !== chunk.bytes[i])
    )
      throw new Error(`Cannot overwrite immutable filesystem payload: ${key}`);
    finish();
  } catch (error) {
    abort(error);
  }
}

export async function preparePayloads(
  data: ReadonlyMap<string, Uint8Array>,
  owned = false,
  checkAbort?: () => void,
): Promise<Map<string, PreparedPayload>> {
  const prepared = new Map<string, PreparedPayload>();
  checkAbort?.();
  if (!data.size) return prepared;
  const tasks: {
    chunks: ChunkRecord[];
    index: number;
    bytes: Uint8Array;
    offset: number;
    direct: boolean;
  }[] = [];
  for (const [key, bytes] of data) {
    if (!bytes.length) {
      prepared.set(key, {
        manifest: { version: 2, size: 0, chunkSize: CHUNK_SIZE, count: 0 },
        chunks: [],
      });
      continue;
    }
    const count = Math.ceil(bytes.length / CHUNK_SIZE);
    const chunks = Array.from<ChunkRecord>({ length: count });
    prepared.set(key, {
      manifest: { version: 2, size: bytes.length, chunkSize: CHUNK_SIZE, count },
      chunks,
    });
    const direct =
      owned &&
      count === 1 &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength &&
      bytes.buffer instanceof ArrayBuffer;
    for (let index = 0; index < count; index++)
      tasks.push({ chunks, index, bytes, offset: index * CHUNK_SIZE, direct });
  }
  if (!tasks.length) return prepared;
  let next = 0;
  let failed = false;
  let failure: unknown;
  const fail = (error: unknown) => {
    if (!failed) {
      failed = true;
      failure = error;
    }
  };
  const workers = Math.min(PREPARE_CONCURRENCY, tasks.length);
  await Promise.allSettled(
    Array.from({ length: workers }, async () => {
      while (!failed && next < tasks.length) {
        try {
          checkAbort?.();
        } catch (error) {
          fail(error);
          return;
        }
        const task = tasks[next++]!;
        const part = task.direct
          ? (task.bytes as Uint8Array<ArrayBuffer>)
          : task.bytes.slice(task.offset, task.offset + CHUNK_SIZE);
        try {
          const checksum = await chunkChecksum(part);
          task.chunks[task.index] = { bytes: part, checksum };
        } catch (error) {
          fail(error);
          return;
        }
      }
    }),
  );
  if (failed) throw failure;
  checkAbort?.();
  return prepared;
}
export function copyLegacyChunks(
  data: IDBObjectStore,
  key: string,
  prepared: PreparedPayload,
): void {
  data.delete(IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]));
  for (const [index, chunk] of prepared.chunks.entries()) data.put(chunk, [key, index]);
}
