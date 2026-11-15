import { expect, test } from "bun:test";
import { createRuntime } from "../runtime.js";
import { FilesystemClient } from "../fs/client.js";
import {
  FilesystemRequestPool,
  waitForFilesystemTransportRetirement,
} from "../fs/request-memory.js";

async function disposeRuntime(
  runtime: ReturnType<typeof createRuntime> | undefined,
  clients: readonly FilesystemClient[],
) {
  try {
    for (const client of clients) client.dispose();
  } finally {
    await runtime?.dispose();
  }
}

test("successful default-owned runtime disposal releases service-retired child arenas", async () => {
  const take = FilesystemRequestPool.prototype.take;
  let observed: WeakRef<FilesystemRequestPool> | undefined;
  FilesystemRequestPool.prototype.take = function (...args: Parameters<typeof take>) {
    observed = new WeakRef(this);
    return Reflect.apply(take, this, args);
  };
  let runtime: ReturnType<typeof createRuntime> | undefined;
  const clients: FilesystemClient[] = [];
  let releaseRetiredReference: (() => void) | undefined;
  try {
    runtime = createRuntime({
      filesystem: {
        mode: "memory",
        workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
      },
    });
    const filesystem = runtime.filesystem;
    await filesystem.writeFile("/kept", "exact bytes");
    expect(() => createRuntime()).toThrow("live page runtime");
    for (let i = 0; i < 3; i++) {
      const client = new FilesystemClient(filesystem.connect(filesystem.createIdentity()));
      const handle = client.preopen("/");
      releaseRetiredReference ??= () => client.release(handle);
      clients.push(client);
    }
    const pool = observed?.deref();
    if (!pool) throw Error("default-owned pool was not observed");
    expect(Reflect.get(pool, "arenas")).toHaveLength(4);
    for (const client of clients) {
      await filesystem.quiesce(client.connection);
      client.dispose();
      await waitForFilesystemTransportRetirement(client.connection);
    }
    clients.length = 0;
    expect(Reflect.get(pool, "arenas")).toHaveLength(4);
    expect(new TextDecoder().decode(await filesystem.readFile("/kept"))).toBe("exact bytes");
    const stopping = runtime.dispose();
    expect(runtime.dispose()).toBe(stopping);
    await stopping;
    // Ordinary memory disposal does not join transport retirement. Its root receipt may
    // arrive before stop, but every explicitly joined child must have left the pool.
    const remaining: unknown = Reflect.get(pool, "arenas");
    if (!Array.isArray(remaining)) throw Error("missing pool ownership");
    const remainingCount = remaining.length;
    expect(remainingCount).toBeLessThanOrEqual(1);
    if (remaining.length) {
      expect(remaining[0].generation).toBe(1);
      expect(Number(new BigInt64Array(remaining[0].control)[3]! & 0xffffffffn)).toBe(0);
    }
    expect(() => filesystem.createIdentity()).toThrow("disposed");
    await expect(filesystem.readFile("/kept")).rejects.toThrow("disposed");
    if (!releaseRetiredReference) throw Error("missing retired client reference");
    expect(releaseRetiredReference).not.toThrow();
    await runtime.dispose();
    expect(Reflect.get(pool, "arenas")).toHaveLength(remainingCount);
  } finally {
    try {
      await disposeRuntime(runtime, clients);
    } finally {
      FilesystemRequestPool.prototype.take = take;
    }
  }
}, 60000);
