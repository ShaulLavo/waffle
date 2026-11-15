import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { SharedFilesystem } from "../browser/shared-fs.js";
import { FilesystemClient } from "../fs/client.js";
import type { FilesystemConnection } from "../fs/protocol.js";
import { FilesystemRequestPool } from "../fs/request-memory.js";

type Bootstrap = {
  connect?: FilesystemConnection;
  reply?: MessagePort;
  socketScope?: unknown;
};
const previousWorker = globalThis.Worker;
const workers: TransferWorker[] = [];
const owners: SharedFilesystem[] = [];
const close = MessagePort.prototype.close;
const closed: MessagePort[] = [];
const closeSpy = spyOn(MessagePort.prototype, "close").mockImplementation(function (
  this: MessagePort,
) {
  closed.push(this);
  Reflect.apply(close, this, []);
});
afterAll(() => closeSpy.mockRestore());
let failNextPost = false;
let failWorkerSetup = false;

function roots(): Set<MessagePort> {
  const value: unknown = Reflect.get(FilesystemRequestPool, "formerServicePorts");
  if (!(value instanceof Set)) throw Error("missing private former service ports");
  return value;
}
const initialRoots = new Set(roots());

// Native transfer, synthetic service replies: this tests page ownership, not Firefox internals.
class TransferWorker {
  readonly posts: Bootstrap[] = [];
  readonly incoming: Bootstrap[] = [];
  readonly carrier = new MessageChannel();
  readonly listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  failPost = false;
  reply: "reject" | "adopt" | undefined;
  terminations = 0;
  constructor() {
    workers.push(this);
    this.carrier.port2.onmessage = ({ data }: MessageEvent<Bootstrap>) => {
      this.incoming.push(data);
      if (!data.reply || !this.reply) return;
      data.reply.postMessage(this.reply === "reject" ? { error: 44 } : { value: {} });
    };
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (failWorkerSetup) throw Error("worker setup failed before post");
    this.listeners.set(type, (this.listeners.get(type) ?? []).concat([listener]));
  }
  postMessage(message: Bootstrap, transfers: Transferable[] = []): void {
    this.posts.push(message);
    if (message.connect) {
      expect(roots().has(message.connect.port)).toBe(true);
      expect(message.connect).not.toHaveProperty("pool");
      expect(message.connect).not.toHaveProperty("formerServiceSender");
    }
    if (failNextPost || this.failPost) throw Error("throw before native transfer");
    this.carrier.port1.postMessage(message, transfers);
  }
  terminate(): void {
    this.terminations++;
  }
  ready(): void {
    for (const listener of this.listeners.get("message") ?? [])
      listener({ data: { type: "filesystem-state", status: "ready" } });
  }
}

function fixture() {
  globalThis.Worker = TransferWorker as unknown as typeof Worker;
  const fs = new SharedFilesystem({ mode: "memory", workerURL: "https://example.test/fs.js" });
  owners.push(fs);
  return { fs, worker: workers.at(-1)! };
}
function lastServer(worker: TransferWorker): FilesystemConnection {
  const server = worker.posts.at(-1)?.connect;
  if (!server) throw Error("missing service connection");
  return server;
}
function expectTransferred(fs: SharedFilesystem, server: FilesystemConnection): void {
  expect(roots().has(server.port)).toBe(true);
  expect(closed.filter((port) => port === server.port)).toHaveLength(0);
  const pool: FilesystemRequestPool = Reflect.get(fs, "requestPool");
  const arenas = Reflect.get(pool, "arenas");
  expect(arenas).toContainEqual(
    expect.objectContaining({
      control: server.requests.control,
      generation: server.requests.generation,
      formerServiceSender: { port: server.port, transferred: true },
    }),
  );
  expect(Array.from(roots()).every((port) => port instanceof MessagePort)).toBe(true);
}

afterEach(async () => {
  failNextPost = false;
  failWorkerSetup = false;
  try {
    for (const owner of owners.splice(0)) await owner.dispose().catch(() => {});
    for (const worker of workers.splice(0)) {
      worker.carrier.port1.close();
      worker.carrier.port2.close();
      for (const message of worker.incoming) {
        message.connect?.port.close();
        message.reply?.close();
      }
      for (const message of worker.posts) {
        message.connect?.port.close();
        message.reply?.close();
      }
    }
    for (const port of roots()) if (!initialRoots.has(port)) roots().delete(port);
  } finally {
    globalThis.Worker = previousWorker;
    closed.length = 0;
  }
});

test("bootstrap and connect retain precisely their former bare service wrappers", async () => {
  const { fs, worker } = fixture();
  const root = lastServer(worker);
  expectTransferred(fs, root);
  const client = new FilesystemClient(fs.connect(fs.createIdentity()));
  try {
    const child = lastServer(worker);
    expectTransferred(fs, child);
    expect(Array.from(roots()).filter((port) => !initialRoots.has(port))).toEqual([
      root.port,
      child.port,
    ]);
    expect(Object.keys(child)).toEqual(Object.keys(client.connection));
    await fs.dispose();
    // Ordinary disposal cannot manufacture the missing service retirement receipt.
    expect(roots().has(root.port)).toBe(true);
    expect(roots().has(child.port)).toBe(true);
    Reflect.set(fs, "requestPool", undefined);
    expect(roots().has(root.port)).toBe(true);
    expect(roots().has(child.port)).toBe(true);
  } finally {
    client.dispose();
  }
});

test("bootstrap throw before transfer removes provisional retention and closes owned endpoints", () => {
  globalThis.Worker = TransferWorker as unknown as typeof Worker;
  failNextPost = true;
  expect(
    () => new SharedFilesystem({ mode: "memory", workerURL: "https://example.test/fs.js" }),
  ).toThrow("throw before native transfer");
  const worker = workers.at(-1)!;
  const server = lastServer(worker);
  expect(roots().has(server.port)).toBe(false);
  expect(closed.filter((port) => port === server.port)).toHaveLength(1);
  expect(new Set(closed).size).toBe(2);
  expect(worker.terminations).toBe(1);
});

test("constructor failure before posting closes both endpoints without registering a sender", () => {
  globalThis.Worker = TransferWorker as unknown as typeof Worker;
  failWorkerSetup = true;
  expect(
    () => new SharedFilesystem({ mode: "memory", workerURL: "https://example.test/fs.js" }),
  ).toThrow("worker setup failed before post");
  expect(Array.from(roots())).toEqual(Array.from(initialRoots));
  expect(new Set(closed).size).toBe(2);
  expect(workers.at(-1)!.terminations).toBe(1);
});

test("connect throw before transfer closes both local endpoints and leaves the root pin", () => {
  const { fs, worker } = fixture();
  const root = lastServer(worker);
  const before = closed.length;
  worker.failPost = true;
  expect(() => fs.connect(fs.createIdentity())).toThrow("throw before native transfer");
  const server = lastServer(worker);
  expect(roots().has(server.port)).toBe(false);
  expect(new Set(closed.slice(before)).size).toBe(2);
  expectTransferred(fs, root);
});

test("socket scope throw before transfer disposes the client and drops only its provisional pin", async () => {
  const { fs, worker } = fixture();
  const root = lastServer(worker);
  worker.failPost = true;
  await expect(fs.attachSocketScope(fs.createIdentity(), 1)).rejects.toThrow(
    "throw before native transfer",
  );
  const server = lastServer(worker);
  expect(roots().has(server.port)).toBe(false);
  expect(closed.filter((port) => port === server.port)).toHaveLength(1);
  expect(new Int32Array(server.revocations[0]!)[0]).toBe(2);
  expectTransferred(fs, root);
});

for (const failure of ["reject", "cancel", "adopt"] as const) {
  test(`socket ${failure} after native transfer disposes its client without closing or unpinning the old server`, async () => {
    const { fs, worker } = fixture();
    const adopt = spyOn(FilesystemClient.prototype, "adopt").mockImplementation(() => {
      throw Error("adopt failed");
    });
    try {
      if (failure !== "cancel") worker.reply = failure;
      const pending = fs.attachSocketScope(fs.createIdentity(), 1);
      const rejected = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      const server = lastServer(worker);
      if (failure === "cancel") await fs.dispose();
      expect(await rejected).toBeInstanceOf(Error);
      expectTransferred(fs, server);
      expect(new Int32Array(server.revocations[0]!)[0]).toBe(2);
      expect(adopt.mock.calls).toHaveLength(failure === "adopt" ? 1 : 0);
    } finally {
      adopt.mockRestore();
    }
  });
}

test("successful socket attachment retains its exact transferred service wrapper", async () => {
  const { fs, worker } = fixture();
  worker.reply = "adopt";
  const adopt = spyOn(FilesystemClient.prototype, "adopt").mockImplementation(() => {});
  let client: FilesystemClient | undefined;
  try {
    const attached = await fs.attachSocketScope(fs.createIdentity(), 1);
    client = attached.client;
    expectTransferred(fs, lastServer(worker));
    expect(adopt).toHaveBeenCalledTimes(1);
  } finally {
    client?.dispose();
    adopt.mockRestore();
  }
});
