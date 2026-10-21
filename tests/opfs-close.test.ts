import { expect, test } from "bun:test";
import { OpfsStorage, type OpfsStorageOptions } from "../fs/opfs";
import type { StorageLockManager } from "../fs/indexeddb";
import type { PersistenceBatch, PersistedNode } from "../fs/storage";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function outcome(promise: Promise<unknown>): Promise<PromiseSettledResult<unknown>> {
  const [result] = await Promise.allSettled([promise]);
  return result!;
}

function rejected(result: PromiseSettledResult<unknown>, reason: unknown): void {
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") expect(Object.is(result.reason, reason)).toBe(true);
}

type CloseFault = { kind: "none" } | { kind: "throw"; reason: unknown };

// Directory, sync-access and WebLock stand-ins exercise real OpfsStorage, not native APIs.
class AccessStandIn {
  attempts = 0;
  active = true;
  fault: CloseFault = { kind: "none" };
  onClose?: () => void;
  constructor(readonly file: FileStandIn) {}
  getSize(): number { return this.file.bytes.length; }
  read(buffer: Uint8Array, options: { at: number }): number {
    const bytes = this.file.bytes.subarray(options.at, options.at + buffer.length);
    buffer.set(bytes);
    return bytes.length;
  }
  write(buffer: Uint8Array, options: { at: number }): number {
    this.file.bytes.set(buffer, options.at);
    return buffer.length;
  }
  truncate(size: number): void { this.file.bytes = new Uint8Array(size); }
  flush(): void {
    this.file.fixture.events.push(`flush:${this.file.name}`);
    this.file.onFlush?.();
  }
  close(): void {
    this.attempts++;
    this.onClose?.();
    if (this.fault.kind === "throw") throw this.fault.reason;
    if (!this.active) throw new Error("Stand-in handle closed twice");
    this.active = false;
    this.file.fixture.events.push(`close:${this.file.name}`);
  }
  forceClose(): void {
    if (!this.active) return;
    this.active = false;
    this.file.fixture.interventions.push(`force-close:${this.file.name}`);
  }
}

class FileStandIn implements FileSystemFileHandle {
  readonly kind = "file";
  bytes = new Uint8Array(0);
  beforeOpen?: () => Promise<void>;
  onAccess?: (access: AccessStandIn) => void;
  onFlush?: () => void;
  constructor(readonly name: string, readonly fixture: Fixture) {}
  async isSameEntry(other: FileSystemHandle): Promise<boolean> { return this === other; }
  async getFile(): Promise<File> { return new File([this.bytes], this.name); }
  async createWritable(): Promise<FileSystemWritableFileStream> {
    throw new Error("Writable streams are not used by this fixture");
  }
  async createSyncAccessHandle(): Promise<AccessStandIn> {
    await this.beforeOpen?.();
    const access = new AccessStandIn(this);
    this.fixture.accesses.push(access);
    this.onAccess?.(access);
    return access;
  }
}

class DirectoryStandIn implements FileSystemDirectoryHandle {
  readonly kind = "directory";
  readonly children = new Map<string, DirectoryStandIn | FileStandIn>();
  constructor(readonly name: string, readonly fixture: Fixture) {}
  async isSameEntry(other: FileSystemHandle): Promise<boolean> { return this === other; }
  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<DirectoryStandIn> {
    const existing = this.children.get(name);
    if (existing instanceof DirectoryStandIn) return existing;
    if (!options?.create) throw new DOMException("Missing directory", "NotFoundError");
    const directory = new DirectoryStandIn(name, this.fixture);
    this.children.set(name, directory);
    return directory;
  }
  async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileStandIn> {
    const existing = this.children.get(name);
    if (existing instanceof FileStandIn) return existing;
    if (!options?.create) throw new DOMException("Missing file", "NotFoundError");
    const file = new FileStandIn(name, this.fixture);
    this.children.set(name, file);
    this.fixture.files.push(file);
    return file;
  }
  async removeEntry(name: string): Promise<void> { this.children.delete(name); }
  async resolve(): Promise<string[] | null> { return null; }
  async *entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]> {
    yield* this.children.entries();
  }
  async *keys(): AsyncIterableIterator<string> { yield* this.children.keys(); }
  async *values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle> {
    yield* this.children.values();
  }
  [Symbol.asyncIterator]() { return this.entries(); }
}

class LockStandIn implements StorageLockManager {
  held = false;
  releases = 0;
  readonly forced = deferred<never>();
  readonly requests: Promise<unknown>[] = [];
  request<T>(_name: string, options: { mode: "exclusive"; signal?: AbortSignal }, callback: (lock: unknown | null) => Promise<T>): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    if (this.held) throw new Error("Fixture must not steal a lock");
    this.held = true;
    const result = Promise.race([callback({}), this.forced.promise]);
    this.requests.push(outcome(result));
    return result.finally(() => {
      if (!this.held) return;
      this.held = false;
      this.releases++;
    });
  }
  forceRelease(): void {
    this.held = false;
    this.forced.reject(new Error("Explicit fixture lock-release intervention"));
  }
}

class Fixture {
  readonly root = new DirectoryStandIn("root", this);
  readonly locks = new LockStandIn();
  readonly accesses: AccessStandIn[] = [];
  readonly files: FileStandIn[] = [];
  readonly events: string[] = [];
  readonly interventions: string[] = [];
  readonly gates: ReturnType<typeof deferred<void>>[] = [];
  readonly work: Promise<unknown>[] = [];
  readonly owners: OpfsStorage[] = [];
  track<T>(promise: Promise<T>): Promise<T> {
    this.work.push(outcome(promise));
    return promise;
  }
  gate() {
    const gate = deferred<void>();
    this.gates.push(gate);
    return gate;
  }
  async open(options: OpfsStorageOptions = {}): Promise<OpfsStorage> {
    const owner = await this.track(OpfsStorage.open("close-test", { root: this.root, locks: this.locks, ...options }));
    this.owners.push(owner);
    return owner;
  }
  file(name: string): FileStandIn {
    const file = this.files.find((entry) => entry.name === name);
    if (!file) throw new Error(`Fixture file missing: ${name}`);
    return file;
  }
  live(): AccessStandIn[] { return this.accesses.filter((access) => access.active); }
  async cleanup(): Promise<void> {
    for (const gate of this.gates) gate.resolve();
    await Promise.all(this.work);
    await Promise.allSettled(this.owners.map((owner) => owner.close()));
    for (const access of this.accesses) access.forceClose();
    if (this.locks.held) this.interventions.push("force-release:original-lock");
    this.locks.forceRelease();
    await Promise.all(this.locks.requests);
    expect(this.live()).toHaveLength(0);
    expect(this.locks.held).toBe(false);
  }
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = new Fixture();
  try { await run(fixture); }
  finally { await fixture.cleanup(); }
}

function encoded(value: string): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function batch(generation = 1, count = 2): PersistenceBatch {
  const children: [string, number][] = [];
  const upserts: PersistedNode[] = [{ ino: 1, kind: "dir", size: 0, mtime: generation, children }];
  const data = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index++) {
    const key = `key:${index}`;
    children.push([key, index + 2]);
    upserts.push({ ino: index + 2, kind: "file", size: 1, mtime: generation, data: key });
    data.set(key, new Uint8Array([index]));
  }
  return { generation, root: 1, upserts, removes: [], data };
}
async function cached(fixture: Fixture, count = 2, cacheSize = 4) {
  const storage = await fixture.open({ handleCacheSize: cacheSize, createConcurrency: 2 });
  await fixture.track(storage.persist(batch(1, count)));
  for (let index = 0; index < Math.min(count, cacheSize); index++) await fixture.track(storage.read(`key:${index}`));
  return storage;
}
function fault(reason: unknown): CloseFault { return { kind: "throw", reason }; }
const reasons: { label: string; reason: unknown }[] = [
  { label: "Error", reason: new Error("physical close failed") },
  { label: "undefined", reason: undefined },
  { label: "null", reason: null },
  { label: "false", reason: false },
  { label: "zero", reason: 0 },
  { label: "negative zero", reason: -0 },
  { label: "bigint zero", reason: 0n },
  { label: "NaN", reason: Number.NaN },
  { label: "empty string", reason: "" },
];

  for (const { label, reason } of reasons) {
    test(`cached failed original retains exact ${label}, count and lock without retry`, () => withFixture(async (fixture) => {
      const storage = await cached(fixture);
      const [failed, sibling] = fixture.live();
      failed!.fault = fault(reason);
      const closing = fixture.track(storage.close());
      rejected(await outcome(closing), reason);
      expect(storage.close()).toBe(closing);
      expect(failed!.attempts).toBe(1);
      expect(sibling!.attempts).toBe(1);
      expect(sibling!.active).toBe(false);
      expect(failed!.active).toBe(true);
      expect(storage.resources().opfsHandles).toBe(1);
      expect(storage.resources().opfsCachedHandles).toBe(1);
      expect(fixture.locks.held).toBe(true);
      expect(fixture.locks.releases).toBe(0);
      expect((await outcome(fixture.track(storage.read("key:0"))))).status).toBe("rejected");
      rejected(await outcome(storage.close()), reason);
      expect(failed!.attempts).toBe(1);
    }));
  }

  test("reentrant physical callbacks see the same terminal promise and safe siblings finish", () => withFixture(async (fixture) => {
    const storage = await cached(fixture);
    const seen: Promise<void>[] = [];
    for (const access of fixture.live()) access.onClose = () => { seen.push(storage.close()); };
    const closing = fixture.track(storage.close());
    await closing;
    expect(seen).toEqual([closing, closing]);
    expect(storage.close()).toBe(closing);
    expect(fixture.accesses.every((access) => access.attempts === 1)).toBe(true);
    expect(storage.resources().opfsHandles).toBe(0);
    expect(fixture.locks.releases).toBe(1);
  }));

  test("failed eviction keeps its cached original, prevents replacement and blocks queued starts", () => withFixture(async (fixture) => {
    const storage = await cached(fixture, 2, 1);
    const failed = fixture.live()[0]!;
    const reason = new Error("eviction close failed");
    failed.fault = fault(reason);
    const before = fixture.accesses.length;
    const eviction = fixture.track(storage.read("key:1"));
    const queued = fixture.track(storage.load());
    expect((await outcome(eviction)).status).toBe("rejected");
    expect((await outcome(queued)).status).toBe("rejected");
    rejected(await outcome(fixture.track(storage.close())), reason);
    expect(fixture.accesses.length).toBe(before);
    expect(failed.attempts).toBe(1);
    expect(storage.resources().opfsHandles).toBe(1);
    expect(storage.resources().opfsCachedHandles).toBe(1);
    expect(fixture.locks.held).toBe(true);
  }));

  test("transient metadata flush failure retains its original and closes cached siblings", () => withFixture(async (fixture) => {
    const storage = await cached(fixture);
    const snapshot = fixture.files.find((file) => file.name.startsWith("snapshot-1-"))!;
    const reason = undefined;
    snapshot.onAccess = (access) => { access.fault = fault(reason); };
    expect((await outcome(fixture.track(storage.flush()))).status).toBe("rejected");
    const original = fixture.live().find((access) => access.file === snapshot)!;
    rejected(await outcome(fixture.track(storage.close())), reason);
    expect(original.active).toBe(true);
    expect(original.attempts).toBe(1);
    expect(fixture.live()).toEqual([original]);
    expect(storage.resources().opfsHandles).toBe(1);
    expect(fixture.locks.held).toBe(true);
  }));

  test("transient payload throw-undefined joins its in-flight sibling before terminal rejection", () => withFixture(async (fixture) => {
    const storage = await fixture.open({ createConcurrency: 2 });
    await fixture.track(storage.load());
    const workspace = Array.from(fixture.root.children.values())[0];
    if (!(workspace instanceof DirectoryStandIn)) throw new Error("Workspace missing");
    const data = await workspace.getDirectoryHandle("data");
    const first = await data.getFileHandle(`p-${encoded("key:0")}`, { create: true });
    const second = await data.getFileHandle(`p-${encoded("key:1")}`, { create: true });
    const entered = fixture.gate();
    const release = fixture.gate();
    first.onAccess = (access) => { access.fault = fault(undefined); };
    second.beforeOpen = () => { entered.resolve(); return release.promise; };
    const saving = fixture.track(storage.persist(batch()));
    await entered.promise;
    const closing = fixture.track(storage.close());
    let settled = false;
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    expect((await outcome(saving)).status).toBe("rejected");
    rejected(await outcome(closing), undefined);
    const original = fixture.accesses.find((access) => access.file === first)!;
    const sibling = fixture.accesses.find((access) => access.file === second)!;
    expect(original.attempts).toBe(1);
    expect(sibling.attempts).toBe(1);
    expect(sibling.active).toBe(false);
    expect(storage.resources().opfsHandles).toBe(1);
    expect(fixture.locks.held).toBe(true);
    expect(fixture.files.some((file) => file.name.startsWith("snapshot-1-"))).toBe(false);
  }));

  test("failed known-payload verification retains its transient original", () => withFixture(async (fixture) => {
    const storage = await cached(fixture, 1);
    const file = fixture.file(`p-${encoded("key:0")}`);
    const reason = false;
    file.onAccess = (access) => { access.fault = fault(reason); };
    expect((await outcome(fixture.track(storage.persist(batch(2, 1))))).status).toBe("rejected");
    rejected(await outcome(fixture.track(storage.close())), reason);
    expect(storage.resources().opfsHandles).toBe(1);
    expect(fixture.live()).toHaveLength(1);
    expect(fixture.live()[0]!.attempts).toBe(1);
    expect(fixture.locks.held).toBe(true);
  }));

  test("failed-open cleanup cannot discard a format-marker original", () => withFixture(async (fixture) => {
    const storage = await fixture.open();
    const workspace = Array.from(fixture.root.children.values())[0];
    if (!(workspace instanceof DirectoryStandIn)) throw new Error("Workspace missing");
    const metadata = await workspace.getDirectoryHandle("metadata");
    const { OPFS_FORMAT } = await import("../fs/vfs-format");
    const marker = await metadata.getFileHandle(`format-${OPFS_FORMAT}`, { create: true });
    const reason = null;
    marker.onAccess = (access) => { access.fault = fault(reason); };
    // Remove the entry until initialize creates it, keeping the selected stand-in file.
    metadata.children.delete(marker.name);
    const getFile = metadata.getFileHandle.bind(metadata);
    metadata.getFileHandle = async (name, options) => {
      if (name === marker.name) { metadata.children.set(name, marker); return marker; }
      return getFile(name, options);
    };
    expect((await outcome(fixture.track(storage.load()))).status).toBe("rejected");
    rejected(await outcome(fixture.track(storage.close())), reason);
    expect(storage.resources().opfsHandles).toBe(1);
    expect(fixture.live()[0]!.attempts).toBe(1);
    expect(fixture.locks.held).toBe(true);
  }));

  test("ordinary close drains pre-admitted work but rejects new admission", () => withFixture(async (fixture) => {
    const storage = await cached(fixture, 1);
    const file = fixture.file(`p-${encoded("key:0")}`);
    const before = fixture.accesses.length;
    const saving = fixture.track(storage.persist(batch(2, 1)));
    const admitted = fixture.track(storage.read("key:0"));
    const closing = fixture.track(storage.close());
    expect((await outcome(fixture.track(storage.load()))).status).toBe("rejected");
    await saving;
    expect(await admitted).toEqual(new Uint8Array([0]));
    await closing;
    expect(fixture.accesses.length).toBeGreaterThan(before);
    expect(file.bytes).toEqual(new Uint8Array([0]));
    expect(storage.resources().opfsHandles).toBe(0);
    expect(fixture.locks.releases).toBe(1);
  }));

  test("ordinary persistence failure stays retryable and cap and durable order remain", () => withFixture(async (fixture) => {
    const storage = await cached(fixture, 4, 1);
    expect((await outcome(fixture.track(storage.persist(batch(1, 4))))).status).toBe("rejected");
    await fixture.track(storage.persist(batch(2, 4)));
    fixture.events.length = 0;
    await fixture.track(storage.flush());
    const flushes = fixture.events.filter((event) => event.startsWith("flush:"));
    expect(flushes.slice(0, 4).every((event) => event.startsWith("flush:p-"))).toBe(true);
    expect(flushes[4]?.startsWith("flush:snapshot-2-")).toBe(true);
    expect(storage.resources().opfsPeakHandles).toBeLessThanOrEqual(storage.resources().opfsHandleLimit!);
    await fixture.track(storage.close());
    expect(storage.resources().opfsHandles).toBe(0);
    expect(fixture.locks.releases).toBe(1);
  }));

  test("startup abort acquires no handle and no lock", () => withFixture(async (fixture) => {
    const controller = new AbortController();
    const reason = new DOMException("Canceled", "AbortError");
    controller.abort(reason);
    rejected(await outcome(fixture.track(fixture.open({ signal: controller.signal }))), reason);
    expect(fixture.accesses).toHaveLength(0);
    expect(fixture.locks.held).toBe(false);
  }));
