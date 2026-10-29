import { expect, test } from "bun:test";
import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
  createFilesystemIdentity,
  connectFilesystemIdentity,
  FilesystemError,
} from "../fs/index.js";
import { isRevoked, reapFilesystem } from "../fs/protocol.js";
import {
  requestMemoryRetired,
  requestMemoryResources,
  type FilesystemRequestMemory,
} from "../fs/request-memory.js";

async function waitForRetirement(memory: FilesystemRequestMemory): Promise<void> {
  while (!requestMemoryRetired(memory)) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failed = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Error("filesystem transport test stalled")), 3000);
  });
  try {
    return await Promise.race([pending, failed]);
  } finally {
    clearTimeout(timer);
  }
}
function noSharedPayload(value: unknown): void {
  expect(value instanceof SharedArrayBuffer).toBe(false);
  if (!value || typeof value !== "object") return;
  for (const entry of Object.values(value)) noSharedPayload(entry);
}
class GatedBackend extends MemoryBackend {
  readonly entered = Promise.withResolvers<void>();
  readonly gate = Promise.withResolvers<void>();
  override execute(operation: string, args: any[], data: Uint8Array): unknown {
    if (operation !== "readFile" || args[0] !== "/held")
      return super.execute(operation, args, data);
    this.entered.resolve();
    return this.gate.promise.then(() => new Uint8Array([77]));
  }
}
class RejectingBackend extends MemoryBackend {
  prepare(operation: string, args: any[]): void | Promise<void> {
    if (operation === "readFile" && args[0] === "/prepare")
      return Promise.reject(new FilesystemError(2));
    if (operation === "readFile" && args[0] === "/cancel")
      return Promise.reject(new FilesystemError(11));
  }
  override execute(operation: string, args: any[], data: Uint8Array): unknown {
    if (operation === "readFile" && args[0] === "/reject")
      return Promise.reject(new FilesystemError(2));
    if (operation === "readFile" && args[0] === "/async")
      return Promise.resolve(new Uint8Array([1]));
    return super.execute(operation, args, data);
  }
}
function fixture(backend = new MemoryBackend()) {
  const service = new FilesystemService(backend);
  const root = createFilesystemConnection();
  const pairs = [root];
  const frames: unknown[] = [];
  const connect = (identity: ReturnType<typeof createFilesystemIdentity>) => {
    const pair = connectFilesystemIdentity(identity, root.pool);
    pairs.push(pair);
    serve(pair);
    return pair.client;
  };
  function serve(pair: typeof root) {
    service.connect(pair.server);
    pair.server.port.addEventListener("message", (event) => {
      noSharedPayload(event.data);
      frames.push(event.data);
    });
    pair.client.port.addEventListener("message", (event) => noSharedPayload(event.data));
  }
  serve(root);
  const client = new FilesystemClient(root.client, { connect });
  const clients = [client];
  return {
    service,
    root,
    pairs,
    frames,
    client,
    peer() {
      const peer = new FilesystemClient(client.fork());
      clients.push(peer);
      return peer;
    },
    cleanup() {
      for (const client of clients) client.dispose();
      service.dispose();
      for (const pair of pairs) {
        pair.client.port.close();
        pair.server.port.close();
      }
    },
  };
}

test("a prestarted Worker performs its immediate first sync request with no host connector or SAB session payload", async () => {
  const f = fixture();
  const worker = new Worker(new URL("./fixtures/filesystem-port-worker.ts", import.meta.url).href);
  const ready = Promise.withResolvers<void>(),
    done = Promise.withResolvers<unknown>();
  void done.promise.catch(() => {});
  worker.onmessage = ({ data }) => {
    if (data.type === "ready") ready.resolve();
    else done.resolve(data);
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || String(event.error));
    ready.reject(error);
    done.reject(error);
  };
  try {
    await bounded(ready.promise);
    const connection = f.client.fork();
    worker.postMessage({ connection, id: 1 }, [connection.port]);
    expect(await bounded(done.promise)).toMatchObject({ ok: true, id: 1 });
    expect(f.frames[0]).toMatchObject({
      id: 1,
      generation: expect.any(Number),
      offset: expect.any(Number),
      length: expect.any(Number),
    });
    expect(
      f.frames.filter((value) => value && typeof value === "object" && "offset" in value),
    ).toHaveLength(3);
  } finally {
    await worker.terminate();
    f.cleanup();
  }
}, 10000);

for (const end of ["client", "server"] as const)
  test(`messageerror at the ${end} end closes only its connection and wakes all pending values`, async () => {
    const backend = new GatedBackend();
    const f = fixture(backend),
      bad = f.peer(),
      good = f.peer();
    const pair = f.pairs[1]!;
    const request = bad.submit("readFile", ["/held"]);
    const values = [
      request.value().catch((error) => error),
      request.value().catch((error) => error),
    ];
    try {
      await bounded(backend.entered.promise);
      pair[end].port.dispatchEvent(new MessageEvent("messageerror"));
      for (const value of values)
        expect(await bounded(value)).toMatchObject({
          code: "CLOSED",
          errno: 29,
          reason: "messageerror",
        });
      expect(isRevoked(good.connection)).toBe(false);
      expect(isRevoked(bad.connection)).toBe(false);
      expect(isRevoked(f.client.connection)).toBe(false);
      expect(requestMemoryRetired(bad.connection.requests)).toBe(false);
      backend.gate.resolve();
      expect(await good.asyncCall("preopen", ["/"])).toBeGreaterThanOrEqual(0);
      expect(() => bad.submit("listFiles", ["/"])).toThrow("deserialize");
    } finally {
      backend.gate.resolve();
      request.release();
      f.cleanup();
    }
  });

test("missing connector fails before allocating an identity or transport resources", () => {
  const pair = createFilesystemConnection();
  const client = new FilesystemClient(pair.client);
  try {
    const owners = Atomics.load(new Int32Array(pair.client.shared), 5);
    const before = requestMemoryResources(pair.client.requests);
    expect(() => client.fork()).toThrow("host connector");
    expect(Atomics.load(new Int32Array(pair.client.shared), 5)).toBe(owners);
    expect(requestMemoryResources(pair.client.requests)).toEqual(before);
  } finally {
    client.dispose();
    pair.server.port.close();
  }
});

test("thirty async calls and a large overflow preserve data and release response quota", async () => {
  const f = fixture();
  try {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        f.client.asyncCall("writeFile", [`/parallel-${i}`], new Uint8Array([i])),
      ),
    );
    const bytes = new Uint8Array(2 * 1024 * 1024 + 3).fill(90);
    await f.client.asyncCall("writeFile", ["/large"], bytes);
    expect(await f.client.asyncCall("readFile", ["/large"])).toEqual(bytes);
    await f.client.asyncCall("listFiles", ["/"]);
    expect(f.service.resources().responses).toBe(0);
    expect(requestMemoryResources(f.root.client.requests).retainedBytes).toBeLessThan(
      3 * 1024 * 1024,
    );
  } finally {
    f.cleanup();
  }
});

for (const [path, expected] of [
  ["/async", 0],
  ["/reject", 2],
  ["/prepare", 2],
  ["/cancel", 11],
] as const)
  test(`retirement joins ${path} backend work and permits arena reuse`, async () => {
    const f = fixture(new RejectingBackend());
    const peer = f.peer();
    try {
      const outcome = await peer.asyncCall("readFile", [path]).catch((error) => error);
      if (expected) expect(outcome).toMatchObject({ errno: expected });
      else expect(outcome).toEqual(new Uint8Array([1]));
      peer.dispose();
      reapFilesystem(peer.connection);
      f.service.sweep();
      await bounded(waitForRetirement(peer.connection.requests));
      const next = f.root.pool.take(new SharedArrayBuffer(4));
      expect(next.data).toBe(peer.connection.requests.data);
      if (expected)
        expect(await f.service.shutdown().catch((error) => error)).toMatchObject({
          errno: expected,
        });
    } finally {
      f.cleanup();
    }
  }, 10000);
