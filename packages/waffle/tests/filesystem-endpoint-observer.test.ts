import { expect, test } from "bun:test";
import { bootstrap, preview1Executor, type RuntimeWorkerMessage } from "../browser/worker.js";
import {
  FilesystemClient,
  createFilesystemConnection,
  createFilesystemIdentity,
  connectFilesystemIdentity,
} from "../fs/index.js";
import {
  observeFilesystemEndpoint,
  type EndpointSnapshot,
} from "./fixtures/filesystem-endpoint-observer.js";
import type { ServiceCommand } from "./fixtures/filesystem-endpoint-service.js";
import { requestTransportError } from "../fs/request-memory.js";

// Original empty Preview 1 command. Bootstrap must construct Wasi and call its real preopen.
const module = new WebAssembly.Module(
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109,
    101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
  ]),
);

function serviceFixture() {
  const worker = new Worker(
    new URL("./fixtures/filesystem-endpoint-service.ts", import.meta.url).href,
  );
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<EndpointSnapshot[]>>>();
  let next = 0;
  worker.onmessage = ({
    data,
  }: MessageEvent<{ id: number; snapshots: EndpointSnapshot[]; error?: string }>) => {
    const request = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) request?.reject(Error(data.error));
    else request?.resolve(data.snapshots);
  };
  worker.onerror = (event) => {
    for (const request of pending.values()) request.reject(Error(event.message));
  };
  return {
    async command(command: ServiceCommand) {
      const id = ++next;
      const result = Promise.withResolvers<EndpointSnapshot[]>();
      pending.set(id, result);
      const timer = setTimeout(
        () => result.reject(Error("endpoint service control timeout")),
        3000,
      );
      try {
        worker.postMessage(
          { ...command, id },
          command.kind === "connect" ? [command.connection.port] : [],
        );
        return await result.promise;
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    },
    async stop() {
      await worker.terminate();
      expect(pending.size).toBe(0);
    },
  };
}

type Fault = "none" | "client" | "service" | "control";
for (const fault of ["none", "client", "service", "control"] as const)
  test(`endpoint observer distinguishes ${fault} through original bootstrap and healthy sibling`, async () => {
    const service = serviceFixture();
    const tree = `startup-${fault}`;
    const root = createFilesystemConnection();
    const pair = connectFilesystemIdentity(createFilesystemIdentity(root.client), root.pool);
    const sibling = connectFilesystemIdentity(createFilesystemIdentity(root.client), root.pool);
    const observer = observeFilesystemEndpoint(pair.client, {
      tree,
      realm: "bun-test-bootstrap",
      endpoint: "client",
      workerURL: import.meta.url,
    });
    const rootClient = new FilesystemClient(root.client);
    const siblingClient = new FilesystemClient(sibling.client);
    const messages: RuntimeWorkerMessage[] = [];
    let injected: Promise<EndpointSnapshot[]> | undefined;
    let entries = 0;
    try {
      await service.command({ kind: "connect", connection: root.server, tree });
      await service.command({ kind: "connect", connection: pair.server, tree });
      await service.command({ kind: "connect", connection: sibling.server, tree });
      await bootstrap(
        {
          controlGrant: { kind: "unbounded" },
          module,
          args: [],
          env: {},
          filesystem: pair.client,
        },
        {
          setup({ fs }) {
            expect(fs.preopen).toBe(FilesystemClient.prototype.preopen);
            observer.qualifyHandlers();
            if (fault === "client")
              pair.client.port.dispatchEvent(new MessageEvent("messageerror"));
            if (fault === "control") {
              pair.client.port.postMessage({ transportClosed: true });
              waitForInjectedClose(pair.client);
            }
            if (fault === "service") {
              injected = service.command({ kind: "fault", owner: pair.client.owner });
              void injected.catch(() => {});
              waitForInjectedClose(pair.client);
            }
            observer.snapshot();
          },
          run(context, exited) {
            entries++;
            expect(context.wasi.descriptors.get(3)?.preopen).toBe("/");
            return preview1Executor.run(context, exited);
          },
        },
        { crossOriginIsolated: true, postMessage: (message) => messages.push(message) },
      );
      await injected;
      expect(rootClient.preopen("/")).toBeGreaterThanOrEqual(0);
      expect(siblingClient.preopen("/")).toBeGreaterThanOrEqual(0);
      const client = observer.snapshot();
      const snapshots = await service.command({ kind: "snapshot" });
      const peer = snapshots.find((snapshot) => snapshot.owner === client.owner);
      if (!peer) throw Error("missing exact service endpoint coverage");
      expect(peer).toMatchObject({
        tree: client.tree,
        generation: client.generation,
        handlersQualified: true,
      });
      expect(client.handlersQualified).toBe(true);
      expect(entries).toBe(fault === "none" ? 1 : 0);
      assertDiscrimination(fault, client, peer);
      expect(
        messages.filter((message) => message.type === "exit" || message.type === "error"),
      ).toMatchObject(
        fault === "none" ? [{ type: "exit", code: 0 }] : [{ type: "error", errno: "EIO" }],
      );
      expect(
        snapshots
          .filter((snapshot) => snapshot.owner !== client.owner)
          .every((snapshot) => snapshot.closed === null),
      ).toBe(true);
      if (process.env.FS_ENDPOINT_RESULT_DIR)
        await Bun.write(
          `${process.env.FS_ENDPOINT_RESULT_DIR}/${fault}.json`,
          JSON.stringify({ client, peer, entries, messages }, null, 2),
        );
    } finally {
      observer.dispose();
      rootClient.dispose();
      siblingClient.dispose();
      for (const connection of [root, pair, sibling]) connection.client.port.close();
      try {
        await service.command({ kind: "dispose" });
      } finally {
        await service.stop();
      }
    }
  }, 15000);

function assertDiscrimination(fault: Fault, client: EndpointSnapshot, peer: EndpointSnapshot) {
  if (fault === "none") {
    expect(client.first).toBeNull();
    expect(peer.first).toBeNull();
    expect(client.requestSends).toBeGreaterThan(0);
    expect(peer.requestReceives).toBe(client.requestSends);
    expect(peer.lastReceive?.kind).not.toBe("other");
    return;
  }
  if (fault === "control") {
    expect(peer.first).toMatchObject({ kind: "transportClosed", closedBefore: null });
    expect(peer.first?.trusted).toBe(true);
    expect(client.first).toMatchObject({
      kind: "shared-closed",
      closedBefore: "messageerror",
      lastSend: { kind: "transportClosed" },
    });
    expect(client.requestSends).toBe(0);
    return;
  }
  const local = fault === "client" ? client : peer;
  const remote = fault === "client" ? peer : client;
  expect(local.first).toMatchObject({ kind: "messageerror", trusted: false, closedBefore: null });
  expect(local.closed).toBe("messageerror");
  expect(remote.closed).toBe("messageerror");
  expect(remote.first?.kind).not.toBe("messageerror");
  expect(remote.first?.closedBefore).toBe("messageerror");
  expect(client.receives).toBe(0);
  expect(client.requestSends).toBe(0);
  expect(client.first?.lastSend).toBeNull();
}

function waitForInjectedClose(connection: Parameters<typeof observeFilesystemEndpoint>[0]): void {
  const signal = new Int32Array(connection.signal);
  const deadline = performance.now() + 3000;
  while (!requestTransportError(connection.requests)) {
    const observed = Atomics.load(signal, 0);
    if (requestTransportError(connection.requests)) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw Error("service fault did not close its original endpoint");
    Atomics.wait(signal, 0, observed, remaining);
  }
}

test("closure before client construction fails coverage before the preopen phase", async () => {
  const service = serviceFixture();
  const tree = "startup-before-client";
  const pair = createFilesystemConnection();
  const observer = observeFilesystemEndpoint(pair.client, {
    tree,
    realm: "bun-test-bootstrap",
    endpoint: "client",
    workerURL: import.meta.url,
  });
  const phases: string[] = [];
  try {
    await service.command({ kind: "connect", connection: pair.server, tree });
    await service.command({ kind: "fault", owner: pair.client.owner });
    await expect(
      bootstrap(
        {
          controlGrant: { kind: "unbounded" },
          module,
          args: [],
          env: {},
          filesystem: pair.client,
        },
        {
          setup() {
            phases.push("setup");
          },
          run() {
            phases.push("entry");
            return 0;
          },
        },
        {
          crossOriginIsolated: true,
          postMessage(message) {
            if (message.type === "phase") phases.push(message.name);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "CLOSED", errno: 29, reason: "messageerror" });
    expect(phases).toEqual(["worker-start"]);
    expect(observer.snapshot()).toMatchObject({
      handlersQualified: false,
      requestSends: 0,
      first: { kind: "shared-closed", closedBefore: "messageerror" },
    });
  } finally {
    observer.dispose();
    pair.client.port.close();
    try {
      await service.command({ kind: "dispose" });
    } finally {
      await service.stop();
    }
  }
});

test("endpoint coverage rejects installation after original client handlers", () => {
  const pair = createFilesystemConnection();
  const client = new FilesystemClient(pair.client);
  try {
    expect(() =>
      observeFilesystemEndpoint(pair.client, {
        tree: "unqualified",
        realm: "late",
        endpoint: "client",
        workerURL: import.meta.url,
      }),
    ).toThrow("installed too late");
  } finally {
    client.dispose();
    pair.server.port.close();
  }
});

test("endpoint coverage rejects qualification without original handlers", () => {
  const pair = createFilesystemConnection();
  const observer = observeFilesystemEndpoint(pair.client, {
    tree: "unqualified",
    realm: "missing-handlers",
    endpoint: "client",
    workerURL: import.meta.url,
  });
  try {
    expect(observer.qualifyHandlers).toThrow("original endpoint handlers were not installed");
    expect(observer.snapshot().handlersQualified).toBe(false);
  } finally {
    observer.dispose();
    pair.client.port.close();
    pair.server.port.close();
  }
});
