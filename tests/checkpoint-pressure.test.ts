import { nextReservation, storeReservation, type StoredReservation } from "../fs/file-identity";
import { expect, spyOn, test } from "bun:test";
import { SharedFilesystemState } from "../fs/shared";
import { PersistentBackend } from "../fs/persistent";
import {
  snapshotBatch,
  type PersistedIndex,
  type PersistenceBatch,
  type StorageBackend,
} from "../fs/storage";

const encode = (text: string) => new TextEncoder().encode(text);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

class HeldStorage implements StorageBackend {
  private identityReservation?: StoredReservation;
  async reserveIdentity(workspace?: string) {
    const value = nextReservation(this.identityReservation, workspace);
    this.identityReservation = storeReservation(value);
    return value;
  }
  index?: PersistedIndex;
  readonly payloads = new Map<string, Uint8Array>();
  readonly batches: PersistenceBatch[] = [];
  readonly syncs: (readonly string[] | undefined)[] = [];
  readonly persistEntered = Promise.withResolvers<void>();
  readonly persistReleased = Promise.withResolvers<void>();
  readonly flushEntered = Promise.withResolvers<void>();
  readonly flushReleased = Promise.withResolvers<void>();
  holdPersist = false;
  holdFlush = false;
  persistFailure?: Error;
  flushFailure?: Error;
  closed = false;
  async load() {
    return this.index && structuredClone(this.index);
  }
  async read(key: string) {
    const bytes = this.payloads.get(key);
    if (!bytes) throw new Error("missing payload");
    return bytes.slice();
  }
  async persist(batch: PersistenceBatch) {
    const copy = snapshotBatch(batch);
    this.batches.push(copy);
    this.persistEntered.resolve();
    if (this.holdPersist) await this.persistReleased.promise;
    if (this.persistFailure) throw this.persistFailure;
    const nodes = new Map(this.index?.nodes.map((node) => [node.ino, node]));
    for (const node of copy.upserts) nodes.set(node.ino, node);
    for (const ino of copy.removes) nodes.delete(ino);
    for (const [key, bytes] of copy.data) this.payloads.set(key, bytes);
    this.index = {
      version: 1,
      generation: copy.generation,
      root: copy.root,
      nodes: Array.from(nodes.values()),
    };
  }
  async flush(keys?: readonly string[]) {
    this.syncs.push(keys);
    this.flushEntered.resolve();
    if (this.holdFlush) await this.flushReleased.promise;
    if (this.flushFailure) throw this.flushFailure;
  }
  async close() {
    this.closed = true;
  }
}

const limits = { maxBytes: 8, maxMetadataBytes: 16_384, maxOperations: 2 };

async function withBackend(
  run: (
    backend: PersistentBackend,
    store: HeldStorage,
    track: (work: Promise<void>) => Promise<void>,
  ) => Promise<void>,
  checkpointLimits = limits,
) {
  const store = new HeldStorage();
  const options = { intervalMs: 0, checkpointLimits, dirtyLimits: false } as const;
  const backend = await PersistentBackend.open(store, options);
  const work: Promise<void>[] = [];
  const track = (promise: Promise<void>) => {
    void promise.catch(() => {});
    work.push(promise);
    return promise;
  };
  try {
    await run(backend, store, track);
  } finally {
    store.persistReleased.resolve();
    store.flushReleased.resolve();
    await Promise.allSettled(work);
    await Promise.allSettled([backend.close()]);
    backend.dispose();
  }
}

function write(backend: PersistentBackend, text: string) {
  backend.execute("writeFile", ["/file"], encode(text));
}

async function rejectRepeatedCaptures(backend: PersistentBackend) {
  for (let index = 0; index < 40; index++) {
    write(backend, "cccc");
    await expect(backend.checkpoint()).rejects.toMatchObject({ errno: 6 });
  }
}

test("payload admission rejects before a second shared snapshot while persist is held", async () => {
  await withBackend(async (backend, store, track) => {
    store.holdPersist = true;
    write(backend, "aaaa");
    const snapshot = spyOn(backend.shared, "snapshot");
    try {
      track(backend.checkpoint());
      await store.persistEntered.promise;
      write(backend, "bbbb");
      const next = track(backend.checkpoint());
      expect(snapshot).toHaveBeenCalledTimes(1);
      store.persistReleased.resolve();
      await expect(next).rejects.toMatchObject({ errno: 6 });
    } finally {
      snapshot.mockRestore();
    }
  });
});

test("unchanged explicit flushes consume operation admission while a flush is held", async () => {
  await withBackend(async (backend, store, track) => {
    await backend.checkpoint();
    store.holdFlush = true;
    track(backend.flush());
    await store.flushEntered.promise;
    track(backend.flush());
    let result: unknown;
    const excess = track(backend.flush());
    void excess.catch((error: unknown) => {
      result = error;
    });
    await turn();
    expect(result).toMatchObject({ errno: 6 });
    store.flushReleased.resolve();
  });
});

test("queued and in-flight captures share one byte ceiling under repeated host saves", async () => {
  await withBackend(
    async (backend, store, track) => {
      store.holdPersist = true;
      write(backend, "aaaa");
      track(backend.checkpoint());
      await store.persistEntered.promise;
      write(backend, "bbbb");
      const second = track(backend.checkpoint());
      expect(backend.checkpointPressure()).toMatchObject({
        pendingBytes: 16,
        pendingOperations: 2,
        queuedOperations: 1,
        inFlightOperations: 1,
      });
      const snapshot = spyOn(backend.shared, "snapshot");
      try {
        await rejectRepeatedCaptures(backend);
        expect(snapshot).not.toHaveBeenCalled();
      } finally {
        snapshot.mockRestore();
      }
      expect(Array.from(store.batches[0]!.data.values())).toEqual([encode("aaaa")]);
      store.persistReleased.resolve();
      await second;
      expect(Array.from(store.batches[1]!.data.values())).toEqual([encode("bbbb")]);
      expect(backend.checkpointPressure()).toMatchObject({ pendingBytes: 0, pendingOperations: 0 });
      await backend.flush();
      expect(Array.from(store.batches[2]!.data.values())).toEqual([encode("cccc")]);
    },
    { ...limits, maxBytes: 16, maxMetadataBytes: 32_768 },
  );
});

test("oversize dirty payload rejects before copying and remains retryable after shrink", async () => {
  await withBackend(async (backend, store) => {
    write(backend, "oversized");
    const snapshot = spyOn(backend.shared, "snapshot");
    try {
      await expect(backend.checkpoint()).rejects.toMatchObject({ errno: 6 });
      expect(snapshot).not.toHaveBeenCalled();
      expect(store.index).toBeUndefined();
      write(backend, "fits");
      await backend.flush();
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(store.index?.generation).toBe(1);
    } finally {
      snapshot.mockRestore();
    }
  });
});

test("namespace churn is charged before copying directory children even with no payload", async () => {
  await withBackend(
    async (backend, store, track) => {
      store.holdPersist = true;
      track(backend.checkpoint());
      await store.persistEntered.promise;
      for (let index = 0; index < 20; index++)
        backend.execute("mkdirp", [`/directory${index}`], new Uint8Array());
      const children = backend.fs.root.children;
      const iterator = spyOn(children, Symbol.iterator);
      try {
        await expect(backend.checkpoint()).rejects.toMatchObject({ errno: 6 });
        expect(iterator).not.toHaveBeenCalled();
        expect(backend.checkpointPressure()).toMatchObject({
          pendingBytes: 0,
          pendingOperations: 1,
        });
      } finally {
        iterator.mockRestore();
      }
      store.persistReleased.resolve();
      await turn();
      for (let index = 0; index < 20; index++)
        backend.execute("remove", [`/directory${index}`], new Uint8Array());
      // Removal records are also budgeted. They need a larger allowance than the root alone.
      await expect(backend.checkpoint()).rejects.toMatchObject({ errno: 6 });
      expect(store.index?.nodes).toHaveLength(1);
    },
    { ...limits, maxMetadataBytes: 4096 },
  );
});

test("namespace-only queued snapshots preserve rename order and release metadata reservations", async () => {
  await withBackend(async (backend, store, track) => {
    backend.execute("mkdirp", ["/before"], new Uint8Array());
    store.holdPersist = true;
    const first = track(backend.checkpoint());
    await store.persistEntered.promise;
    backend.execute("move", ["/before", "/after"], new Uint8Array());
    const second = track(backend.checkpoint());
    expect(backend.checkpointPressure().pendingMetadataBytes).toBeGreaterThan(0);
    expect(backend.checkpointPressure().pendingBytes).toBe(0);
    expect(
      store.batches[0]?.upserts
        .find((node) => node.ino === backend.fs.root.ino)
        ?.children?.map(([name]) => name),
    ).toEqual(["before"]);
    store.persistReleased.resolve();
    await Promise.all([first, second]);
    expect(
      store.batches[1]?.upserts
        .find((node) => node.ino === backend.fs.root.ino)
        ?.children?.map(([name]) => name),
    ).toEqual(["after"]);
    expect(backend.checkpointPressure()).toMatchObject({
      pendingMetadataBytes: 0,
      pendingOperations: 0,
    });
  });
});

test("held flush retains the capture reservation and reports age and completion latency", async () => {
  await withBackend(async (backend, store, track) => {
    let now = 100;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
      store.holdFlush = true;
      write(backend, "aaaa");
      const saving = track(backend.flush());
      await store.flushEntered.promise;
      now = 137;
      expect(backend.checkpointPressure()).toMatchObject({
        pendingBytes: 8,
        pendingOperations: 1,
        oldestAgeMs: 37,
      });
      write(backend, "bbbb");
      await expect(backend.checkpoint()).rejects.toMatchObject({ errno: 6 });
      store.flushReleased.resolve();
      await saving;
      expect(backend.checkpointPressure()).toMatchObject({
        pendingBytes: 0,
        oldestAgeMs: 0,
        lastLatencyMs: 37,
        maxLatencyMs: 37,
      });
      await backend.flush();
    } finally {
      clock.mockRestore();
    }
  });
});

test("direct guest writes remain volatile during held persist and pressure rejection has no delayed effect", async () => {
  await withBackend(
    async (backend, store, track) => {
      write(backend, "aaaa");
      const node = backend.fs.lookup("/file");
      if (!node) throw new Error("missing file");
      const handle = backend.fs.handleForNode(node);
      const guest = new SharedFilesystemState(backend.shared.buffer, undefined, 42);
      const slot = guest.fileSlot(handle);
      const epoch = new Int32Array(new SharedArrayBuffer(4));
      store.holdPersist = true;
      const saving = track(backend.checkpoint());
      await store.persistEntered.promise;
      expect(guest.directWrite(slot, handle, [encode("bbbb")], 0, 4, epoch, () => false, 42)).toBe(
        4,
      );
      expect(guest.directAppend(slot, handle, [encode("c")], 1, epoch, () => false, 42)).toEqual({
        written: 1,
        offset: 5,
      });
      await expect(backend.checkpoint()).rejects.toMatchObject({ errno: 6 });
      store.persistReleased.resolve();
      await saving;
      expect(store.index?.generation).toBe(1);
      expect(Array.from(store.batches[0]!.data.values())).toEqual([encode("aaaa")]);
      await backend.flush();
      expect(store.index?.generation).toBe(2);
      expect(Array.from(store.batches[1]!.data.values())).toEqual([encode("bbbbc")]);
    },
    { ...limits, maxBytes: 12 },
  );
});

test("cancellation before admission copies nothing; cancellation after capture retains actual ownership through close", async () => {
  await withBackend(async (backend, store, track) => {
    const aborted = new AbortController();
    aborted.abort(new Error("cancel before capture"));
    write(backend, "aaaa");
    await expect(backend.flush(undefined, aborted.signal)).rejects.toThrow("cancel before capture");
    expect(backend.checkpointPressure().pendingOperations).toBe(0);
    store.holdPersist = true;
    const controller = new AbortController();
    const save = track(backend.flush(undefined, controller.signal));
    await store.persistEntered.promise;
    controller.abort(new Error("cancel observation"));
    await expect(save).rejects.toThrow("cancel observation");
    expect(backend.checkpointPressure()).toMatchObject({ pendingBytes: 8, pendingOperations: 1 });
    const closing = track(backend.close());
    await turn();
    expect(store.closed).toBe(false);
    store.persistReleased.resolve();
    await closing;
    expect(store.closed).toBe(true);
    expect(backend.checkpointPressure()).toMatchObject({ pendingBytes: 0, pendingOperations: 0 });
    expect(store.index?.generation).toBe(1);
  });
});

test("cancelled queued observation cannot drop immutable bytes referenced by later persistence", async () => {
  await withBackend(
    async (backend, store, track) => {
      store.holdPersist = true;
      write(backend, "aaaa");
      track(backend.checkpoint());
      await store.persistEntered.promise;
      write(backend, "bbbb");
      const controller = new AbortController();
      const second = track(backend.checkpoint(false, undefined, controller.signal));
      controller.abort(new Error("cancel queued observer"));
      await expect(second).rejects.toThrow("cancel queued observer");
      expect(backend.checkpointPressure().pendingBytes).toBe(16);
      store.persistReleased.resolve();
      await backend.flush();
      expect(store.index?.generation).toBe(2);
      expect(Array.from(store.batches[1]!.data.values())).toEqual([encode("bbbb")]);
      expect(backend.checkpointPressure().pendingOperations).toBe(0);
    },
    { ...limits, maxBytes: 16, maxOperations: 3, maxMetadataBytes: 32_768 },
  );
});

test("persist failure invalidates queued captures, releases every reservation and retries one stable generation", async () => {
  await withBackend(
    async (backend, store, track) => {
      write(backend, "base");
      await backend.flush();
      store.holdPersist = true;
      store.persistFailure = new Error("held persist failed");
      write(backend, "aaaa");
      const first = track(backend.checkpoint());
      await turn();
      write(backend, "bbbb");
      const second = track(backend.checkpoint());
      store.persistReleased.resolve();
      await expect(first).rejects.toThrow("held persist failed");
      await expect(second).rejects.toThrow("invalidated by a failed commit");
      expect(store.index?.generation).toBe(1);
      expect(backend.checkpointPressure()).toMatchObject({
        pendingBytes: 0,
        pendingMetadataBytes: 0,
        pendingOperations: 0,
      });
      store.persistFailure = undefined;
      await backend.flush();
      expect(store.index?.generation).toBe(2);
      expect(Array.from(store.batches.at(-1)!.data.values())).toEqual([encode("bbbb")]);
    },
    { ...limits, maxBytes: 16, maxMetadataBytes: 32_768 },
  );
});

test("payload flush failure releases pressure without rolling back the committed generation", async () => {
  await withBackend(async (backend, store, track) => {
    write(backend, "aaaa");
    store.holdFlush = true;
    store.flushFailure = new Error("held flush failed");
    const saving = track(backend.flush("/file"));
    await store.flushEntered.promise;
    store.flushReleased.resolve();
    await expect(saving).rejects.toThrow("held flush failed");
    expect(backend.checkpointPressure().pendingOperations).toBe(0);
    expect(store.index?.generation).toBe(1);
    store.flushFailure = undefined;
    await backend.flush("/file");
    expect(store.batches).toHaveLength(1);
    expect(store.index?.generation).toBe(1);
    expect(store.syncs[0]).toEqual(store.syncs[1]);
  });
});

test("targeted barriers keep each immutable key when later captures run", async () => {
  await withBackend(
    async (backend, store, track) => {
      store.holdPersist = true;
      write(backend, "aaaa");
      const first = track(backend.flush("/file"));
      await store.persistEntered.promise;
      write(backend, "bbbb");
      const second = track(backend.flush("/file"));
      store.persistReleased.resolve();
      await Promise.all([first, second]);
      expect(store.syncs).toEqual(store.batches.map((batch) => Array.from(batch.data.keys())));
      expect(store.syncs[0]).not.toEqual(store.syncs[1]);
    },
    { ...limits, maxBytes: 16, maxMetadataBytes: 32_768 },
  );
});

test("dispose does not release a reservation before the actual held persist settles", async () => {
  await withBackend(async (backend, store, track) => {
    store.holdPersist = true;
    write(backend, "aaaa");
    const saving = track(backend.checkpoint());
    await store.persistEntered.promise;
    backend.dispose();
    expect(backend.checkpointPressure().pendingBytes).toBe(8);
    store.persistReleased.resolve();
    await expect(saving).rejects.toThrow("backend is closed");
    expect(backend.checkpointPressure()).toMatchObject({
      pendingBytes: 0,
      pendingMetadataBytes: 0,
      pendingOperations: 0,
    });
    await expect(backend.checkpoint()).rejects.toThrow("backend is closed");
  });
});

test("a synchronous capture failure releases reservation and retries bytes instead of nonexistent keys", async () => {
  await withBackend(
    async (backend, store) => {
      write(backend, "aaaa");
      backend.execute("writeFile", ["/other"], encode("bbbb"));
      const original = backend.shared.snapshot.bind(backend.shared);
      let calls = 0;
      const snapshot = spyOn(backend.shared, "snapshot").mockImplementation((handle) => {
        if (++calls === 2) throw new Error("capture failed");
        return original(handle);
      });
      try {
        await expect(backend.checkpoint()).rejects.toThrow("capture failed");
        expect(backend.checkpointPressure()).toMatchObject({
          pendingBytes: 0,
          pendingMetadataBytes: 0,
          pendingOperations: 0,
        });
        expect(store.batches).toHaveLength(0);
      } finally {
        snapshot.mockRestore();
      }
      await backend.flush();
      expect(Array.from(store.batches[0]!.data.values())).toEqual([encode("aaaa"), encode("bbbb")]);
      expect(store.index?.generation).toBe(1);
    },
    { ...limits, maxBytes: 16, maxMetadataBytes: 32_768 },
  );
});

test("invalid checkpoint limits reject before the backend starts a timer", async () => {
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    const store = new HeldStorage();
    await expect(
      PersistentBackend.open(store, { intervalMs: 0, checkpointLimits: { maxBytes: value } }),
    ).rejects.toThrow("invalid checkpoint limit");
  }
});

test("pins registered after capture cannot exceed metadata admission before storage submission", async () => {
  await withBackend(
    async (backend, store, track) => {
      const handles: number[] = [];
      for (let index = 0; index < 12; index++) {
        const path = `/p${index}`;
        backend.execute("writeFile", [path], encode("a"));
        const node = backend.fs.lookup(path);
        if (!node) throw new Error("missing pinned file");
        handles.push(backend.fs.handleForNode(node));
      }
      await backend.flush();
      const evict = () => {
        for (const handle of handles) {
          const revision = backend.shared.revision(handle);
          if (revision !== undefined) expect(backend.shared.evict(handle, revision)).toBe(true);
        }
      };
      evict();
      store.holdPersist = true;
      backend.execute("mkdirp", ["/first"], new Uint8Array());
      const first = track(backend.checkpoint());
      await turn();
      backend.execute("mkdirp", ["/second"], new Uint8Array());
      const second = track(backend.checkpoint());
      for (const handle of handles) backend.retain(handle);
      store.persistReleased.resolve();
      try {
        await first;
        await expect(second).rejects.toMatchObject({ errno: 6 });
        expect(store.batches).toHaveLength(2);
        expect(store.index?.generation).toBe(2);
        expect(backend.checkpointPressure()).toMatchObject({
          pendingBytes: 0,
          pendingMetadataBytes: 0,
          pendingOperations: 0,
        });
      } finally {
        for (const handle of handles) backend.release(handle);
      }
      evict();
      await backend.flush();
      expect(store.index?.generation).toBe(3);
      expect(
        store.index?.nodes
          .find((node) => node.ino === backend.fs.root.ino)
          ?.children?.map(([name]) => name),
      ).toContain("second");
    },
    { maxBytes: 64, maxMetadataBytes: 20_000, maxOperations: 2 },
  );
});

test("terminal oversize capture preserves the original close failure without releasing storage", async () => {
  await withBackend(async (backend, store, track) => {
    write(backend, "oversized");
    const closing = track(backend.close());
    await expect(closing).rejects.toMatchObject({ errno: 6 });
    expect(backend.close()).toBe(closing);
    expect(store.closed).toBe(false);
    expect(store.batches).toHaveLength(0);
    expect(backend.checkpointPressure()).toMatchObject({
      pendingBytes: 0,
      pendingMetadataBytes: 0,
      pendingOperations: 0,
    });
  });
});
