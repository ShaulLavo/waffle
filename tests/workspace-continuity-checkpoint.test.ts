import { expect, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent";
import { FilesystemClient, FilesystemService, createFilesystemConnection } from "../fs";
import { nextReservation } from "../fs/file-identity";
import { fixturePayloadHooks } from "./fixtures/publication-storage";
import { snapshotBatch, type PersistenceBatch, type StorageBackend } from "../fs/storage";

async function check(publication: boolean): Promise<void> {
  const payloads = new Map<string, Uint8Array>();
  let persisted = 0;
  const storage: StorageBackend = {
    async reserveIdentity(workspace) { return nextReservation(undefined, workspace); },
    async load() { return undefined; },
    async read(key) { return new Uint8Array(payloads.get(key)); },
    ...fixturePayloadHooks(payloads),
    async persist(batch: PersistenceBatch) {
      const owned = snapshotBatch(batch);
      for (const [key, bytes] of owned.data) payloads.set(key, bytes);
      persisted++;
    },
    async flush() {},
    async close() {},
  };
  const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, publication ? { workspace: true } : undefined);
  const client = new FilesystemClient(connection.client);
  service.connect(connection.server);
  try {
    for (let value = 1; value <= 2; value++) {
      await client.asyncCall("writeFile", ["/file"], new Uint8Array(65536).fill(value));
      console.log(JSON.stringify({ publication, write: value, persisted,
        checkpointMetadataBytes: backend.shared.publication?.checkpointMetadataBytes(),
        pressure: backend.checkpointPressure() }));
      await backend.flush();
    }
    expect(persisted).toBe(2);
  } finally {
    client.dispose();
    service.dispose();
    backend.dispose();
    await storage.close();
  }
}

test("default publication checkpoints keep making progress", () => check(true));
test("default nonpublication checkpoints keep making progress", () => check(false));
