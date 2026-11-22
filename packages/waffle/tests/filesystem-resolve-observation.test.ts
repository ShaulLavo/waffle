import { expect, test } from "bun:test";
import { FilesystemClient } from "../fs/client.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemError, createFilesystemConnection, revokeFilesystem } from "../fs/protocol.js";
import { FilesystemService, installFilesystemWorker } from "../fs/service.js";
import { registerResolveObservation, takeResolveObservation } from "../fs/resolve-observation.js";
import { ACKNOWLEDGED, OperationCells, type ResultName } from "../browser/operations/cells.js";
import { OperationOwner } from "../browser/operations/owner.js";

function expectCancellation(error: unknown): void {
  expect(error).toBeInstanceOf(FilesystemError);
  expect(error).toHaveProperty("constructor", FilesystemError);
  expect(error).toHaveProperty("errno", 11);
}

test("public completion methods throw the exported FilesystemError on revocation", async () => {
  const pair = createFilesystemConnection();
  const client = new FilesystemClient(pair.client);
  try {
    const waiting = client.submit("resolve", [0, "waiting"]);
    const valuing = client.submit("resolve", [0, "valuing"]);
    const releasing = client.submit("resolve", [0, "releasing"]);
    const failures = [
      valuing.value(),
      Promise.resolve().then(() => waiting.wait()),
      Promise.resolve().then(() => releasing.releaseReady()),
    ].map((pending) => pending.catch((error: unknown) => error));
    revokeFilesystem(pair.client);
    try {
      for (const failure of await Promise.all(failures)) expectCancellation(failure);
    } finally {
      waiting.release();
      valuing.release();
    }
  } finally {
    client.dispose();
    pair.server.port.close();
  }
});

function cancelSubmittedResolves(client: FilesystemClient): void {
  const submit = client.submit.bind(client);
  client.submit = (...args) => {
    const completion = submit(...args);
    completion.cancel();
    return completion;
  };
}

test("public client construction cannot register a callback for synchronous resolve", () => {
  const pair = createFilesystemConnection();
  let entered = 0;
  const client: FilesystemClient = Reflect.construct(FilesystemClient, [
    pair.client,
    undefined,
    {
      entered() {
        entered++;
        return false;
      },
    },
  ]);
  try {
    cancelSubmittedResolves(client);
    expect(client.resolve(0, "cold")).toBe(11);
    expect(entered).toBe(0);
  } finally {
    client.dispose();
    pair.server.port.close();
  }
});

test("private resolve registration is consumed by the exact client connection", () => {
  const pair = createFilesystemConnection();
  const results: ResultName[] = [];
  const began: number[] = [];
  let entered = false;
  registerResolveObservation(pair.client, {
    entered: () => entered,
    writer: {
      begin: (id) => began.push(id),
      settle: (result) => results.push(result),
      submissionFailed: (result) => results.push(result),
    },
  });
  const unrelated = takeResolveObservation({ ...pair.client });
  const client = new FilesystemClient(pair.client);
  try {
    expect(unrelated).toBeUndefined();
    expect(takeResolveObservation(pair.client)).toBeUndefined();
    cancelSubmittedResolves(client);
    expect(client.resolve(0, "pre-entry")).toBe(11);
    expect(began).toEqual([]);
    expect(results).toEqual([]);
    entered = true;
    expect(client.resolve(0, "entered")).toBe(11);
    expect(began).toHaveLength(1);
    expect(results).toEqual(["filesystemCancelled"]);
  } finally {
    client.dispose();
    pair.server.port.close();
  }
});

test("the service Worker records only its bound connection and hides the binding from its factory", async () => {
  const operations = new OperationOwner(
    (size) => new SharedArrayBuffer(size),
    () => true,
  );
  const binding = operations.enroll(1, 1)!;
  const cells = new OperationCells(binding);
  const observed = createFilesystemConnection();
  const ordinary = createFilesystemConnection(observed.client);
  const connected = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const disposed = Promise.withResolvers<void>();
  let factoryOptions: unknown;
  let ready = 0;
  const scope: Parameters<typeof installFilesystemWorker>[0] = {
    onmessage: null,
    postMessage(message) {
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (message.type === "filesystem-state") connected[ready++]!.resolve();
      if (message.type === "filesystem-disposed") disposed.resolve();
    },
  };
  installFilesystemWorker(scope, (options: unknown) => {
    factoryOptions = options;
    return new MemoryBackend();
  });
  const send = (data: unknown) => scope.onmessage!(new MessageEvent("message", { data }));
  const client = new FilesystemClient(observed.client);
  const other = new FilesystemClient(ordinary.client);
  try {
    send({ connect: observed.server, operations: binding });
    await connected[0]!.promise;
    send({ connect: ordinary.server });
    await connected[1]!.promise;
    expect(factoryOptions).toEqual({ connect: observed.server });
    const root = await other.asyncCall("preopen", ["/"]);
    expect(await other.asyncCall("resolve", [root, "missing"])).toMatchObject({
      parent: root,
      name: "missing",
    });
    expect(cells.read(ACKNOWLEDGED)).toBe(0);
    const directory = await client.asyncCall("preopen", ["/"]);
    const request = client.submit("resolve", [directory, "missing"]);
    try {
      expect(await request.value()).toMatchObject({ parent: directory, name: "missing" });
      expect(cells.read(ACKNOWLEDGED)).toBe(request.id);
    } finally {
      request.release();
    }
  } finally {
    client.dispose();
    other.dispose();
    send({ dispose: true });
    try {
      await disposed.promise;
    } finally {
      observed.server.port.close();
      ordinary.server.port.close();
    }
  }
});

test("public service connect cannot register a callback for resolve receipt", async () => {
  const pair = createFilesystemConnection();
  const client = new FilesystemClient(pair.client);
  const owner = new FilesystemService(new MemoryBackend());
  const accepted: number[] = [];
  try {
    Reflect.apply(owner.connect, owner, [pair.server, (id: number) => accepted.push(id)]);
    await client.asyncCall("writeFile", ["/input"], new Uint8Array([65]));
    const root = await client.asyncCall("preopen", ["/"]);
    expect(await client.asyncCall("resolve", [root, "input"])).toMatchObject({
      parent: root,
      node: expect.any(Number),
    });
    expect(accepted).toEqual([]);
  } finally {
    client.dispose();
    await owner.shutdown();
    pair.server.port.close();
  }
});
