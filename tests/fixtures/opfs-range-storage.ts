import { expect } from "bun:test";
import { OpfsStorage } from "../../fs/opfs";
import { encodeSnapshot, type PersistedIndex } from "../../fs/storage";
import type { StorageLockManager } from "../../fs/indexeddb";

export const payloadSize = 128 * 1024 * 1024;
export const encoded = (value: string) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
export const pattern = (offset: number) => (offset * 17 + 3) & 255;

export class RangeAccess {
  active = true;
  closes = 0;
  fault: { reason: unknown } | undefined;
  constructor(readonly file: RangeFile) {}
  getSize() { return this.file.size; }
  read(buffer: Uint8Array, { at }: { at: number }) {
    this.file.reads.push({ at, length: buffer.length, buffer: buffer.buffer });
    this.file.onRead?.();
    if (this.file.readError) throw this.file.readError;
    const count = Math.min(buffer.length, this.file.step, Math.max(0, this.file.size - at));
    for (let i = 0; i < count; i++) buffer[i] = pattern(at + i);
    return count;
  }
  write() { throw new Error("Range fixture must not write payloads"); }
  truncate() { throw new Error("Range fixture must not truncate payloads"); }
  flush() {}
  close() {
    this.closes++;
    if (this.fault) throw this.fault.reason;
    expect(this.active).toBe(true);
    this.active = false;
  }
}

export class RangeFile implements FileSystemFileHandle {
  readonly kind = "file";
  readonly reads: { at: number; length: number; buffer: ArrayBufferLike }[] = [];
  readonly accesses: RangeAccess[] = [];
  step = Infinity;
  readError?: Error;
  onRead?: () => void;
  lookup?: () => Promise<void>;
  acquire?: () => Promise<void>;
  constructor(readonly name: string, public size: number, private text = "") {}
  async createSyncAccessHandle() {
    await this.acquire?.();
    const access = new RangeAccess(this);
    this.accesses.push(access);
    return access;
  }
  async getFile() { return new File([this.text], this.name); }
  async createWritable(): Promise<FileSystemWritableFileStream> { throw new Error("Unexpected writable stream"); }
  async isSameEntry(other: FileSystemHandle) { return this === other; }
}

function iterator<T>(items: Iterable<T>): FileSystemDirectoryHandleAsyncIterator<T> {
  return (async function* () { yield* items; })();
}

class RangeDirectory implements FileSystemDirectoryHandle {
  readonly kind = "directory";
  readonly nodes = new Map<string, RangeDirectory | RangeFile>();
  constructor(readonly name: string) {}
  async isSameEntry(other: FileSystemHandle) { return this === other; }
  async getDirectoryHandle(name: string): Promise<RangeDirectory> {
    const node = this.nodes.get(name);
    if (node instanceof RangeDirectory) return node;
    throw new DOMException(name, "NotFoundError");
  }
  async getFileHandle(name: string): Promise<RangeFile> {
    const node = this.nodes.get(name);
    if (!(node instanceof RangeFile)) throw new DOMException(name, "NotFoundError");
    await node.lookup?.();
    return node;
  }
  async removeEntry(name: string) { this.nodes.delete(name); }
  async resolve() { return null; }
  entries() { return iterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>(this.nodes); }
  keys() { return iterator(this.nodes.keys()); }
  values() { return iterator<FileSystemFileHandle | FileSystemDirectoryHandle>(this.nodes.values()); }
  [Symbol.asyncIterator]() { return this.entries(); }
}

export class RangeFixture {
  readonly root = new RangeDirectory("root");
  readonly files = new Map<string, RangeFile>();
  readonly gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  readonly operations: Promise<unknown>[] = [];
  readonly owners: OpfsStorage[] = [];
  held = false;
  releases = 0;
  private release = Promise.withResolvers<void>();
  private lifetime: Promise<unknown> = Promise.resolve();
  readonly locks: StorageLockManager = {
    request: async (_name, _options, callback) => {
      this.held = true;
      const operation = callback({});
      this.lifetime = operation;
      void this.release.promise.then(() => { this.held = false; });
      return operation.finally(() => { this.held = false; this.releases++; });
    },
  };
  gate() {
    const gate = Promise.withResolvers<void>();
    this.gates.push(gate);
    return gate;
  }
  track<T>(operation: Promise<T>): Promise<T> {
    this.operations.push(operation.catch(() => {}));
    return operation;
  }
  async seed(sizes: number[] = [payloadSize]) {
    const workspace = new RangeDirectory(`bun-wasm-${encoded("ranges")}`);
    const data = new RangeDirectory("data"), metadata = new RangeDirectory("metadata");
    this.root.nodes.set(workspace.name, workspace);
    workspace.nodes.set("data", data);
    workspace.nodes.set("metadata", metadata);
    metadata.nodes.set("format-waffle-opfs-snapshots-v1", new RangeFile("format", 0));
    for (const [i, size] of sizes.entries()) {
      const key = `revision:${i}`;
      const file = new RangeFile(`p-${encoded(key)}`, size);
      this.files.set(key, file);
      data.nodes.set(file.name, file);
      const index: PersistedIndex = { version: 1, generation: i + 1, root: 1, nodes: [
        { ino: 1, kind: "dir", size: 0, mtime: 1, children: [["file", 2]] },
        { ino: 2, kind: "file", size, mtime: 1, data: key },
      ] };
      const record = JSON.stringify(await encodeSnapshot(index));
      metadata.nodes.set(`snapshot-${i + 1}.json`, new RangeFile("snapshot", record.length, record));
    }
  }
  async open(cacheSize = 1) {
    const owner = await OpfsStorage.open("ranges", { root: this.root, locks: this.locks, handleCacheSize: cacheSize });
    this.owners.push(owner);
    return owner;
  }
  file(key = "revision:0") {
    const file = this.files.get(key);
    if (!file) throw new Error(`Unknown fixture key ${key}`);
    return file;
  }
  async cleanup() {
    for (const gate of this.gates) gate.resolve();
    await Promise.all(this.operations);
    await Promise.allSettled(this.owners.map(owner => owner.close()));
    for (const file of this.files.values()) for (const access of file.accesses) access.active = false;
    this.release.resolve();
    // A failed-close fixture deliberately retains the real ownership promise until intervention.
    void this.lifetime.catch(() => {});
    await this.release.promise;
    expect(this.held).toBe(false);
  }
}
