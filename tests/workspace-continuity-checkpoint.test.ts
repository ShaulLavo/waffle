import { expect, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent";
import { FilesystemClient, FilesystemService, createFilesystemConnection } from "../fs";
import { nextReservation } from "../fs/file-identity";
import { fixturePayloadHooks } from "./fixtures/publication-storage";
import { snapshotBatch, type PersistenceBatch, type StorageBackend } from "../fs/storage";

async function check(publication: boolean): Promise<void> {
  const payloads = new Map<string, Uint8Array>();
  let persisted = 0;
  let selected: PersistenceBatch | undefined;
  let peakMetadataBytes = 0;
  const storage: StorageBackend = {
    async reserveIdentity(workspace) {
      return nextReservation(undefined, workspace);
    },
    async load() {
      return undefined;
    },
    async read(key) {
      return new Uint8Array(payloads.get(key));
    },
    ...fixturePayloadHooks(payloads),
    async persist(batch: PersistenceBatch) {
      const pressure = backend.checkpointPressure();
      expect(pressure.pendingOperations).toBe(1);
      expect(pressure.pendingMetadataBytes).toBeLessThanOrEqual(pressure.limits.maxMetadataBytes);
      peakMetadataBytes = Math.max(peakMetadataBytes, pressure.pendingMetadataBytes);
      const owned = snapshotBatch(batch);
      selected = owned;
      for (const [key, bytes] of owned.data) payloads.set(key, bytes);
      persisted++;
    },
    async flush() {},
    async close() {},
  };
  const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(
    undefined,
    publication ? { workspace: true } : undefined,
  );
  const client = new FilesystemClient(connection.client);
  service.connect(connection.server);
  try {
    for (let value = 1; value <= 40; value++) {
      await client.asyncCall("writeFile", ["/file"], new Uint8Array(65536).fill(value));
      expect(backend.checkpointPressure().pendingOperations).toBe(0);
      await backend.flush();
    }
    expect(persisted).toBe(40);
    expect(backend.checkpointPressure()).toMatchObject({
      pendingOperations: 0,
      pendingBytes: 0,
      pendingMetadataBytes: 0,
      rejected: 0,
    });
    expect(backend.shared.dirtyAdmission.diagnostics(0)).toMatchObject({
      immutableMetadataUnits: 0,
      pendingOperations: 0,
    });
    const domain = backend.shared.publication;
    const saved = selected?.publication;
    if (!publication) {
      expect(saved).toBeUndefined();
      return;
    }
    if (!domain || !saved) throw new Error("publication checkpoint absent");
    expect(saved.cut).toEqual(domain.cut());
    expect(saved.sessionSerial).toBe(domain.buffers.sessionLimit);
    const live = domain.checkpoint();
    expect(live.changes).toHaveLength(32);
    expect(saved.changes.length).toBeGreaterThan(0);
    expect(saved.changes.length).toBeLessThan(live.changes.length);
    expect(saved.changes).toEqual(live.changes.slice(-saved.changes.length));
    expect(saved.receipts).toEqual(live.receipts);
    expect(saved.contentVersions).toEqual(live.contentVersions);
    expect(domain.checkpointMetadataBytes() * 4).toBeGreaterThan(
      backend.checkpointPressure().limits.maxMetadataBytes,
    );
    console.log(
      JSON.stringify({
        writes: persisted,
        peakMetadataBytes,
        retainedChanges: saved.changes.length,
        liveChanges: live.changes.length,
        liveMetadataBytes: domain.checkpointMetadataBytes() * 4,
      }),
    );
  } finally {
    client.dispose();
    service.dispose();
    backend.dispose();
    await storage.close();
  }
}

test("default publication checkpoints keep making progress", () => check(true));
test("default nonpublication checkpoints keep making progress", () => check(false));
