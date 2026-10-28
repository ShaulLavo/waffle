// A blocking descriptor read that meets another owner's shared global lock waits for it.
// The lock is held by a real second thread, taken between readMetadata's stat() and identity(),
// which is where browser `next build` saw EAGAIN on waffle 0.0.90.
import { afterEach, expect, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent";
import { FilesystemClient } from "../fs/client";
import { FilesystemService } from "../fs/service";
import {
  connectFilesystemIdentity,
  createFilesystemConnection,
  createProcessFilesystemIdentity,
  State,
  type FilesystemConnection,
} from "../fs/protocol";
import { nextReservation, storeReservation, type StoredReservation } from "../fs/file-identity";
import {
  snapshotBatch,
  type PersistedIndex,
  type PersistenceBatch,
  type StorageBackend,
} from "../fs/storage";
import { fixturePayloadHooks } from "./fixtures/publication-storage";

const HOLD_MS = 150;

class Storage implements StorageBackend {
  private reservation?: StoredReservation;
  readonly bytes = new Map<string, Uint8Array>([["cold-key", new Uint8Array([1, 2, 3, 4])]]);
  readRange = fixturePayloadHooks(this.bytes).readRange;
  retainPayload = fixturePayloadHooks(this.bytes).retainPayload;
  index: PersistedIndex = {
    version: 1,
    generation: 1,
    root: 1,
    nodes: [
      { ino: 1, kind: "dir", size: 0, mode: 0o700, mtime: 1, children: [["cold", 2]] },
      { ino: 2, kind: "file", size: 4, mode: 0o600, mtime: 1, data: "cold-key" },
    ],
  };
  async reserveIdentity(workspace?: string) {
    const value = nextReservation(this.reservation, workspace);
    this.reservation = storeReservation(value);
    return value;
  }
  async load() {
    return this.index;
  }
  async read(key: string) {
    return this.bytes.get(key)!.slice();
  }
  async persist(input: PersistenceBatch) {
    for (const [key, bytes] of snapshotBatch(input).data) this.bytes.set(key, bytes);
  }
  async flush() {}
  async close() {}
}

const workers: Worker[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) worker.terminate();
});

interface Fixture {
  backend: PersistentBackend;
  service: FilesystemService;
  client: FilesystemClient;
  connection: FilesystemConnection;
  handle: number;
}

async function cold(
  run: (fixture: Fixture) => Promise<void>,
  options: NonNullable<Parameters<typeof PersistentBackend.open>[1]> = {},
) {
  const backend = await PersistentBackend.open(new Storage(), { intervalMs: 0, ...options });
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  try {
    const root = await client.asyncCall("preopen", ["/"]);
    const handle: number = (await client.asyncCall("resolve", [root, "cold"])).node;
    client.retain(handle);
    await run({ backend, service, client, connection: pair.client, handle });
    // No request, preparation or timer outlives the test's own work.
    await service.drainForOwner();
  } finally {
    client.dispose();
    service.dispose();
    await Promise.allSettled([backend.close()]);
    backend.dispose();
  }
}

interface Hold {
  owner: number;
  holdMs?: number;
  signal?: { buffer: SharedArrayBuffer; index: number; value: number; afterMs: number };
  keep?: boolean;
  secondSignal?: {
    buffer: SharedArrayBuffer;
    index: number;
    value: number;
    afterMs: number;
    sections?: SharedArrayBuffer;
  };
}

/** The next shared.stat() call returns only after another thread holds the global lock. */
function contendAfterStat(backend: PersistentBackend, hold: Hold, skip = 0) {
  const worker = new Worker(new URL("./fixtures/global-lock-holder.ts", import.meta.url).href);
  workers.push(worker);
  const control = new Int32Array(new SharedArrayBuffer(12));
  worker.postMessage({
    cells: backend.shared.cells.buffer,
    control: control.buffer,
    holdMs: HOLD_MS,
    ...hold,
  });
  const shared = backend.shared;
  const stat = shared.stat;
  shared.stat = (...args) => {
    if (skip-- > 0) return stat.apply(shared, args);
    shared.stat = stat;
    const result = stat.apply(shared, args);
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
    Atomics.wait(control, 1, 0, 5000);
    return result;
  };
  return {
    held: () => Atomics.load(control, 1) !== 0,
    released: () => Atomics.load(control, 1) === 2,
    async waitReleased() {
      while (Atomics.load(control, 1) !== 2) await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
}

const outcome = (work: Promise<unknown>) =>
  work.then(
    (value) => ({ value: Array.from(value as Uint8Array) }),
    (error: { errno?: number }) => ({ errno: error.errno }),
  );

test("a blocking read waits for another owner's global lock, then reads", async () => {
  await cold(async ({ backend, client, connection, handle }) => {
    const lock = contendAfterStat(backend, { owner: connection.owner });
    const started = performance.now();
    const result = await outcome(client.asyncCall("read", [handle, 4, 0]));
    expect(lock.held()).toBe(true);
    expect(result).toEqual({ value: [1, 2, 3, 4] });
    // It progressed only after the other owner released the lock, not by failing early.
    expect(lock.released()).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(HOLD_MS - 20);
    expect(Atomics.load(backend.shared.cells, 1)).toBe(0);
  });
});

test("cancelling a read while it waits for the lock ends it Cancelled, not EAGAIN", async () => {
  await cold(async ({ backend, client, connection, handle }) => {
    const completion = client.submit("read", [handle, 4, 0]);
    const lock = contendAfterStat(backend, {
      owner: connection.owner,
      holdMs: 2000,
      // Another thread cancels the request while the service waits.
      signal: { buffer: completion.buffer, index: 6, value: 1, afterMs: 20 },
    });
    const started = performance.now();
    const result = await outcome(completion.value().finally(() => completion.release()));
    expect(result).toEqual({ errno: 11 });
    expect(completion.cells[0]).toBe(State.Cancelled);
    // The wait ended on cancellation, well before the holder released.
    expect(lock.released()).toBe(false);
    expect(performance.now() - started).toBeLessThan(1500);
    await lock.waitReleased();
    expect(await outcome(client.asyncCall("read", [handle, 4, 0]))).toEqual({
      value: [1, 2, 3, 4],
    });
  });
});

// The contention sweep closes the revoked session, and that close takes the same lock, so the
// request ends when the holder releases. It must end Cancelled, never Failed with EAGAIN.
test("revoking the reader while it waits ends its request Cancelled", async () => {
  await cold(async ({ backend, client, connection, handle }) => {
    const completion = client.submit("read", [handle, 4, 0]);
    const lock = contendAfterStat(backend, {
      owner: 77,
      holdMs: 2000,
      signal: { buffer: connection.ownerStates, index: 0, value: 1, afterMs: 20 },
    });
    expect(await outcome(completion.value())).toEqual({ errno: 11 });
    expect(completion.cells[0]).toBe(State.Cancelled);
    await lock.waitReleased();
  });
});

test("a holder that dies with the lock is reclaimed and the waiting read proceeds", async () => {
  await cold(async ({ backend, service, client, handle }) => {
    const peer = connectFilesystemIdentity(createProcessFilesystemIdentity(client.connection));
    service.connect(peer.server);
    contendAfterStat(backend, {
      owner: peer.client.owner,
      keep: true,
      // Proven dead: the contention sweep may now take this owner's locks back.
      signal: { buffer: peer.client.revocations[0]!, index: 0, value: 2, afterMs: 20 },
    });
    expect(await outcome(client.asyncCall("read", [handle, 4, 0]))).toEqual({
      value: [1, 2, 3, 4],
    });
    expect(Atomics.load(backend.shared.cells, 1)).toBe(0);
    peer.server.port.close();
    peer.client.port.close();
  });
});

test("nonblocking reads still return EAGAIN at once under the same contention", async () => {
  await cold(async ({ backend, client, connection, handle }) => {
    // The service shares this thread, so hold the lock only across the synchronous call.
    Atomics.store(backend.shared.cells, 1, connection.owner);
    let immediate: number;
    try {
      immediate = client.tryRead(handle, [new Uint8Array(4)], 0);
    } finally {
      Atomics.store(backend.shared.cells, 1, 0);
    }
    expect(immediate).toBe(-6);
    while (!client.ioReadiness(handle, false).readable)
      await new Promise((resolve) => setTimeout(resolve, 1));
    const bytes = new Uint8Array(4);
    expect(client.tryRead(handle, [bytes], 0)).toBe(4);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });
});

test("a permanent dirty-capacity errno 6 is still terminal, not waited on", async () => {
  await cold(
    async ({ client, handle }) => {
      await client.asyncCall("resize", [handle, 0, true]);
      const started = performance.now();
      expect(await outcome(client.asyncCall("write", [handle, 0], new Uint8Array(17)))).toEqual({
        errno: 6,
      });
      expect(performance.now() - started).toBeLessThan(HOLD_MS);
    },
    { checkpointLimits: { maxBytes: 32, maxMetadataBytes: 65536 } },
  );
});

test("revoked reader cleanup still recovers a holder that dies later", async () => {
  await cold(async ({ backend, service, client, connection, handle }) => {
    const peer = connectFilesystemIdentity(createProcessFilesystemIdentity(client.connection));
    service.connect(peer.server);
    // A real holder is admitted before taking locks. Reap may leave this count abandoned.
    Atomics.store(new Int32Array(peer.client.sections), 0, 1);
    try {
      const lock = contendAfterStat(backend, {
        owner: peer.client.owner,
        holdMs: 800,
        signal: { buffer: connection.ownerStates, index: 0, value: 1, afterMs: 20 },
        secondSignal: {
          buffer: peer.client.revocations[0]!,
          index: 0,
          value: 2,
          afterMs: 80,
          sections: peer.client.sections,
        },
      });
      const started = performance.now();
      expect(await outcome(client.asyncCall("read", [handle, 4, 0]))).toEqual({ errno: 11 });
      // The holder is reported dead after 100ms. Its 800ms fallback must not be needed.
      expect(lock.released()).toBe(false);
      expect(performance.now() - started).toBeLessThan(500);
    } finally {
      peer.server.port.close();
      peer.client.port.close();
    }
  });
});

test("second readMetadata identity wait observes request cancellation", async () => {
  await cold(async ({ backend, client, connection, handle }) => {
    const completion = client.submit("read", [handle, 4, 0]);
    const lock = contendAfterStat(
      backend,
      {
        owner: connection.owner,
        holdMs: 800,
        signal: { buffer: completion.buffer, index: 6, value: 1, afterMs: 20 },
      },
      1,
    );
    const started = performance.now();
    expect(await outcome(completion.value().finally(() => completion.release()))).toEqual({
      errno: 11,
    });
    expect(lock.released()).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
    await lock.waitReleased();
  });
});
