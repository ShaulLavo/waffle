import { fixturePayloadHooks } from "./fixtures/publication-storage";
import { nextReservation, storeReservation, type StoredReservation } from "../fs/file-identity";
import { expect, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent";
import { MemoryBackend } from "../fs/backend";
import { FilesystemClient, FilesystemService, createFilesystemConnection } from "../fs";
import type { PersistenceBatch, PersistedIndex, StorageBackend } from "../fs/storage";

class Store implements StorageBackend {
  private identityReservation?: StoredReservation;
  async reserveIdentity(workspace?: string) {
    const value = nextReservation(this.identityReservation, workspace);
    this.identityReservation = storeReservation(value);
    return value;
  }
  index?: PersistedIndex;
  payloads = new Map<string, Uint8Array>();
  readRange = fixturePayloadHooks(this.payloads).readRange;
  retainPayload = fixturePayloadHooks(this.payloads).retainPayload;
  syncs: (readonly string[] | undefined)[] = [];
  async load() {
    return this.index;
  }
  async read(key: string) {
    return this.payloads.get(key)!.slice();
  }
  async persist(batch: PersistenceBatch) {
    const nodes = new Map(this.index?.nodes.map((node) => [node.ino, node]));
    for (const node of batch.upserts) nodes.set(node.ino, node);
    for (const ino of batch.removes) nodes.delete(ino);
    for (const [key, data] of batch.data) this.payloads.set(key, data.slice());
    this.index = {
      version: 1,
      generation: batch.generation,
      root: batch.root,
      nodes: Array.from(nodes.values()),
    };
  }
  async flush(keys?: readonly string[]) {
    this.syncs.push(keys);
  }
  async close() {}
}

test("background checkpoints close-only; file sync and persisted save scope payload durability", async () => {
  const store = new Store();
  const backend = await PersistentBackend.open(store, { intervalMs: 0 });
  try {
    backend.execute("writeFile", ["/a"], new TextEncoder().encode("a"));
    backend.execute("writeFile", ["/b"], new TextEncoder().encode("b"));
    await backend.checkpoint();
    expect(store.syncs.length).toBe(0);
    await backend.flush("/a");
    const a = backend.fs.lookup("/a")!;
    const key = store.index!.nodes.find((node) => node.ino === a.ino)!.data!;
    expect(store.syncs).toEqual([[key]]);
    await backend.flush(backend.fs.handleForNode(a));
    expect(store.syncs.at(-1)).toEqual([key]);
    await backend.flush();
    expect(store.syncs.at(-1)).toBeUndefined();
  } finally {
    backend.dispose();
  }
});

test("failed payload fsync retries without rolling back an already committed generation", async () => {
  class FailingSync extends Store {
    fail = true;
    generations: number[] = [];
    override async persist(batch: PersistenceBatch) {
      this.generations.push(batch.generation);
      await super.persist(batch);
    }
    override async flush(keys?: readonly string[]) {
      if (this.fail) {
        this.fail = false;
        throw new Error("injected payload flush failure");
      }
      await super.flush(keys);
    }
  }
  const store = new FailingSync();
  const backend = await PersistentBackend.open(store, { intervalMs: 0 });
  try {
    backend.execute("writeFile", ["/a"], new TextEncoder().encode("first"));
    await expect(backend.flush("/a")).rejects.toThrow("injected payload flush failure");
    expect(store.generations).toEqual([1]);
    await backend.flush("/a");
    expect(store.generations).toEqual([1]);
    backend.execute("writeFile", ["/a"], new TextEncoder().encode("second"));
    await backend.flush("/a");
    expect(store.generations).toEqual([1, 2]);
    const key = store.index!.nodes.find((node) => node.kind === "file")!.data!;
    expect(new TextDecoder().decode(await store.read(key))).toBe("second");
  } finally {
    backend.dispose();
  }
});

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array) => new TextDecoder().decode(data);

/** Model payload collection too: detached bytes survive only through explicit runtime pins. */
class DetachedStore extends Store {
  batches: PersistenceBatch[] = [];
  reads = 0;
  fail = false;
  gate?: Promise<void>;
  onPersist?: (batch: PersistenceBatch) => void;
  override async read(key: string) {
    this.reads++;
    return super.read(key);
  }
  override async persist(batch: PersistenceBatch) {
    this.onPersist?.(batch);
    if (this.gate) await this.gate;
    if (this.fail) throw new Error("injected persist failure");
    await super.persist(batch);
    this.batches.push(batch);
    const live = new Set(
      this.index!.nodes.flatMap((node) => (node.data ? [node.data] : [])).concat(
        batch.retainedData ?? [],
      ),
    );
    for (const key of this.payloads.keys()) if (!live.has(key)) this.payloads.delete(key);
  }
}

function detach(backend: PersistentBackend, path: string): number {
  const handle = backend.fs.handleForNode(backend.fs.lookup(path)!);
  backend.retain(handle);
  expect(backend.execute("remove", [path], new Uint8Array())).toBe(true);
  return handle;
}

for (const persisted of [false, true])
  for (const checkpointRemoval of [false, true])
    test(`fd fsync persists dirty detached bytes without a name (${persisted ? "saved" : "never saved"}, ${checkpointRemoval ? "removal committed" : "removal pending"})`, async () => {
      const store = new DetachedStore();
      const backend = await PersistentBackend.open(store, { intervalMs: 0 });
      let handle: number | undefined;
      try {
        backend.execute("writeFile", ["/a"], encode("old"));
        if (persisted) await backend.checkpoint();
        handle = detach(backend, "/a");
        backend.execute("write", [handle, 0], encode("new"));
        if (checkpointRemoval) {
          // A background checkpoint must not copy detached bytes merely to remove their name.
          await backend.checkpoint();
          expect(store.batches.at(-1)!.data.size).toBe(0);
        }
        await backend.flush(handle);
        const keys = store.syncs.at(-1)!;
        expect(keys).toHaveLength(1);
        expect(decode(await store.read(keys[0]!))).toBe("new");
        expect(store.batches.at(-1)!.upserts.some((node) => node.kind === "file")).toBe(false);
        if (checkpointRemoval) expect(store.batches.at(-1)!.upserts).toHaveLength(0);
        expect(store.index!.nodes.some((node) => node.kind === "file")).toBe(false);
        const reopened = await PersistentBackend.open(store, { intervalMs: 0 });
        try {
          expect(reopened.fs.lookup("/a")).toBeUndefined();
        } finally {
          reopened.dispose();
        }
        // Future unrelated commits must keep the new detached payload pinned too.
        backend.execute("writeFile", ["/other"], encode("other"));
        await backend.checkpoint();
        expect(decode(await store.read(keys[0]!))).toBe("new");
      } finally {
        if (handle !== undefined) backend.release(handle);
        backend.dispose();
      }
    });

test("failed detached persistence retries the latest bytes without a namespace upsert", async () => {
  const store = new DetachedStore();
  const backend = await PersistentBackend.open(store, { intervalMs: 0 });
  let handle: number | undefined;
  try {
    backend.execute("writeFile", ["/a"], encode("old"));
    await backend.checkpoint();
    handle = detach(backend, "/a");
    await backend.checkpoint();
    backend.execute("write", [handle, 0], encode("new"));
    store.fail = true;
    await expect(backend.flush(handle)).rejects.toThrow("injected persist failure");
    expect(store.syncs).toHaveLength(0);
    store.fail = false;
    backend.execute("write", [handle, 0], encode("now"));
    await backend.flush(handle);
    expect(decode(await store.read(store.syncs.at(-1)![0]!))).toBe("now");
    expect(store.batches.at(-1)!.upserts).toHaveLength(0);
    expect(store.index!.nodes.some((node) => node.kind === "file")).toBe(false);
  } finally {
    if (handle !== undefined) backend.release(handle);
    backend.dispose();
  }
});

test("fd fsync captures only its detached file; workspace fsync captures every dirty detached file", async () => {
  const store = new DetachedStore();
  const backend = await PersistentBackend.open(store, { intervalMs: 0 });
  const handles: number[] = [];
  try {
    for (const path of ["/a", "/b"]) backend.execute("writeFile", [path], encode("old"));
    await backend.checkpoint();
    handles.push(detach(backend, "/a"), detach(backend, "/b"));
    await backend.checkpoint();
    backend.execute("write", [handles[0], 0], encode("aaa"));
    backend.execute("write", [handles[1], 0], encode("bbb"));
    await backend.flush(handles[0]);
    expect(Array.from(store.batches.at(-1)!.data.values(), decode)).toEqual(["aaa"]);
    expect(store.syncs.at(-1)).toHaveLength(1);
    const saved = store.syncs.at(-1)![0]!;
    await backend.flush();
    expect(Array.from(store.batches.at(-1)!.data.values(), decode)).toEqual(["bbb"]);
    expect(decode(await store.read(saved))).toBe("aaa");
    expect(store.syncs.at(-1)).toBeUndefined();
    expect(store.index!.nodes.some((node) => node.kind === "file")).toBe(false);
  } finally {
    for (const handle of handles) backend.release(handle);
    backend.dispose();
  }
});

test("fsync of an unchanged cold detached file flushes its existing key without hydration", async () => {
  const store = new DetachedStore();
  const initial = await PersistentBackend.open(store, { intervalMs: 0 });
  try {
    initial.execute("writeFile", ["/a"], encode("old"));
    await initial.checkpoint();
  } finally {
    initial.dispose();
  }
  const key = store.index!.nodes.find((node) => node.kind === "file")!.data!;
  const backend = await PersistentBackend.open(store, { intervalMs: 0 });
  let handle: number | undefined;
  try {
    handle = detach(backend, "/a");
    await backend.flush(handle);
    expect(store.syncs.at(-1)).toEqual([key]);
    expect(store.batches.at(-1)!.data.size).toBe(0);
    expect(store.reads).toBe(0);
    expect(backend.shared.isResident(handle)).toBe(false);
    await backend.flush(handle);
    expect(store.syncs.at(-1)).toEqual([key]);
    expect(store.reads).toBe(0);
  } finally {
    if (handle !== undefined) backend.release(handle);
    backend.dispose();
  }
});

for (const relink of [false, true])
  test(`detached fsync queued behind removal survives ${relink ? "relink" : "last close"} during persist`, async () => {
    const store = new DetachedStore();
    const backend = await PersistentBackend.open(store, { intervalMs: 0 });
    let handle: number | undefined;
    let release = () => {};
    const pending: Promise<void>[] = [];
    try {
      backend.execute("writeFile", ["/a"], encode("old"));
      await backend.checkpoint();
      handle = detach(backend, "/a");
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = Promise.withResolvers<void>();
      store.onPersist = (batch) => {
        if (batch.data.size) {
          store.gate = gate;
          started.resolve();
        }
      };
      const removal = backend.checkpoint();
      pending.push(removal);
      backend.execute("write", [handle, 0], encode("new"));
      const syncing = backend.flush(handle);
      pending.push(syncing);
      await started.promise;
      if (relink) {
        // A write after capture belongs to the next linked checkpoint, not this fd fsync.
        backend.execute("write", [handle, 0], encode("now"));
        const root = backend.execute("preopen", ["/"], new Uint8Array()) as number;
        const destination = backend.fs.resolve(root, "back");
        const source = {
          parent: undefined,
          name: "",
          node: handle,
          trailingSlash: false,
          terminalDot: false,
        };
        expect(backend.execute("link", [source, destination], new Uint8Array())).toBe(0);
      } else {
        backend.release(handle);
        handle = undefined;
      }
      release();
      await Promise.all(pending);
      store.gate = undefined;
      store.onPersist = undefined;
      expect(decode(await store.read(store.syncs.at(-1)![0]!))).toBe("new");
      expect(store.index!.nodes.some((node) => node.kind === "file")).toBe(false);
      backend.execute("mkdirp", ["/other"], new Uint8Array());
      await backend.flush();
      if (relink) {
        const key = store.index!.nodes.find((node) => node.kind === "file")!.data!;
        expect(decode(await store.read(key))).toBe("now");
        expect(backend.fs.lookup("/back")).toBeDefined();
      } else {
        expect(store.payloads.size).toBe(0);
        expect((backend as any).detachedKeys.size).toBe(0);
      }
    } finally {
      release();
      await Promise.allSettled(pending);
      if (handle !== undefined) backend.release(handle);
      backend.dispose();
    }
  });

test("service fd_sync forwards the checked file identity rather than flushing every file", async () => {
  class Observed extends MemoryBackend {
    syncs: (number | string | undefined)[] = [];
    async flush(target?: number | string) {
      this.syncs.push(target);
    }
  }
  const backend = new Observed();
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  try {
    const root = await client.asyncCall("preopen", ["/"]);
    await client.asyncCall("writeFile", ["/a"], new TextEncoder().encode("a"));
    const path = await client.asyncCall("resolve", [root, "a"]);
    expect(await client.asyncCall("sync", [path.node])).toBe(0);
    expect(backend.syncs).toEqual([path.node]);
  } finally {
    client.dispose();
    service.dispose();
  }
});

class CompletionGate {
  readonly entered = Promise.withResolvers<void>();
  readonly released = Promise.withResolvers<void>();
  async wait(): Promise<void> {
    this.entered.resolve();
    await this.released.promise;
  }
}

class CompletionStore extends Store {
  readonly persistGate = new CompletionGate();
  readonly flushGate = new CompletionGate();
  generations: number[] = [];
  events: string[] = [];
  holdFlush = false;
  persistError?: Error;
  flushError?: Error;
  closed = false;
  onClose?: () => Promise<void>;
  override async persist(batch: PersistenceBatch): Promise<void> {
    this.generations.push(batch.generation);
    const failure = this.persistError;
    if (!failure) await super.persist(batch);
    this.events.push("persist");
    await this.persistGate.wait();
    if (failure) throw failure;
  }
  override async flush(keys?: readonly string[]): Promise<void> {
    await super.flush(keys);
    if (this.holdFlush) await this.flushGate.wait();
    if (this.flushError) throw this.flushError;
    this.events.push("flush");
  }
  override async close(): Promise<void> {
    this.events.push("close");
    this.closed = true;
    await this.onClose?.();
  }
}

type TrackCompletion = (promise: Promise<void>) => Promise<void>;
async function withCompletionStore(
  run: (
    store: CompletionStore,
    backend: PersistentBackend,
    track: TrackCompletion,
  ) => Promise<void>,
): Promise<void> {
  const store = new CompletionStore();
  const backend = await PersistentBackend.open(store, { intervalMs: 0 });
  const pending: Promise<void>[] = [];
  const track: TrackCompletion = (promise) => {
    void promise.catch(() => {});
    pending.push(promise);
    return promise;
  };
  try {
    await run(store, backend, track);
  } finally {
    store.persistGate.released.resolve();
    store.flushGate.released.resolve();
    await Promise.allSettled(pending);
    backend.dispose();
    if (!store.closed) await store.close();
  }
}

async function expectSaved(store: Store, path: string, text: string): Promise<void> {
  const reopened = await PersistentBackend.open(store, { intervalMs: 0 });
  try {
    await reopened.prepare("readFile", [path]);
    expect(reopened.execute("readFile", [path], new Uint8Array())).toEqual(encode(text));
  } finally {
    reopened.dispose();
  }
}

const closedPersistence = "filesystem persistence backend is closed";

test("disposed checkpoint rejects a persist completion that already reached storage", async () => {
  await withCompletionStore(async (store, backend, track) => {
    backend.execute("writeFile", ["/checkpoint"], encode("saved"));
    const saving = track(backend.flush());
    await store.persistGate.entered.promise;
    backend.dispose();
    store.persistGate.released.resolve();
    await Promise.allSettled([saving]);
    await expect(saving, `payload flushes after disposal: ${store.syncs.length}`).rejects.toThrow(
      closedPersistence,
    );
    expect(store.syncs).toEqual([]);
    await expectSaved(store, "/checkpoint", "saved");
  });
});

test("live checkpoint completes its held persist response and requested barrier", async () => {
  await withCompletionStore(async (store, backend, track) => {
    backend.execute("writeFile", ["/checkpoint"], encode("saved"));
    const saving = track(backend.flush());
    await store.persistGate.entered.promise;
    expect(store.syncs).toEqual([]);
    store.persistGate.released.resolve();
    await saving;
    expect(store.syncs).toEqual([undefined]);
    backend.dispose();
    await expectSaved(store, "/checkpoint", "saved");
  });
});

for (const failure of [undefined, new Error("held payload failure")])
  test(`disposed file flush preserves ${failure ? "the storage failure" : "closed rejection"}`, async () => {
    await withCompletionStore(async (store, backend, track) => {
      store.persistGate.released.resolve();
      store.holdFlush = true;
      store.flushError = failure;
      backend.execute("writeFile", ["/checkpoint"], encode("saved"));
      const saving = track(backend.flush("/checkpoint"));
      await store.flushGate.entered.promise;
      backend.dispose();
      store.flushGate.released.resolve();
      if (failure) await expect(saving).rejects.toBe(failure);
      else await expect(saving).rejects.toThrow(closedPersistence);
      expect(store.generations).toEqual([1]);
      expect(store.syncs).toHaveLength(1);
      expect(store.syncs[0]).toHaveLength(1);
      await expectSaved(store, "/checkpoint", "saved");
    });
  });

test("disposed no-change flush rejects after its only payload barrier", async () => {
  await withCompletionStore(async (store, backend, track) => {
    store.persistGate.released.resolve();
    backend.execute("writeFile", ["/checkpoint"], encode("saved"));
    await backend.checkpoint();
    store.holdFlush = true;
    const saving = track(backend.flush());
    await store.flushGate.entered.promise;
    backend.dispose();
    store.flushGate.released.resolve();
    await expect(saving).rejects.toThrow(closedPersistence);
    expect(store.generations).toEqual([1]);
    expect(store.syncs).toEqual([undefined]);
  });
});

test("disposed no-change checkpoint rejects behind a held changed checkpoint", async () => {
  await withCompletionStore(async (store, backend, track) => {
    backend.execute("writeFile", ["/checkpoint"], encode("saved"));
    const changed = track(backend.checkpoint());
    await store.persistGate.entered.promise;
    const unchanged = track(backend.checkpoint());
    backend.dispose();
    store.persistGate.released.resolve();
    await expect(changed).rejects.toThrow(closedPersistence);
    await expect(unchanged).rejects.toThrow(closedPersistence);
    expect(store.generations).toEqual([1]);
    expect(store.syncs).toEqual([]);
  });
});

test("disposal rejects all queued captures without starting later storage work", async () => {
  await withCompletionStore(async (store, backend, track) => {
    backend.execute("writeFile", ["/first"], encode("first"));
    const first = track(backend.flush());
    await store.persistGate.entered.promise;
    backend.execute("writeFile", ["/later"], encode("later"));
    const second = track(backend.checkpoint());
    backend.execute("writeFile", ["/last"], encode("last"));
    const third = track(backend.flush());
    backend.dispose();
    store.persistGate.released.resolve();
    for (const pending of [first, second, third])
      await expect(pending).rejects.toThrow(closedPersistence);
    await expect(backend.checkpoint()).rejects.toThrow(closedPersistence);
    expect(store.generations).toEqual([1]);
    expect(store.syncs).toEqual([]);
  });
});

for (const disposed of [false, true])
  test(`persist failure keeps its original error while ${disposed ? "disposed" : "live retry restores queued dirty captures"}`, async () => {
    await withCompletionStore(async (store, backend, track) => {
      const failure = new Error("held persist failure");
      store.persistError = failure;
      backend.execute("writeFile", ["/first"], encode("first"));
      const first = track(backend.checkpoint());
      await store.persistGate.entered.promise;
      backend.execute("writeFile", ["/first"], encode("now"));
      backend.execute("writeFile", ["/later"], encode("later"));
      const second = track(backend.checkpoint());
      if (disposed) backend.dispose();
      store.persistGate.released.resolve();
      await expect(first).rejects.toBe(failure);
      await expect(second).rejects.toThrow(
        disposed ? closedPersistence : "invalidated by a failed commit",
      );
      expect(store.generations).toEqual([1]);
      if (disposed) return;
      store.persistError = undefined;
      await backend.flush();
      expect(store.generations).toEqual([1, 1]);
      backend.dispose();
      await expectSaved(store, "/first", "now");
      await expectSaved(store, "/later", "later");
    });
  });

test("earlier payload barrier survives a later live persist failure", async () => {
  await withCompletionStore(async (store, backend, track) => {
    store.persistGate.released.resolve();
    store.holdFlush = true;
    backend.execute("writeFile", ["/checkpoint"], encode("first"));
    const earlier = track(backend.flush("/checkpoint"));
    await store.flushGate.entered.promise;
    const failure = new Error("later persist failure");
    store.persistError = failure;
    backend.execute("writeFile", ["/checkpoint"], encode("latest"));
    await expect(track(backend.checkpoint())).rejects.toBe(failure);
    store.flushGate.released.resolve();
    await earlier;
    expect(store.generations).toEqual([1, 2]);
    expect(store.syncs).toHaveLength(1);
    store.persistError = undefined;
    await backend.flush();
    expect(store.generations).toEqual([1, 2, 2]);
    backend.dispose();
    await expectSaved(store, "/checkpoint", "latest");
  });
});

test("ordinary close saves then disposes before closing storage", async () => {
  await withCompletionStore(async (store, backend, track) => {
    store.persistGate.released.resolve();
    backend.execute("writeFile", ["/checkpoint"], encode("saved"));
    store.onClose = async () => {
      await expect(backend.checkpoint()).rejects.toThrow(closedPersistence);
    };
    await track(backend.close());
    expect(store.events).toEqual(["persist", "flush", "close"]);
    expect(store.closed).toBe(true);
    expect(store.generations).toEqual([1]);
    expect(store.syncs).toEqual([undefined]);
  });
});
