import { OpfsStorage } from "../fs/opfs.js";
import { encodeSnapshot, type PersistedIndex } from "../fs/storage.js";
import { OPFS_FORMAT } from "../fs/vfs-format.js";

const size = 128 * 1024 * 1024;
const offset = 65539;
const encode = (value: string) =>
  btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const byteAt = (position: number) => (position * 17 + 3) & 255;

type NativeAccess = {
  getSize(): number;
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
};
type NativeFile = FileSystemFileHandle & { createSyncAccessHandle(): Promise<NativeAccess> };
function hasSyncAccess(file: FileSystemFileHandle): file is NativeFile {
  return "createSyncAccessHandle" in file && typeof file.createSyncAccessHandle === "function";
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function writeMetadata(directory: FileSystemDirectoryHandle) {
  const index: PersistedIndex = {
    version: 1,
    generation: 1,
    root: 1,
    nodes: [
      { ino: 1, kind: "dir", size: 0, mtime: 1, children: [["large", 2]] },
      { ino: 2, kind: "file", size, mtime: 1, data: "revision" },
    ],
  };
  await directory.getFileHandle(`format-${OPFS_FORMAT}`, { create: true });
  const handle = await directory.getFileHandle("snapshot-1.json", { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(JSON.stringify(await encodeSnapshot(index)));
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}
async function seed(root: FileSystemDirectoryHandle, name: string) {
  const directory = await root.getDirectoryHandle(`bun-wasm-${encode(name)}`, { create: true });
  const data = await directory.getDirectoryHandle("data", { create: true });
  const file = await data.getFileHandle(`p-${encode("revision")}`, { create: true });
  assert(hasSyncAccess(file), "Native sync access requires a dedicated worker");
  const access = await file.createSyncAccessHandle();
  try {
    access.truncate(size);
    const block = Uint8Array.from({ length: 4096 }, (_, i) => byteAt(offset + i));
    assert(access.write(block, { at: offset }) === block.length, "Seed short write");
    const end = Uint8Array.from({ length: 3 }, (_, i) => byteAt(size - 3 + i));
    assert(access.write(end, { at: size - 3 }) === 3, "Seed EOF short write");
    access.flush();
  } finally {
    access.close();
  }
  await writeMetadata(await directory.getDirectoryHandle("metadata", { create: true }));
}

interface NativeCounts {
  nativeBytes: number;
  nativeCalls: number;
  allocations: number[];
  targetBuffers: Set<ArrayBufferLike>;
  offsets: number[];
}
function counters(): NativeCounts {
  return { nativeBytes: 0, nativeCalls: 0, allocations: [], targetBuffers: new Set(), offsets: [] };
}
function instrument(
  access: NativeAccess,
  counts: () => NativeCounts,
  close: () => void,
): NativeAccess {
  return {
    getSize: () => access.getSize(),
    read(buffer, options) {
      const count = access.read(buffer, options);
      const current = counts();
      current.nativeCalls++;
      current.nativeBytes += count;
      current.targetBuffers.add(buffer.buffer);
      current.offsets.push(options.at);
      return count;
    },
    write: (buffer, options) => access.write(buffer, options),
    truncate: (length) => access.truncate(length),
    flush: () => access.flush(),
    close,
  };
}

type OriginalRecord = { closes: number; closed: boolean };
function observedFactory(
  create: NativeFile["createSyncAccessHandle"],
  originals: Map<NativeAccess, OriginalRecord>,
  counts: () => NativeCounts,
): NativeFile["createSyncAccessHandle"] {
  return async function (this: FileSystemFileHandle) {
    const original = await create.call(this);
    const record = { closes: 0, closed: false };
    originals.set(original, record);
    return instrument(original, counts, () => closeOriginal(original, record));
  };
}
function closeOriginal(original: NativeAccess, record: OriginalRecord) {
  record.closes++;
  original.close();
  record.closed = true;
}

export async function runOpfsRangeBrowser() {
  const root = await navigator.storage.getDirectory();
  const name = `range-${crypto.randomUUID()}`;
  let owner: OpfsStorage | undefined;
  const prototype = FileSystemFileHandle.prototype;
  assert(hasSyncAccess(prototype), "Native sync-access method missing");
  const create = prototype.createSyncAccessHandle;
  const OriginalBytes = globalThis.Uint8Array;
  const originals = new Map<NativeAccess, { closes: number; closed: boolean }>();
  let current = counters();
  let captureAllocations = false;
  try {
    await seed(root, name);
    prototype.createSyncAccessHandle = observedFactory(create, originals, () => current);
    globalThis.Uint8Array = new Proxy(OriginalBytes, {
      construct(target, args, newTarget) {
        if (captureAllocations && typeof args[0] === "number") current.allocations.push(args[0]);
        return Reflect.construct(target, args, newTarget);
      },
    });
    owner = await OpfsStorage.open(name);
    await owner.load();
    assert(Array.from(originals).length === 0, "Index loading opened a native payload");
    captureAllocations = true;
    const bytes = await owner.readRange("revision", { offset, length: 4096 });
    captureAllocations = false;
    assert(
      bytes.length === 4096 && bytes.every((byte, i) => byte === byteAt(offset + i)),
      "Native range bytes differ",
    );
    assert(
      current.nativeBytes === 4096 && current.nativeCalls === 1,
      "Native reads are not bounded",
    );
    assert(
      current.allocations.length === 1 && current.allocations[0] === 4096,
      "Allocation exceeded range",
    );
    assert(
      Array.from(current.targetBuffers, (buffer) => buffer.byteLength).join() === "4096",
      "Native target is not bounded",
    );
    assert(current.offsets.join() === String(offset), "Native offset differs");
    const bounded = {
      ...current,
      targetBuffers: Array.from(current.targetBuffers, (buffer) => buffer.byteLength),
    };
    current = counters();
    const eof = await owner.readRange("revision", { offset: size - 3, length: 4096 });
    assert(
      eof.length === 3 && eof.every((byte, i) => byte === byteAt(size - 3 + i)),
      "EOF clipping differs",
    );
    assert(
      (await owner.readRange("revision", { offset: size, length: 4096 })).length === 0,
      "EOF not empty",
    );
    assert(current.nativeBytes === 3, "EOF read crossed payload boundary");
    await owner.close();
    assert(
      originals.size === 1 &&
        Array.from(originals.values()).every((record) => record.closed && record.closes === 1),
      "Original native handle not closed exactly once",
    );
    assert(owner.resources().opfsHandles === 0, "Adapter retained a closed handle");
    return {
      payloadSize: size,
      bounded,
      eofBytes: current.nativeBytes,
      originalHandles: originals.size,
      originalCloses: 1,
      opfsRemoved: true,
    };
  } finally {
    captureAllocations = false;
    globalThis.Uint8Array = OriginalBytes;
    try {
      await owner?.close();
    } finally {
      prototype.createSyncAccessHandle = create;
      await root.removeEntry(`bun-wasm-${encode(name)}`, { recursive: true });
    }
  }
}
