import { expect, spyOn, test } from "bun:test";
import { FilesystemService } from "../fs/service";
import { MemoryBudget, type MemoryBackingSpec } from "../fs/memory-budget";
import { OpfsStorage } from "../fs/opfs";
import { PersistentBackend } from "../fs/persistent";
import { PublicationDomain } from "../fs/publication";
import { ResidentConstruction } from "../fs/root-construction";
import { identityOpfsFixture } from "./fixtures/durable-identity-opfs";
import { publicationAdapter } from "./indexeddb-publication-browser";
import type { CheckpointPublication } from "../fs/storage";

function authority(failAt = Infinity) {
  const specs: MemoryBackingSpec[] = [];
  const failure = new Error("partial restored publication allocation");
  const memory = new MemoryBudget(
    {
      bytes: 64 * 1024 * 1024,
      producers: { allocations: 128, references: 256, leases: 16 },
      progress: { bytes: 0, allocations: 0, references: 0, leases: 0 },
      waiters: 0,
      serialLimit: Number.MAX_SAFE_INTEGER,
    },
    {
      allocate(spec) {
        specs.push(spec);
        if (specs.length === failAt) throw failure;
        if (spec.kind !== "shared") throw new Error("unexpected backing kind");
        return new SharedArrayBuffer(spec.bytes, { maxByteLength: spec.maximum });
      },
      grow() {
        throw new Error("fixed construction must not grow");
      },
    },
  );
  return { memory, specs, failure };
}
async function restored(
  seed: CheckpointPublication,
  native = identityOpfsFixture(),
  failAt = Infinity,
) {
  const ledger = authority(failAt);
  const construction = new ResidentConstruction(
    ledger.memory,
    { limits: seed.limits, observe: true },
    () => {},
  );
  const storage = await OpfsStorage.open("root-continuity", {
    root: native.root,
    locks: native.locks,
  });
  const backend = await PersistentBackend.open(storage, {
    intervalMs: 0,
    startupRoot: ledger.memory,
  });
  return {
    ...ledger,
    native,
    construction,
    backend,
    storage,
    async close() {
      backend.dispose();
      construction.dispose();
      await storage.close();
    },
  };
}

test("late selected checkpoint uses the real restored root and one canonical ledger", async () => {
  const saved = publicationAdapter.fixture();
  const first = await restored(saved);
  const rootBacking = first.backend.shared.buffer;
  const before = first.memory.snapshot();
  try {
    const pair = first.construction.attach(first.backend, saved);
    const publication = pair.root.connection.publication;
    if (!publication) throw new Error("restored publication absent");
    expect(publication.buffers.history).toBe(saved.cut.history);
    expect(pair.root.connection.shared).toBe(rootBacking);
    expect(first.backend.shared.buffer).toBe(rootBacking);
    expect(first.specs).toHaveLength(117);
    expect(first.specs.filter((spec) => spec.bytes > 1024 * 1024)).toHaveLength(1);
    expect(first.memory.snapshot().obligations).toBe(0);
    expect(first.memory.snapshot().producerFree.allocations).toBe(before.producerFree.allocations);
    const domain = first.backend.shared.publication;
    if (!domain) throw new Error("backend publication absent");
    expect(domain.cut()).toEqual(saved.cut);
    for (const receipt of saved.receipts)
      expect(domain.lookupAny(receipt.id)).toEqual({ kind: "committed", receipt });
    expect(publication.session.serial).toBeGreaterThan(saved.sessionSerial);
    expect(publication.buffers.sessionLimit).toBe(saved.sessionSerial + 65536);
    await pair.root.asyncCall("writeFile", ["/persisted"], new Uint8Array([7, 8, 9]));
    await first.backend.flush();
    const next = domain.checkpoint();
    await first.close();
    const second = await restored(next, first.native);
    try {
      const actual = second.backend.shared.buffer;
      const attached = second.construction.attach(second.backend, next);
      expect(attached.root.connection.shared).toBe(actual);
      expect(await attached.root.asyncCall("readFile", ["/persisted"])).toEqual(
        new Uint8Array([7, 8, 9]),
      );
      expect(attached.root.connection.publication?.session.serial).toBeGreaterThan(
        publication.buffers.sessionLimit,
      );
      expect(second.specs).toHaveLength(117);
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
});

test("late restore rejects limits and exhausted frontier without publishing or leaking private reservations", async () => {
  const seed = publicationAdapter.fixture();
  for (const checkpoint of [
    { ...seed, limits: { ...seed.limits, sessions: seed.limits.sessions + 1 } },
    { ...seed, sessionSerial: 0x7ffffffe },
  ]) {
    const owned = await restored(seed);
    const rootOnly = owned.memory.snapshot().backingBytes;
    const connect = spyOn(FilesystemService.prototype, "connect");
    try {
      expect(() => owned.construction.attach(owned.backend, checkpoint)).toThrow();
      expect(connect).not.toHaveBeenCalled();
      owned.construction.dispose();
      expect(owned.memory.snapshot().backingBytes).toBe(rootOnly);
      expect(owned.memory.snapshot().obligations).toBe(0);
    } finally {
      connect.mockRestore();
      await owned.close();
    }
  }
});

test("partial restored allocation releases private fixed backing while escaped restored sessions remain charged", async () => {
  const seed = publicationAdapter.fixture();
  const privateOwner = await restored(seed, undefined, 75);
  const rootOnly = privateOwner.memory.snapshot().allocated;
  try {
    expect(() => privateOwner.construction.attach(privateOwner.backend, seed)).toThrow(
      privateOwner.failure,
    );
    privateOwner.construction.dispose();
    expect(privateOwner.memory.snapshot().obligations).toBe(0);
    expect(privateOwner.memory.snapshot().allocated).toBe(rootOnly);
  } finally {
    await privateOwner.close();
  }
  const escaped = await restored(seed);
  const failure = new Error("restored session escaped then attachment threw");
  let session = 0;
  const connect = spyOn(FilesystemService.prototype, "connect").mockImplementation((connection) => {
    if (!connection.publication) throw new Error("publication absent at escape");
    session = new PublicationDomain(connection.publication.buffers).openSession().serial;
    throw failure;
  });
  try {
    expect(() => escaped.construction.attach(escaped.backend, seed)).toThrow(failure);
    expect(session).toBeGreaterThan(seed.sessionSerial);
    const published = escaped.memory.snapshot();
    await escaped.close();
    expect(escaped.memory.snapshot()).toEqual(published);
    expect(published.obligations).toBe(0);
  } finally {
    connect.mockRestore();
    await escaped.close();
  }
});

test("the last reserved restored session fails closed before any arena mutation", async () => {
  const seed = { ...publicationAdapter.fixture(), sessionSerial: 0x7ffffffd };
  const owned = await restored(seed);
  try {
    const pair = owned.construction.attach(owned.backend, seed);
    const publication = pair.root.connection.publication;
    if (!publication) throw new Error("publication absent");
    expect(publication.session.serial).toBe(0x7ffffffe);
    const domain = new PublicationDomain(publication.buffers);
    const buffers = [
      publication.buffers.control,
      publication.buffers.sessions,
      publication.buffers.operations,
    ];
    const before = buffers.map((buffer) => Array.from(new Uint8Array(buffer)));
    const ledger = owned.memory.snapshot();
    expect(() => domain.openSession()).toThrow();
    expect(buffers.map((buffer) => Array.from(new Uint8Array(buffer)))).toEqual(before);
    expect(owned.memory.snapshot()).toEqual(ledger);
  } finally {
    await owned.close();
  }
});
