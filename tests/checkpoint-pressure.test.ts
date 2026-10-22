import { expect, spyOn, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent";
import { snapshotBatch, type PersistedIndex, type PersistenceBatch, type StorageBackend } from "../fs/storage";

const encode = (text: string) => new TextEncoder().encode(text);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

class HeldStorage implements StorageBackend {
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
  async load() { return this.index && structuredClone(this.index); }
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
    this.index = { version: 1, generation: copy.generation, root: copy.root, nodes: Array.from(nodes.values()) };
  }
  async flush(keys?: readonly string[]) {
    this.syncs.push(keys);
    this.flushEntered.resolve();
    if (this.holdFlush) await this.flushReleased.promise;
    if (this.flushFailure) throw this.flushFailure;
  }
  async close() { this.closed = true; }
}

const limits = { maxBytes: 8, maxMetadataBytes: 16_384, maxOperations: 2 };

async function withBackend(run: (backend: PersistentBackend, store: HeldStorage, track: (work: Promise<void>) => Promise<void>) => Promise<void>, checkpointLimits = limits) {
  const store = new HeldStorage();
  const options = { intervalMs: 0, checkpointLimits };
  const backend = await PersistentBackend.open(store, options);
  const work: Promise<void>[] = [];
  const track = (promise: Promise<void>) => {
    void promise.catch(() => {});
    work.push(promise);
    return promise;
  };
  try { await run(backend, store, track); }
  finally {
    store.persistReleased.resolve();
    store.flushReleased.resolve();
    await Promise.allSettled(work);
    backend.dispose();
  }
}

function write(backend: PersistentBackend, text: string) {
  backend.execute("writeFile", ["/file"], encode(text));
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
    } finally { snapshot.mockRestore(); }
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
    void excess.catch((error: unknown) => { result = error; });
    await turn();
    expect(result).toMatchObject({ errno: 6 });
    store.flushReleased.resolve();
  });
});
