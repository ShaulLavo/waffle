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

import { MemoryBackend } from "../fs/backend";
import { ResidentAuthorityServer } from "../browser/publication-authority";
import { ResidentChannel, residentDescriptor } from "../fs/publication-attachment";

async function residentServer() {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection(undefined, { limits, observe: true });
  service.connect(pair.server);
  const root = new FilesystemClient(pair.client);
  const directory: number = await root.asyncCall("preopen", ["/"]);
  const workspace = `owner-drain-${crypto.randomUUID()}`;
  const descriptor = residentDescriptor(
    await root.asyncCall("publicationWorkspace", [
      root.connection.publication!.observer,
      directory,
      workspace,
    ]),
  );
  const authority = service.residentPublication!;
  authority.activate();
  const releases: string[] = [];
  const server = new ResidentAuthorityServer(
    authority,
    {
      async release() {
        releases.push("continuity");
      },
    },
    {
      async release() {
        releases.push("bootstrap");
      },
    },
  );
  const channel = new ResidentChannel(workspace);
  return {
    backend,
    server,
    descriptor,
    channel,
    releases,
    async close() {
      channel.close();
      await server.stop();
      root.dispose();
      service.dispose();
    },
  };
}

test("persistent server drain refuses a live actual session and memoizes its failure", async () => {
  const owned = await residentServer();
  try {
    await owned.channel.call("open", owned.descriptor);
    const draining = owned.server.drainForOwner();
    await expect(draining).rejects.toMatchObject({ errno: 6 });
    expect(owned.server.drainForOwner()).toBe(draining);
    await expect(owned.server.drainForOwner()).rejects.toMatchObject({ errno: 6 });
    expect(owned.releases).toEqual([]);
    expect(owned.backend.shared.publication!.stopped).toBe(false);
  } finally {
    // This fixture owns a memory server, not native storage or real continuity guards.
    await owned.close();
  }
});

test("persistent server drain keeps authority live until separate finalization", async () => {
  const owned = await residentServer();
  try {
    await owned.server.drainForOwner();
    expect(owned.backend.shared.publication!.stopped).toBe(false);
    expect(owned.releases).toEqual([]);
    const finalizing = owned.server.finishStop();
    expect(owned.server.finishStop()).toBe(finalizing);
    await finalizing;
    expect(owned.backend.shared.publication!.stopped).toBe(true);
    expect(owned.releases).toEqual(["continuity", "bootstrap"]);
  } finally {
    await owned.close();
  }
});

import { createPersistentResidentOwner } from "../browser/persistent-resident-owner";

/** Native API stand-ins exercise the real owner/opener, not browser scheduling. */
function pendingNativeClaim() {
  const originals = new Map(
    ["location", "navigator", "indexedDB"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const requested = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<never>();
  let claimSignal: AbortSignal | undefined;
  let closed = 0;
  const database = {
    objectStoreNames: {
      length: 3,
      contains: (name: string) => ["metadata", "journal", "data"].includes(name),
    },
    close() {
      closed++;
    },
  } as unknown as IDBDatabase;
  const opening = { result: database } as IDBOpenDBRequest;
  const locks = {
    request(name: string, options: LockOptions, callback: LockGrantedCallback) {
      if (!name.startsWith("bun-wasm:filesystem:indexeddb:"))
        return Promise.resolve(callback({ name, mode: "exclusive" }));
      claimSignal = options.signal;
      const abort = () => pending.reject(claimSignal?.reason);
      claimSignal?.addEventListener("abort", abort, { once: true });
      requested.resolve();
      return pending.promise.finally(() => claimSignal?.removeEventListener("abort", abort));
    },
  };
  const values = {
    location: { origin: "https://owner-unit.test" },
    navigator: { locks },
    indexedDB: { open: () => opening },
  };
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const owner = createPersistentResidentOwner(
    {
      kind: "initial-open",
      runtimeLifetime: "unit-lifetime",
      attempt: crypto.randomUUID(),
      selected: {
        origin: values.location.origin,
        name: `unit-pending-${crypto.randomUUID()}`,
        implementation: "indexeddb",
        format: "waffle-indexeddb-v1",
      },
      publication: { limits },
    },
    new AbortController().signal,
  );
  const readiness = owner.ready.catch((error: unknown) => error);
  return {
    owner,
    readiness,
    requested: requested.promise,
    get claimSignal() {
      return claimSignal;
    },
    get closed() {
      return closed;
    },
    async deliver() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      opening.onsuccess!(new Event("success"));
    },
    async close() {
      pending.reject(new DOMException("fixture retirement", "AbortError"));
      await owner.stop();
      await readiness;
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("owner cancellation reaches an ungranted native claim without retiring its live holder stand-in", async () => {
  const owned = pendingNativeClaim();
  const holderAlive = true;
  try {
    await owned.deliver();
    await owned.requested;
    const stopped = owned.owner.stop();
    expect(owned.owner.stop()).toBe(stopped);
    expect(owned.claimSignal?.aborted).toBe(true);
    await stopped;
    expect(holderAlive).toBe(true);
    expect(owned.closed).toBe(1);
    expect(await owned.readiness).toMatchObject({ errno: 11 });
  } finally {
    await owned.close();
  }
});
