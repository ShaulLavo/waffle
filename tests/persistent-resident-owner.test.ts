import { expect, test } from "bun:test";
import { FilesystemClient } from "../fs/client";
import { PersistentBackend } from "../fs/persistent";
import { FilesystemService } from "../fs/service";
import { createFilesystemConnection, isRevoked, revokeFilesystem } from "../fs/protocol";
import type { PublicationLimits } from "../fs/publication-internal";

const limits: PublicationLimits = {
  sessions: 16,
  operations: 16,
  inputBytes: 64,
  argumentBytes: 512,
  effectBytes: 4096,
  effects: 16,
  resultBytes: 256,
  logRecords: 8,
  logBytes: 32768,
  pins: 2,
  pinBytes: 256,
};
async function fixture(kind: "read" | "flush") {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const backend = await PersistentBackend.open(
    {
      async load() {
        return {
          version: 1,
          generation: 1,
          root: 10,
          nodes: [
            { ino: 10, kind: "dir", mode: 0o700, size: 0, mtime: 1, children: [["file", 11]] },
            { ino: 11, kind: "file", mode: 0o400, size: 4, mtime: 1, data: "payload" },
          ],
        };
      },
      async read() {
        if (kind === "read") {
          started.resolve();
          await release.promise;
        }
        return new Uint8Array([1, 2, 3, 4]);
      },
      async persist() {},
      async flush() {
        if (kind === "flush") {
          started.resolve();
          await release.promise;
        }
      },
      async close() {},
    },
    { intervalMs: 0 },
  );
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, { limits, observe: true });
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  const root: number = await client.asyncCall("preopen", ["/"]);
  const file: { node: number } = await client.asyncCall("resolve", [root, "file"]);
  client.retain(file.node);
  return {
    backend,
    service,
    client,
    handle: file.node,
    started: started.promise,
    release: () => release.resolve(),
    close() {
      release.resolve();
      backend.dispose();
      client.dispose();
      service.dispose();
    },
  };
}
async function assertPending(promise: Promise<void>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
}

test("owner drain retains a cold preparation after revocation sweeps its actual session", async () => {
  const owned = await fixture("read");
  try {
    const read = owned.client.asyncCall("read", [owned.handle, 4, 0]).catch(() => "cancelled");
    await owned.started;
    revokeFilesystem(owned.client.connection);
    owned.service.sweep();
    const draining = owned.service.drainForOwner();
    expect(owned.service.drainForOwner()).toBe(draining);
    await assertPending(draining);
    owned.release();
    await draining;
    await read;
    expect(owned.service.resources().clients).toBe(0);
    expect(owned.backend.shared.publication!.stopped).toBe(false);
    await owned.backend.flush();
  } finally {
    owned.close();
  }
});

test("owner drain joins a detached checkpoint and keeps the domain live for final save", async () => {
  const owned = await fixture("flush");
  try {
    const barrier = owned.client.asyncCall("flush", []).catch(() => "cancelled");
    await owned.started;
    const draining = owned.service.drainForOwner();
    await assertPending(draining);
    owned.release();
    await draining;
    await barrier;
    expect(owned.backend.shared.publication!.stopped).toBe(false);
    await owned.backend.flush();
    const offered = createFilesystemConnection();
    expect(() => owned.service.connect(offered.server)).toThrow();
    expect(isRevoked(offered.client)).toBe(true);
    offered.client.port.close();
    expect(owned.service.resources().clients).toBe(0);
  } finally {
    owned.close();
  }
});
