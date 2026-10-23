import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend";
import { openFilesystemBackend } from "../browser/filesystem-backend";
import { PersistentBackend } from "../fs/persistent";
import {
  MemoryBudget,
  MemoryBudgetError,
  type MemoryAllocator,
  type MemoryBackingSpec,
} from "../fs/memory-budget";
import { nextReservation } from "../fs/file-identity";
import { preparePayload } from "../fs/indexeddb-chunks";
import {
  snapshotBatch,
  type PayloadRetention,
  type PersistenceBatch,
  type StorageBackend,
} from "../fs/storage";
import { SharedFilesystemState } from "../fs/shared";
import { createPublicationBuffers } from "../fs/publication";
import { workspacePublication } from "../fs/workspace-protocol";

const MiB = 1024 * 1024;

function budget(bytes: number, allocator?: MemoryAllocator): MemoryBudget {
  return new MemoryBudget(
    {
      bytes,
      producers: { allocations: 64, references: 128, leases: 32 },
      progress: { bytes: MiB, allocations: 16, references: 32, leases: 8 },
      waiters: 8,
      serialLimit: Number.MAX_SAFE_INTEGER,
    },
    allocator,
  );
}

function retainedBytes(buffers: readonly ArrayBufferLike[]): number {
  return Array.from(new Set(buffers)).reduce((bytes, buffer) => bytes + buffer.byteLength, 0);
}

class HeldStorage implements StorageBackend {
  readonly entered = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  readonly retained: ArrayBufferLike[] = [];
  held = false;
  closed = false;

  async load() {
    return undefined;
  }
  async reserveIdentity(workspace?: string) {
    return nextReservation(undefined, workspace);
  }
  async read(): Promise<Uint8Array> {
    throw new Error("unexpected whole-file read");
  }
  async readRange(): Promise<Uint8Array> {
    throw new Error("unexpected cold range read");
  }
  retainPayload(): PayloadRetention {
    throw new Error("unexpected cold payload retention");
  }
  async persist(batch: PersistenceBatch) {
    const copied = snapshotBatch(batch);
    for (const bytes of batch.data.values()) this.retained.push(bytes.buffer);
    for (const bytes of copied.data.values()) await this.retainPrepared(bytes);
    this.entered.resolve();
    if (this.held) await this.release.promise;
    this.retained.length = 0;
  }
  private async retainPrepared(bytes: Uint8Array) {
    this.retained.push(bytes.buffer);
    const prepared = await preparePayload(bytes);
    for (const chunk of prepared.chunks) this.retained.push(chunk.bytes.buffer);
  }
  async flush() {}
  async close() {
    this.closed = true;
  }
}

async function close(backend: PersistentBackend | undefined, storage: HeldStorage): Promise<void> {
  storage.held = false;
  storage.release.resolve();
  try {
    if (backend) await backend.close();
    else await storage.close();
  } finally {
    backend?.dispose();
  }
}

function open(storage: HeldStorage, memoryBudget: MemoryBudget): Promise<PersistentBackend> {
  const options = { intervalMs: 0, startupRoot: memoryBudget };
  return PersistentBackend.open(storage, options);
}

test("aggregate contract rejects root construction when its backing cannot fit", async () => {
  const memoryBudget = budget(2 * MiB);
  const storage = new HeldStorage();
  const before = memoryBudget.snapshot();
  let backend: PersistentBackend | undefined;
  let failure: unknown;
  try {
    try {
      backend = await open(storage, memoryBudget);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MemoryBudgetError);
    expect(memoryBudget.snapshot().allocated).toBe(before.allocated);
    expect(memoryBudget.snapshot().obligations).toBe(0);
  } finally {
    await close(backend, storage);
    memoryBudget.close();
  }
});

test("aggregate contract charges a factory root once across shared aliases", async () => {
  const memoryBudget = budget(64 * MiB);
  const storage = new HeldStorage();
  const before = memoryBudget.snapshot();
  const backend = await open(storage, memoryBudget);
  try {
    const sibling = new SharedFilesystemState(backend.shared.buffer);
    const view = new Uint8Array(sibling.buffer, 0, 17);
    const backingBytes = retainedBytes([backend.shared.buffer, sibling.buffer, view.buffer]);
    expect(backingBytes).toBe(backend.shared.buffer.byteLength);
    expect(memoryBudget.snapshot().backingBytes - before.backingBytes).toBe(backingBytes);
    expect(backend.resources().usedBytes).toBe(0);
  } finally {
    await close(backend, storage);
    memoryBudget.close();
  }
});

test("aggregate measurement distinguishes retained root capacity from three real persistence copies", async () => {
  const storage = new HeldStorage();
  const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
  const payload = new Uint8Array(4097).fill(65);
  let checkpoint: Promise<void> | undefined;
  try {
    backend.execute("writeFile", ["/aggregate-contract"], payload);
    storage.held = true;
    checkpoint = backend.checkpoint();
    await storage.entered.promise;
    const copies = retainedBytes(storage.retained);
    const root = backend.shared.buffer.byteLength;
    expect(storage.retained).toHaveLength(3);
    expect(copies).toBe(3 * payload.byteLength);
    expect(backend.checkpointPressure().pendingBytes).toBe(2 * payload.byteLength);
    expect(root).toBeGreaterThan(backend.resources().usedBytes ?? 0);
    expect(retainedBytes(storage.retained.concat([backend.shared.buffer]))).toBe(root + copies);
    console.log(
      JSON.stringify({
        aggregateContractMeasurement: true,
        rootBackingBytes: root,
        assignedPageBytes: backend.resources().usedBytes,
        persistenceBackingBytes: copies,
        checkpointPendingBytes: backend.checkpointPressure().pendingBytes,
        observedBackingBytes: root + copies,
        payloadBytes: payload.byteLength,
        nativeHeapMeasured: false,
        aggregateEnforced: false,
      }),
    );
  } finally {
    storage.release.resolve();
    try {
      await checkpoint;
    } finally {
      await close(backend, storage);
    }
  }
});

const NativeSharedBuffer = SharedArrayBuffer;
class StartupAllocator implements MemoryAllocator {
  budget?: MemoryBudget;
  calls = 0;
  fail = false;
  admittedBackingBytes = 0;
  allocate(spec: MemoryBackingSpec): ArrayBuffer | SharedArrayBuffer {
    this.calls++;
    this.admittedBackingBytes = this.budget?.snapshot().backingBytes ?? 0;
    if (this.fail) throw new Error("controlled startup allocation failure");
    return spec.kind === "shared"
      ? new NativeSharedBuffer(spec.bytes)
      : new ArrayBuffer(spec.bytes);
  }
  grow(): void {
    throw new Error("startup tests must not grow backing");
  }
}

function noUnadmittedSharedBuffers<T>(run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "SharedArrayBuffer");
  if (!original) throw new Error("missing SharedArrayBuffer descriptor");
  class DeniedSharedBuffer extends NativeSharedBuffer {
    constructor(bytes: number) {
      super(bytes);
      throw new Error("unadmitted shared backing allocation");
    }
  }
  Object.defineProperty(globalThis, "SharedArrayBuffer", {
    ...original,
    value: DeniedSharedBuffer,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, "SharedArrayBuffer", original);
  }
}

test("aggregate contract admits startup backing before the real allocator runs", async () => {
  const allocator = new StartupAllocator();
  const memoryBudget = budget(64 * MiB, allocator);
  allocator.budget = memoryBudget;
  const before = memoryBudget.snapshot();
  const storage = new HeldStorage();
  const backend = await open(storage, memoryBudget);
  try {
    expect(allocator.calls).toBe(1);
    expect(allocator.admittedBackingBytes).toBe(
      before.backingBytes + backend.shared.buffer.byteLength,
    );
    expect(memoryBudget.snapshot().obligations).toBe(0);
    expect(memoryBudget.snapshot().metadataUnits).toBeGreaterThan(before.metadataUnits);
    expect(backend.resources().startupRootBackingBytes).toBe(backend.shared.buffer.byteLength);
  } finally {
    await close(backend, storage);
    memoryBudget.close();
  }
});

test("aggregate contract returns startup reservations after controlled allocation failure", async () => {
  const allocator = new StartupAllocator();
  allocator.fail = true;
  const memoryBudget = budget(64 * MiB, allocator);
  const before = memoryBudget.snapshot();
  const storage = new HeldStorage();
  let backend: PersistentBackend | undefined;
  let failure: unknown;
  try {
    try {
      backend = await open(storage, memoryBudget);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error && failure.message).toBe(
      "controlled startup allocation failure",
    );
    expect(allocator.calls).toBe(1);
    expect(memoryBudget.snapshot().allocated).toBe(before.allocated);
    expect(memoryBudget.snapshot().obligations).toBe(0);
    expect(memoryBudget.snapshot().producerFree).toEqual(before.producerFree);
  } finally {
    await close(backend, storage);
    memoryBudget.close();
  }
});

test("aggregate contract rolls back an unpublished shared-state constructor", () => {
  const allocator = new StartupAllocator();
  const memoryBudget = budget(64 * MiB, allocator);
  const before = memoryBudget.snapshot();
  try {
    expect(
      () =>
        new SharedFilesystemState(
          undefined,
          Number.NaN,
          undefined,
          undefined,
          undefined,
          undefined,
          memoryBudget,
        ),
    ).toThrow(RangeError);
    expect(allocator.calls).toBe(1);
    expect(memoryBudget.snapshot().allocated).toBe(before.allocated);
    expect(memoryBudget.snapshot().obligations).toBe(0);
    expect(memoryBudget.snapshot().producerFree).toEqual(before.producerFree);
  } finally {
    memoryBudget.close();
  }
});

test("aggregate contract reuses an existing factory root without a temporary backing", async () => {
  const allocator = new StartupAllocator();
  const memoryBudget = budget(64 * MiB, allocator);
  const storage = new HeldStorage();
  const backend = await open(storage, memoryBudget);
  try {
    const before = memoryBudget.snapshot();
    const identity = backend.fs.root.identity;
    const sibling = noUnadmittedSharedBuffers(
      () => new MemoryBackend(undefined, undefined, backend),
    );
    expect(sibling.shared).toBe(backend.shared);
    expect(sibling.fs).toBe(backend.fs);
    expect(sibling.workspaceId).toBe(backend.workspaceId);
    expect(sibling.fs.root.identity).toBe(identity);
    expect(memoryBudget.snapshot().allocated).toBe(before.allocated);
    expect(allocator.calls).toBe(1);
  } finally {
    await close(backend, storage);
    memoryBudget.close();
  }
});

test("aggregate contract keeps one admitted root through repeated attach and rejects foreign roots", async () => {
  const allocator = new StartupAllocator();
  const memoryBudget = budget(64 * MiB, allocator);
  const storage = new HeldStorage();
  const backend = await open(storage, memoryBudget);
  try {
    const before = memoryBudget.snapshot();
    const root = backend.shared.buffer;
    backend.attachShared(root);
    const state = backend.shared;
    backend.attachShared(structuredClone(root));
    expect(backend.shared).toBe(state);
    expect(() => backend.attachShared(SharedFilesystemState.createBuffer())).toThrow();
    expect(backend.shared).toBe(state);
    expect(memoryBudget.snapshot().allocated).toBe(before.allocated);
    expect(allocator.calls).toBe(1);
  } finally {
    await close(backend, storage);
    memoryBudget.close();
  }
});

test("aggregate contract close and authority stop preserve a published root alias charge", async () => {
  const memoryBudget = budget(64 * MiB);
  const storage = new HeldStorage();
  const backend = await open(storage, memoryBudget);
  const alias = new Uint8Array(backend.shared.buffer, 0, 4);
  try {
    const allocated = memoryBudget.snapshot().allocated;
    expect(backend.resources().startupRootBackingBytes).toBeGreaterThan(0);
    await backend.close();
    backend.dispose();
    expect(storage.closed).toBe(true);
    expect(alias.some((byte) => byte !== 0)).toBe(true);
    expect(memoryBudget.snapshot().allocated).toBe(allocated);
    memoryBudget.close();
    expect(memoryBudget.snapshot().allocated).toBe(allocated);
    expect(alias.some((byte) => byte !== 0)).toBe(true);
  } finally {
    await close(backend, storage);
    memoryBudget.close();
  }
});

test("aggregate contract browser memory factory forwards the startup authority", async () => {
  const memoryBudget = budget(2 * MiB);
  const options: Parameters<typeof openFilesystemBackend>[0] & { startupRoot: MemoryBudget } = {
    mode: "memory",
    startupRoot: memoryBudget,
  };
  let failure: unknown;
  try {
    try {
      await openFilesystemBackend(options, {
        onOwnershipLost() {
          throw new Error("unexpected ownership callback");
        },
        retainStorage() {
          throw new Error("memory mode opened persistent storage");
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MemoryBudgetError);
  } finally {
    memoryBudget.close();
  }
});

test("aggregate contract denies impossible startup before any shared allocator runs", () => {
  const allocator = new StartupAllocator();
  const memoryBudget = budget(2 * MiB, allocator);
  const before = memoryBudget.snapshot();
  try {
    expect(() =>
      noUnadmittedSharedBuffers(() => new MemoryBackend(undefined, undefined, memoryBudget)),
    ).toThrow(MemoryBudgetError);
    expect(allocator.calls).toBe(0);
    expect(memoryBudget.snapshot().allocated).toBe(before.allocated);
    expect(memoryBudget.snapshot().producerFree).toEqual(before.producerFree);
  } finally {
    memoryBudget.close();
  }
});

test("aggregate contract startup pressure has no new allocation or reservation effect", async () => {
  const allocator = new StartupAllocator();
  const memoryBudget = budget(32 * MiB, allocator);
  const storage = new HeldStorage();
  const backend = await open(storage, memoryBudget);
  try {
    const before = memoryBudget.snapshot();
    expect(() => new MemoryBackend(undefined, undefined, memoryBudget)).toThrow(MemoryBudgetError);
    expect(allocator.calls).toBe(1);
    expect(memoryBudget.snapshot().allocated).toBe(before.allocated);
    expect(memoryBudget.snapshot().obligations).toBe(0);
    expect(memoryBudget.snapshot().producerFree).toEqual(before.producerFree);
  } finally {
    await close(backend, storage);
    memoryBudget.close();
  }
});

test("aggregate contract rejects a foreign first attachment without replacing its admitted root", async () => {
  const memoryBudget = budget(64 * MiB);
  const storage = new HeldStorage();
  const backend = await open(storage, memoryBudget);
  const foreign = SharedFilesystemState.createBuffer();
  try {
    const original = backend.shared;
    const before = memoryBudget.snapshot();
    expect(() => backend.attachShared(foreign)).toThrow();
    expect(backend.shared).toBe(original);
    expect(memoryBudget.snapshot().allocated).toBe(before.allocated);
    backend.attachShared(structuredClone(original.buffer));
    expect(backend.resources().startupRootBackingBytes).toBe(original.buffer.byteLength);
  } finally {
    await close(backend, storage);
    memoryBudget.close();
  }
});

test("aggregate contract never retroactively admits an imported shared backing", () => {
  const allocator = new StartupAllocator();
  const memoryBudget = budget(64 * MiB, allocator);
  const existing = SharedFilesystemState.createBuffer();
  const before = memoryBudget.snapshot();
  try {
    expect(
      () =>
        new SharedFilesystemState(
          existing,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          memoryBudget,
        ),
    ).toThrow(TypeError);
    expect(allocator.calls).toBe(0);
    expect(memoryBudget.snapshot().allocated).toBe(before.allocated);
    expect(memoryBudget.snapshot().obligations).toBe(0);
  } finally {
    memoryBudget.close();
  }
});

test("aggregate contract a published root survives later factory failure and remains charged", async () => {
  const allocator = new StartupAllocator();
  const memoryBudget = budget(32 * MiB, allocator);
  const storage = new HeldStorage();
  const before = memoryBudget.snapshot();
  let failure: unknown;
  try {
    try {
      await PersistentBackend.open(storage, {
        startupRoot: memoryBudget,
        checkpointLimits: { maxBytes: 0 },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RangeError);
    expect(allocator.calls).toBe(1);
    expect(memoryBudget.snapshot().backingBytes - before.backingBytes).toBeGreaterThan(16 * MiB);
    expect(memoryBudget.snapshot().obligations).toBe(0);
    expect(() => new MemoryBackend(undefined, undefined, memoryBudget)).toThrow(MemoryBudgetError);
    expect(allocator.calls).toBe(1);
  } finally {
    await storage.close();
    memoryBudget.close();
  }
});

test("aggregate contract raw root factory charges backing once and stops new allocations", () => {
  const allocator = new StartupAllocator();
  const memoryBudget = budget(64 * MiB, allocator);
  const before = memoryBudget.snapshot();
  try {
    const buffer = SharedFilesystemState.createBuffer(memoryBudget);
    const sibling = new SharedFilesystemState(buffer);
    expect(sibling.buffer).toBe(buffer);
    expect(memoryBudget.snapshot().backingBytes - before.backingBytes).toBe(buffer.byteLength);
    expect(allocator.calls).toBe(1);
    memoryBudget.close();
    expect(() => SharedFilesystemState.createBuffer(memoryBudget)).toThrow(MemoryBudgetError);
    expect(allocator.calls).toBe(1);
    expect(memoryBudget.snapshot().backingBytes - before.backingBytes).toBe(buffer.byteLength);
  } finally {
    memoryBudget.close();
  }
});

test("aggregate contract startup root keeps attached publication reader backing", async () => {
  const allocator = new StartupAllocator();
  const memoryBudget = budget(64 * MiB, allocator);
  const storage = new HeldStorage();
  const backend = await open(storage, memoryBudget);
  const publication = createPublicationBuffers(workspacePublication.limits, true);
  let retained: ReturnType<SharedFilesystemState["retainVersionPages"]> | undefined;
  try {
    const root = backend.shared.buffer;
    const before = memoryBudget.snapshot();
    backend.attachShared(root, undefined, [], publication);
    expect(backend.shared.publication?.buffers).toBe(publication);
    const attached = backend.shared;
    backend.attachShared(structuredClone(root), undefined, [], publication);
    expect(backend.shared).toBe(attached);
    const sibling = noUnadmittedSharedBuffers(
      () => new MemoryBackend(undefined, undefined, backend),
    );
    expect(sibling.shared.publication?.buffers).toBe(publication);
    backend.execute("writeFile", ["/reader-root"], new Uint8Array([65, 66]));
    const resolved = backend.fs.resolveAbsolute("/reader-root");
    if (typeof resolved === "number" || resolved.node === undefined)
      throw new Error("reader fixture file is missing");
    retained = backend.shared.retainVersionPages(resolved.node, 0, 2);
    expect(new Int32Array(publication.pageReaders!).some((count) => count > 0)).toBe(true);
    expect(backend.shared.readerPinBytes()).toBe(65536);
    backend.execute("write", [resolved.node, 0], new Uint8Array([90]));
    expect(retained.read(0, 2)).toEqual(new Uint8Array([65, 66]));
    expect(backend.shared.snapshot(resolved.node)?.data).toEqual(new Uint8Array([90, 66]));
    retained.release();
    expect(new Int32Array(publication.pageReaders!).every((count) => count === 0)).toBe(true);
    expect(backend.shared.readerPinBytes()).toBe(0);
    expect(memoryBudget.snapshot().allocated).toBe(before.allocated);
    expect(backend.resources().startupRootBackingBytes).toBe(root.byteLength);
    expect(allocator.calls).toBe(1);
  } finally {
    retained?.release();
    await close(backend, storage);
    memoryBudget.close();
  }
});
