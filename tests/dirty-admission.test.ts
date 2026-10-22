import { expect, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent";
import { FilesystemClient } from "../fs/client";
import { FilesystemService } from "../fs/service";
import { createFilesystemConnection } from "../fs/protocol";
import {
  snapshotBatch,
  type PersistedIndex,
  type PersistenceBatch,
  type StorageBackend,
} from "../fs/storage";

class ControlledStorage implements StorageBackend {
  index?: PersistedIndex;
  readonly bytes = new Map<string, Uint8Array>();
  readonly entered = Promise.withResolvers<void>();
  readonly released = Promise.withResolvers<void>();
  hold = false;
  failure?: Error;
  async load() {
    return this.index;
  }
  async read(key: string) {
    return this.bytes.get(key)!.slice();
  }
  async persist(input: PersistenceBatch) {
    const batch = snapshotBatch(input);
    this.entered.resolve();
    if (this.hold) await this.released.promise;
    if (this.failure) throw this.failure;
    const nodes = new Map(this.index?.nodes.map((node) => [node.ino, node]));
    for (const node of batch.upserts) nodes.set(node.ino, node);
    for (const ino of batch.removes) nodes.delete(ino);
    for (const [key, data] of batch.data) this.bytes.set(key, data);
    this.index = {
      version: 1,
      generation: batch.generation,
      root: batch.root,
      nodes: Array.from(nodes.values()),
    };
  }
  async flush() {}
  async close() {}
}

async function fixture(
  run: (
    backend: PersistentBackend,
    client: FilesystemClient,
    handle: number,
    storage: ControlledStorage,
  ) => Promise<void>,
) {
  const storage = new ControlledStorage();
  const backend = await PersistentBackend.open(storage, {
    intervalMs: 0,
    checkpointLimits: { maxBytes: 16, maxMetadataBytes: 65536 },
  });
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  try {
    await client.asyncCall("writeFile", ["/file"], new Uint8Array(4).fill(65));
    const root = await client.asyncCall("preopen", ["/"]);
    const path = await client.asyncCall("resolve", [root, "file"]);
    client.retain(path.node);
    await backend.checkpoint(true);
    await run(backend, client, path.node, storage);
  } finally {
    storage.released.resolve();
    client.dispose();
    service.dispose();
    await Promise.allSettled([backend.close()]);
  }
}

test("actual direct guest growth cannot create an unsaveable dirty cut", async () => {
  await fixture(async (backend, client, handle) => {
    const before = backend.shared.snapshot(handle);
    expect(client.tryWrite(handle, [new Uint8Array(9).fill(90)], 0)).toBe(-6);
    expect(backend.shared.snapshot(handle)).toEqual(before);
    await backend.checkpoint(true);
  });
});
