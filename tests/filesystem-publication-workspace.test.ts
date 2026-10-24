import { expect, test } from "bun:test";
import {
  failWorkspaceCleanupPost,
  workspaceCleanupPostFailure,
} from "./fixtures/publication-cleanup-failure";
import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
  createWorkspaceVfs,
} from "../fs";
import { ResidentAuthorityServer } from "../browser/publication-authority";
import {
  ResidentChannel,
  ResidentGrantClient,
  createResidentConnection,
  residentDescriptor,
  record,
  residentGrant,
  encodeResidentOutcome,
  residentSession,
  sameWorkspaceBacking,
  stopWorkspaceBridge,
} from "../fs/publication-attachment";
import {
  CAPABILITY_HEADER,
  CAPABILITY_LENGTH,
  CAPABILITY_SLOTS,
  CAPABILITY_WORDS,
  CONNECTION_SHARED_BYTES,
  HEADER,
  State,
  pack,
  type FilesystemConnection,
  type FilesystemIdentity,
  MAX_CONNECTION_OWNERS,
  SHARED_SEGMENT_BYTES,
  connectFilesystemIdentity,
  createFilesystemIdentity,
  createProcessFilesystemIdentity,
  isRevoked,
  revokeFilesystem,
  releaseFilesystemReservation,
} from "../fs/protocol";
import { ResidentGrantCell } from "../fs/publication-grant";
import type { PublicationLimits } from "../fs/publication-internal";

const limits: PublicationLimits = {
  sessions: 16,
  operations: 16,
  inputBytes: 128,
  argumentBytes: 1024,
  effectBytes: 8192,
  effects: 32,
  resultBytes: 1024,
  logRecords: 16,
  logBytes: 131072,
  pins: 2,
  pinBytes: 256,
};

async function fixture(backend = new MemoryBackend()) {
  backend.fs.mkdirp("/dir");
  backend.fs.writeFile("/dir/a", new Uint8Array([1, 2, 3]));
  backend.fs.writeFile("/dir/b", new Uint8Array([4, 5]));
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection(undefined, { limits, observe: true });
  service.connect(pair.server);
  const root = new FilesystemClient(pair.client);
  const directory: number = await root.asyncCall("preopen", ["/"]);
  const file: { node: number } = await root.asyncCall("resolve", [directory, "dir/a"]);
  const workspace = `workspace-${crypto.randomUUID()}`;
  const descriptor = residentDescriptor(
    await root.asyncCall("publicationWorkspace", [
      root.connection.publication!.observer,
      directory,
      workspace,
    ]),
  );
  const authority = service.residentPublication!;
  authority.activate();
  const guard = { release: () => Promise.resolve() };
  const server = new ResidentAuthorityServer(authority, guard, guard);
  const channel = new ResidentChannel(workspace);
  const session = residentSession(await channel.call("open", descriptor));
  return {
    channel,
    server,
    service,
    session,
    root,
    backend,
    directory,
    file: file.node,
    async stop() {
      await channel.call("closeConnection", null);
      channel.close();
      await server.stop();
      root.dispose();
      service.dispose();
    },
  };
}

async function call(
  f: Awaited<ReturnType<typeof fixture>>,
  operation: string,
  args: unknown[] = [],
  input = new Uint8Array(),
  id?: unknown,
): Promise<Record<string, unknown>> {
  const value = await f.channel.call("workspace", {
    token: f.session.token,
    request: { operation, args, input, id },
  });
  if (!value || typeof value !== "object") throw new Error("missing workspace result");
  return Object.fromEntries(Object.entries(value));
}
async function rejectsErrno(action: Promise<unknown>, errno: number): Promise<void> {
  const failure: unknown = await action.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({ errno });
}
test("private connection queries the sole workspace namespace", async () => {
  const f = await fixture();
  try {
    await call(f, "preopen", ["/"]);
    const resolved = await call(f, "resolve", [f.directory, "dir/a"]);
    expect(resolved.value).toMatchObject({ node: f.file });
    const result = await call(f, "stat", [f.file]);
    expect(result).toMatchObject({ value: { kind: "file", size: 3 } });
    expect(f.backend.shared.cells.buffer).toBe(f.root.connection.shared);
  } finally {
    await f.stop();
  }
});
test("namespace mutations use exact session identities and preserve one complete receipt", async () => {
  const f = await fixture();
  try {
    await call(f, "preopen", ["/"]);
    const id = await f.channel.call("workspaceNext", { token: f.session.token });
    const before = f.backend.shared.publication!.cut();
    const first = await call(f, "writeFile", ["/dir/c"], new Uint8Array([7]), id);
    const repeat = await call(f, "writeFile", ["/dir/c"], new Uint8Array([7]), id);
    expect(repeat.receipt).toEqual(first.receipt);
    expect(f.backend.shared.publication!.cut().generation).toBe(before.generation + 1);
    await rejectsErrno(call(f, "writeFile", ["/dir/c"], new Uint8Array([8]), id), 28);
    expect(await f.channel.call("workspaceReceipt", { token: f.session.token, id })).toMatchObject({
      kind: "committed",
      receipt: first.receipt,
    });
    expect(
      await f.channel.call("workspaceReceipt", {
        token: f.session.token,
        id: { session: 1, sequence: 1 },
      }),
    ).toEqual({ kind: "unknown" });
    expect(await f.channel.call("workspaceReceipts", { token: f.session.token })).toContainEqual({
      id,
      outcome: { kind: "committed", receipt: first.receipt },
    });
    await rejectsErrno(
      call(f, "publicationChanges", [
        f.root.connection.publication!.observer,
        before,
        limits.logBytes,
      ]),
      2,
    );
    const changes = await f.root.asyncCall("publicationChanges", [
      f.root.connection.publication!.observer,
      before,
      limits.logBytes,
    ]);
    expect(changes).toMatchObject({ kind: "changes" });
    expect(changes.publications).toHaveLength(1);
  } finally {
    await f.stop();
  }
});
test("retained files survive rename, replacement and unlink with current permissions", async () => {
  const f = await fixture();
  try {
    await call(f, "preopen", ["/"]);
    const old = await call(f, "resolve", [f.directory, "dir/a"]);
    const target = await call(f, "resolve", [f.directory, "dir/replaced"]);
    await call(f, "rename", [old.value, target.value]);
    await call(f, "writeFile", ["/dir/a"], new Uint8Array([9]));
    expect((await call(f, "read", [f.file, 3, 0])).value).toEqual(new Uint8Array([1, 2, 3]));
    const renamed = await call(f, "resolve", [f.directory, "dir/replaced"]);
    await call(f, "removePath", [renamed.value, false]);
    expect((await call(f, "stat", [f.file])).value).toMatchObject({ kind: "file", size: 3 });
    await call(f, "setMode", [f.file, 0]);
    await rejectsErrno(call(f, "read", [f.file, 3, 0]), 2);
  } finally {
    await f.stop();
  }
});

class PausedBackend extends MemoryBackend {
  started = Promise.withResolvers<void>();
  released = Promise.withResolvers<void>();
  pause = false;
  prepare(operation: string): void | Promise<void> {
    if (!this.pause || operation !== "writeFile") return;
    this.pause = false;
    this.started.resolve();
    return this.released.promise;
  }
}
test("service-side queued cancellation has no effects and stop joins its preparation", async () => {
  const backend = new PausedBackend(),
    f = await fixture(backend);
  let stopped = false;
  try {
    await call(f, "preopen", ["/"]);
    const before = backend.shared.publication!.cut();
    backend.pause = true;
    const abort = new AbortController();
    const pending = f.channel.call(
      "workspace",
      {
        token: f.session.token,
        request: { operation: "writeFile", args: ["/dir/cancelled"], input: new Uint8Array([99]) },
      },
      abort.signal,
    );
    await backend.started.promise;
    abort.abort();
    await rejectsErrno(pending, 11);
    const stop = f.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    backend.released.resolve();
    await stop;
    expect(before.generation).toBeGreaterThanOrEqual(0);
    expect(backend.fs.lookup("/dir/cancelled")).toBeUndefined();
  } finally {
    backend.released.resolve();
    if (!stopped) await f.stop();
  }
});

test("repeated joined resident stop never posts cancellation on its closed channel", async () => {
  const f = await fixture();
  try {
    const channel = new ResidentChannel(f.session.descriptor.workspace);
    const session = residentSession(await channel.call("open", f.session.descriptor));
    const client = new ResidentGrantClient(session, channel, { release: () => Promise.resolve() });
    await client.stop();
    await client.stop();
  } finally {
    await f.stop();
  }
});

function observeTransferStores(
  connection: Parameters<typeof isRevoked>[0],
  child: Parameters<typeof isRevoked>[0],
  sourceCount: number,
  targetCount: number,
  changed: string[],
): void {
  const originalStore = Atomics.store;
  Atomics.store = new Proxy(originalStore, {
    apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args);
      if (isRevoked(connection)) changed.push("service revocation");
      if (Atomics.load(new Int32Array(connection.capabilities), 0) !== sourceCount)
        changed.push("source capability header");
      if (Atomics.load(new Int32Array(child.capabilities), 0) !== targetCount)
        changed.push("target capability header");
      return result;
    },
  });
}

test("legitimate workspace reservation transfer never changes live ownership controls", async () => {
  const f = await fixture();
  const connection = createResidentConnection(f.session.descriptor);
  // Bind issued authority sessions directly: this unit exercises the real page bridge, not Web Locks.
  const parent = new FilesystemClient({ ...connection, residentPublication: undefined });
  const childIdentity = createProcessFilesystemIdentity(connection);
  const childPair = connectFilesystemIdentity(childIdentity);
  const child = new FilesystemClient({ ...childPair.client, residentPublication: undefined });
  const childChannel = new ResidentChannel(f.session.descriptor.workspace);
  const childSession = residentSession(await childChannel.call("open", f.session.descriptor));
  const changed: string[] = [];
  const originalStore = Atomics.store;
  let reservation: ReturnType<FilesystemClient["reserve"]> | undefined;
  let childBound = false;
  try {
    await parent.asyncCall("workspaceBind", [f.session]);
    await parent.asyncCall("preopen", ["/"]);
    await parent.asyncCall("resolve", [f.directory, "dir/a"]);
    reservation = parent.reserve(f.file, childIdentity);
    const sourceCount = Atomics.load(new Int32Array(connection.capabilities), 0);
    const targetCount = Atomics.load(new Int32Array(childIdentity.capabilities), 0);
    observeTransferStores(connection, childIdentity, sourceCount, targetCount, changed);
    connection.port.postMessage({ connect: childPair.server }, [childPair.server.port]);
    await child.asyncCall("workspaceBind", [childSession]);
    childBound = true;
    Atomics.store = originalStore;
    child.adopt(reservation);
    expect(Atomics.load(new Int32Array(reservation.state), 1)).toBe(1);
    expect(Atomics.load(new Int32Array(reservation.source), reservation.sourceKey + 2)).toBe(0);
    expect(await child.asyncCall("read", [f.file, 3, 0])).toEqual(new Uint8Array([1, 2, 3]));
    expect(await parent.asyncCall("stat", [f.file])).toMatchObject({ size: 3 });
    expect(isRevoked(connection)).toBe(false);
    expect(changed).toEqual([]);
  } finally {
    Atomics.store = originalStore;
    if (reservation) parent.releaseReservation(reservation);
    if (childBound) await stopWorkspaceBridge(child.connection);
    await stopWorkspaceBridge(parent.connection);
    child.dispose();
    parent.dispose();
    await childChannel.call("close", { token: childSession.token });
    childChannel.close();
    await f.stop();
  }
});

test("workspace backing proof accepts cloned aliases and rejects copied contents", () => {
  const cases = [
    { kind: "shared", words: CONNECTION_SHARED_BYTES / 4 },
    { kind: "owners", words: MAX_CONNECTION_OWNERS },
    { kind: "capabilities", words: CAPABILITY_LENGTH },
  ] as const;
  for (const { kind, words } of cases) {
    const owned = new SharedArrayBuffer((words + 1) * 4);
    const alias: SharedArrayBuffer = structuredClone(owned);
    const unrelated = new SharedArrayBuffer(owned.byteLength);
    new Int32Array(unrelated).set(new Int32Array(owned));
    expect(sameWorkspaceBacking(owned, alias, kind)).toBe(true);
    expect(sameWorkspaceBacking(owned, unrelated, kind)).toBe(false);
    expect(Atomics.load(new Int32Array(owned), words)).toBe(0);
    expect(sameWorkspaceBacking(owned, new SharedArrayBuffer(words * 4), kind)).toBe(false);
    Atomics.store(new Int32Array(unrelated), words, -1);
    expect(sameWorkspaceBacking(owned, unrelated, kind)).toBe(false);
    expect(Atomics.load(new Int32Array(owned), words)).toBe(0);
  }
});

test("only workspace allocations append identity cells and capability scans exclude them", () => {
  const ordinary = createFilesystemIdentity(undefined, SHARED_SEGMENT_BYTES);
  const file = createResidentConnection({
    kind: "file",
    workspace: "layout",
    instance: "layout",
    epoch: 1,
    description: "file",
    handle: 2,
  });
  const workspace = createResidentConnection({
    kind: "workspace",
    workspace: "layout",
    instance: "layout",
    epoch: 1,
    description: "workspace",
    handle: 2,
  });
  const parent = new FilesystemClient({ ...workspace, residentPublication: undefined });
  const child = createProcessFilesystemIdentity(workspace);
  try {
    for (const identity of [ordinary, file]) {
      expect(identity.shared.byteLength).toBe(CONNECTION_SHARED_BYTES);
      expect(identity.ownerStates.byteLength).toBe(MAX_CONNECTION_OWNERS * 4);
      expect(identity.capabilities.byteLength).toBe(CAPABILITY_LENGTH * 4);
    }
    expect(workspace.shared.byteLength).toBe(CONNECTION_SHARED_BYTES + 4);
    expect(workspace.ownerStates.byteLength).toBe(MAX_CONNECTION_OWNERS * 4 + 4);
    expect(workspace.capabilities.byteLength).toBe(CAPABILITY_LENGTH * 4 + 4);
    expect(child.capabilities.byteLength).toBe(CAPABILITY_LENGTH * 4 + 4);
    const entries = new Int32Array(child.capabilities);
    for (let slot = 0; slot < CAPABILITY_SLOTS; slot++) {
      const key = CAPABILITY_HEADER + slot * CAPABILITY_WORDS;
      entries[key] = 100 + slot;
      entries[key + 1] = 1;
      entries[key + 2] = 0;
    }
    expect(() => parent.reserve(2, child)).toThrow(expect.objectContaining({ errno: 51 }));
    expect(entries[CAPABILITY_LENGTH]).toBe(0);
    expect(() => parent.retain(999999)).toThrow(expect.objectContaining({ errno: 8 }));
  } finally {
    parent.dispose();
    file.port.close();
  }
});

test("synchronous cleanup posting failure is memoized without skipping local disposal", async () => {
  const pair = createFilesystemConnection();
  pair.client.residentPublication = {
    kind: "workspace",
    workspace: "failed-local-post",
    instance: "test",
    epoch: 1,
    description: "not-attached",
    handle: 1,
  };
  const client = new FilesystemClient(pair.client);
  const attempted = failWorkspaceCleanupPost(pair.client.port);
  try {
    expect(() => client.dispose()).not.toThrow();
    expect(isRevoked(pair.client)).toBe(true);
    await expect(client.stopResidentPublication()).rejects.toThrow(workspaceCleanupPostFailure);
    client.dispose();
    await expect(client.stopResidentPublication()).rejects.toThrow(workspaceCleanupPostFailure);
    expect(attempted()).toBe(1);
  } finally {
    pair.client.port.close();
    pair.server.port.close();
  }
});

function observeBridgeStop() {
  const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
  const setter = descriptor?.set;
  if (!descriptor || !setter) throw new Error("native port message setter missing");
  const started = Promise.withResolvers<void>();
  Object.defineProperty(MessagePort.prototype, "onmessage", {
    ...descriptor,
    set(this: MessagePort, handler: MessagePort["onmessage"]) {
      setter.call(this, (event: MessageEvent<unknown>) => {
        const data = event.data;
        if (data && typeof data === "object" && "stopWorkspace" in data)
          setTimeout(started.resolve, 0);
        handler?.call(this, event);
      });
    },
  });
  return {
    started: started.promise,
    restore: () => Object.defineProperty(MessagePort.prototype, "onmessage", descriptor),
  };
}

test("parent cleanup joins a pre-bind child cancelled after stopping is observed", async () => {
  const f = await fixture();
  const observation = observeBridgeStop();
  const connection = createResidentConnection(f.session.descriptor);
  const parent = new FilesystemClient({ ...connection, residentPublication: undefined });
  observation.restore();
  const childIdentity = createProcessFilesystemIdentity(connection);
  const childPair = connectFilesystemIdentity(childIdentity);
  const child = new FilesystemClient({ ...childPair.client, residentPublication: undefined });
  let joined: Promise<void> | undefined;
  try {
    await parent.asyncCall("workspaceBind", [f.session]);
    await parent.asyncCall("preopen", ["/"]);
    await parent.asyncCall("resolve", [f.directory, "dir/a"]);
    const reservation = parent.reserve(f.file, childIdentity);
    connection.port.postMessage({ connect: childPair.server }, [childPair.server.port]);
    await rejectsErrno(child.asyncCall("stat", [f.file]), 11);
    await parent.asyncCall("stat", [f.file]);
    joined = stopWorkspaceBridge(parent.connection);
    void joined.catch(() => {});
    await observation.started;
    console.log("LATE_CANCEL_STAGE parent-stopping-child-still-live");
    expect(isRevoked(childIdentity)).toBe(false);
    expect(Atomics.load(new Int32Array(reservation.state), 0)).toBe(0);
    revokeFilesystem(childIdentity);
    releaseFilesystemReservation(reservation);
    await stopWorkspaceBridge(childPair.client);
    console.log("LATE_CANCEL_STAGE child-cleanup-joined");
    await joined;
    expect(Atomics.load(new Int32Array(reservation.state), 0)).toBe(1);
  } finally {
    await joined?.catch(() => {});
    child.dispose();
    parent.dispose();
    await f.stop();
  }
});

async function bridgeRequest(connection: FilesystemConnection, operation: string, args: unknown[]) {
  const bytes = pack({ operation, args });
  const buffer = new SharedArrayBuffer(HEADER + bytes.length);
  const cells = new Int32Array(buffer, 0, HEADER / 4);
  cells[1] = bytes.length;
  new Uint8Array(buffer, HEADER).set(bytes);
  const completed = Promise.withResolvers<void>();
  const receive = () => completed.resolve();
  connection.port.addEventListener("message", receive, { once: true });
  try {
    connection.port.postMessage({ id: 1, buffer });
    await completed.promise;
    return { state: cells[0], errno: cells[3] };
  } finally {
    connection.port.removeEventListener("message", receive);
  }
}
function observeReceiverInstalls() {
  const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
  const setter = descriptor?.set;
  if (!descriptor || !setter) throw new Error("native port message setter missing");
  const observation = { installed: 0 };
  Object.defineProperty(MessagePort.prototype, "onmessage", {
    ...descriptor,
    set(this: MessagePort, handler: MessagePort["onmessage"]) {
      observation.installed++;
      setter.call(this, handler);
    },
  });
  return {
    observation,
    restore: () => Object.defineProperty(MessagePort.prototype, "onmessage", descriptor),
  };
}
async function cleanupFixture() {
  const f = await fixture();
  const stopping = observeBridgeStop();
  const connection = createResidentConnection(f.session.descriptor);
  stopping.restore();
  const parent = new FilesystemClient({ ...connection, residentPublication: undefined });
  await parent.asyncCall("workspaceBind", [f.session]);
  await parent.asyncCall("preopen", ["/"]);
  await parent.asyncCall("resolve", [f.directory, "dir/a"]);
  const identity = createProcessFilesystemIdentity(connection);
  const pair = connectFilesystemIdentity(identity);
  const reservation = parent.reserve(f.file, identity);
  return {
    f,
    parent,
    connection,
    identity,
    pair,
    reservation,
    stopping,
    cancel() {
      revokeFilesystem(identity);
      releaseFilesystemReservation(reservation);
    },
    connect() {
      connection.port.postMessage({ connect: pair.server }, [pair.server.port]);
    },
    async close() {
      pair.client.port.close();
      pair.server.port.close();
      parent.dispose();
      await f.stop();
    },
  };
}

test("released pre-connect child has cleanup only and parent waits for its actual stop", async () => {
  const f = await cleanupFixture();
  const child = new FilesystemClient(f.pair.client);
  let joined: Promise<void> | undefined;
  const post = BroadcastChannel.prototype.postMessage;
  const authorityRequests: unknown[] = [];
  BroadcastChannel.prototype.postMessage = function (value: unknown) {
    authorityRequests.push(value);
    post.call(this, value);
  };
  try {
    f.cancel();
    f.connect();
    expect(await bridgeRequest(f.pair.client, "workspaceBind", [f.f.session])).toEqual({
      state: State.Cancelled,
      errno: 11,
    });
    expect(await bridgeRequest(f.pair.client, "writeFile", ["/dir/forbidden"])).toEqual({
      state: State.Cancelled,
      errno: 11,
    });
    expect(authorityRequests).toEqual([]);
    expect(f.f.backend.fs.lookup("/dir/forbidden")).toBeUndefined();
    let parentStopped = false;
    joined = stopWorkspaceBridge(f.connection).then(() => {
      parentStopped = true;
    });
    void joined.catch(() => {});
    await f.stopping.started;
    expect(parentStopped).toBe(false);
    await child.stopResidentPublication();
    await child.stopResidentPublication();
    child.dispose();
    await child.stopResidentPublication();
    await joined;
    expect(parentStopped).toBe(true);
    expect(Array.from(new Int32Array(f.reservation.state))).toEqual([1, 2]);
    expect(new Int32Array(f.reservation.source)[f.reservation.sourceKey + 2]).toBe(0);
    expect(new Int32Array(f.reservation.target)[f.reservation.targetKey + 1]).toBe(0);
    expect(authorityRequests).toEqual([]);
  } finally {
    BroadcastChannel.prototype.postMessage = post;
    await joined?.catch(() => {});
    child.dispose();
    await f.close();
  }
});

test("revoked parent still receives its proven cancelled child without live admission", async () => {
  const f = await cleanupFixture();
  try {
    f.cancel();
    revokeFilesystem(f.connection);
    f.connect();
    expect(await bridgeRequest(f.pair.client, "workspaceBind", [f.f.session])).toMatchObject({
      errno: 11,
    });
    await stopWorkspaceBridge(f.pair.client);
    await stopWorkspaceBridge(f.connection);
  } finally {
    await f.close();
  }
});

test("parent stopping joins a proven cancelled connect delivered during an older child join", async () => {
  const f = await cleanupFixture();
  const older = createProcessFilesystemIdentity(f.connection);
  const olderPair = connectFilesystemIdentity(older);
  const olderReservation = f.parent.reserve(f.f.file, older);
  let joined: Promise<void> | undefined;
  try {
    f.connection.port.postMessage({ connect: olderPair.server }, [olderPair.server.port]);
    await f.parent.asyncCall("stat", [f.f.file]);
    let parentStopped = false;
    joined = stopWorkspaceBridge(f.connection).then(() => {
      parentStopped = true;
    });
    void joined.catch(() => {});
    await f.stopping.started;
    f.cancel();
    f.connect();
    expect(await bridgeRequest(f.pair.client, "workspaceBind", [f.f.session])).toMatchObject({
      errno: 11,
    });
    revokeFilesystem(older);
    releaseFilesystemReservation(olderReservation);
    await stopWorkspaceBridge(olderPair.client);
    expect(parentStopped).toBe(false);
    await stopWorkspaceBridge(f.pair.client);
    await joined;
    expect(parentStopped).toBe(true);
  } finally {
    await joined?.catch(() => {});
    olderPair.client.port.close();
    olderPair.server.port.close();
    await f.close();
  }
});

type InvalidConnection = (child: FilesystemConnection, parent: FilesystemConnection) => unknown;
const invalidCleanupConnections: readonly [string, InvalidConnection][] = [
  ["copied shared backing", (child) => ({ ...child, shared: child.shared.slice(0) })],
  ["copied owner backing", (child) => ({ ...child, ownerStates: child.ownerStates.slice(0) })],
  [
    "descriptor identity",
    (child) => ({
      ...child,
      residentPublication: { ...child.residentPublication!, description: "other" },
    }),
  ],
  ["parent owner", (child, parent) => ({ ...child, owner: parent.owner })],
  ["unallocated owner", (child) => ({ ...child, owner: MAX_CONNECTION_OWNERS - 1 })],
  ["malformed own revocation", (child) => ({ ...child, revocations: [new SharedArrayBuffer(8)] })],
  [
    "ancestor-only revocation",
    (child) => ({ ...child, revocations: [new SharedArrayBuffer(4)].concat(child.revocations) }),
  ],
  [
    "copied source backing",
    (child) => invalidReservation(child, { source: child.reservations[0]!.source.slice(0) }),
  ],
  [
    "copied target backing",
    (child) => invalidReservation(child, { target: child.capabilities.slice(0) }),
  ],
  ["wrong target owner", (child) => invalidReservation(child, { targetOwner: child.owner + 1 })],
  [
    "unaligned source key",
    (child) => invalidReservation(child, { sourceKey: CAPABILITY_HEADER + 1 }),
  ],
  [
    "out of range target key",
    (child) => invalidReservation(child, { targetKey: CAPABILITY_LENGTH }),
  ],
  [
    "unproven handle",
    (child) => invalidReservation(child, { handle: child.reservations[0]!.handle + 1 }),
  ],
  [
    "short reservation state",
    (child) => invalidReservation(child, { state: new SharedArrayBuffer(4) }),
  ],
  ["live reservation", (child) => invalidReservation(child, { state: new SharedArrayBuffer(8) })],
  [
    "adopted reservation",
    (child) => {
      const state = new SharedArrayBuffer(8);
      new Int32Array(state).set([1, 1]);
      return invalidReservation(child, { state });
    },
  ],
  [
    "unbounded reservations",
    (child) => ({
      ...child,
      reservations: Array.from({ length: CAPABILITY_SLOTS + 1 }, () => child.reservations[0]!),
    }),
  ],
];
function invalidReservation(
  child: FilesystemConnection,
  change: Partial<FilesystemIdentity["reservations"][number]>,
) {
  return { ...child, reservations: [{ ...child.reservations[0]!, ...change }] };
}
for (const [name, invalid] of invalidCleanupConnections) {
  test(`pre-connect cleanup rejects ${name} without installing a receiver`, async () => {
    const f = await cleanupFixture();
    const observer = observeReceiverInstalls();
    try {
      f.cancel();
      f.connection.port.postMessage({ connect: invalid(f.pair.server, f.connection) }, [
        f.pair.server.port,
      ]);
      await f.parent.asyncCall("stat", [f.f.file]);
      expect(observer.observation.installed).toBe(0);
      expect(Array.from(new Int32Array(f.reservation.state))).toEqual([1, 2]);
      await stopWorkspaceBridge(f.connection);
    } finally {
      observer.restore();
      await f.close();
    }
  });
}

function transportClock() {
  const deadlines = new Map<Parameters<typeof clearTimeout>[0], () => void>();
  const native = globalThis.setTimeout;
  const nativeClear = globalThis.clearTimeout;
  globalThis.clearTimeout = new Proxy(nativeClear, {
    apply(target, receiver, args: Parameters<typeof clearTimeout>) {
      if (args[0] !== undefined) deadlines.delete(args[0]);
      return Reflect.apply(target, receiver, args);
    },
  });
  globalThis.setTimeout = new Proxy(native, {
    apply(target, receiver, args: Parameters<typeof setTimeout>) {
      const timer = Reflect.apply(target, receiver, args);
      if (args[1] === 3000) deadlines.set(timer, () => args[0]());
      return timer;
    },
  });
  return {
    expire() {
      const due = Array.from(deadlines);
      deadlines.clear();
      for (const [timer, fire] of due) {
        clearTimeout(timer);
        fire();
      }
    },
    restore() {
      globalThis.setTimeout = native;
      globalThis.clearTimeout = nativeClear;
      for (const timer of deadlines.keys()) clearTimeout(timer);
    },
  };
}

function holdTransportReplies(client?: string, includeReconciliation = true) {
  const held: { channel: BroadcastChannel; message: unknown }[] = [];
  const native = BroadcastChannel.prototype.postMessage;
  BroadcastChannel.prototype.postMessage = function (this: BroadcastChannel, message: unknown) {
    if (
      message &&
      typeof message === "object" &&
      "client" in message &&
      (client === undefined || message.client === client) &&
      "kind" in message &&
      (message.kind === "reply" || (includeReconciliation && message.kind === "reconcileReply"))
    ) {
      held.push({ channel: this, message: structuredClone(message) });
      return;
    }
    native.call(this, message);
  };
  return {
    held,
    release() {
      BroadcastChannel.prototype.postMessage = native;
      for (const item of held) native.call(item.channel, item.message);
    },
  };
}

async function remainsPending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Bun.sleep(10);
  expect(settled).toBe(false);
}

for (const operation of ["writeFile", "missing-operation"]) {
  test(`late ${operation === "writeFile" ? "success" : "error"} reconciles only its exact transport identity`, async () => {
    const f = await fixture();
    const held = holdTransportReplies(f.channel.id);
    const clock = transportClock();
    const observer = new BroadcastChannel(`waffle:resident:${f.session.descriptor.workspace}`);
    try {
      const before = f.backend.shared.publication!.cut();
      const pending = call(f, operation, ["/dir/late"], new Uint8Array([9]));
      const failed = rejectsErrno(pending, 6);
      while (!held.held.length) await Bun.sleep(0);
      clock.expire();
      await failed;
      expect(() => f.channel.assertSettled()).toThrow();
      observer.postMessage({ kind: "reply", client: "foreign", id: "foreign", value: null });
      observer.postMessage({ kind: "reply", client: f.channel.id, id: "foreign", value: null });
      await Bun.sleep(10);
      observer.postMessage({
        kind: "reply",
        client: f.channel.id,
        id: record(held.held[0]!.message).id,
        errno: "invalid",
      });
      await Bun.sleep(10);
      expect(() => f.channel.assertSettled()).toThrow();
      held.release();
      await Bun.sleep(10);
      expect(() => f.channel.assertSettled()).not.toThrow();
      expect(f.backend.shared.publication!.cut().generation).toBe(
        before.generation + (operation === "writeFile" ? 1 : 0),
      );
      observer.postMessage(held.held[0]!.message);
      await Bun.sleep(10);
      expect(() => f.channel.assertSettled()).not.toThrow();
    } finally {
      held.release();
      clock.restore();
      observer.close();
      await f.stop();
    }
  });
}

test("authoritative terminal receipt reconciles an original timeout before the held reply arrives", async () => {
  const f = await fixture();
  const held = holdTransportReplies(f.channel.id, false);
  const clock = transportClock();
  try {
    const pending = call(f, "missing-operation", [f.file]);
    const failed = rejectsErrno(pending, 6);
    while (!held.held.length) await Bun.sleep(0);
    clock.expire();
    await failed;

    const joined = f.channel.joinSettled();
    let settled = false;
    void joined.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Bun.sleep(10);
    expect(settled).toBe(true);
    await joined;
    expect(() => f.channel.assertSettled()).not.toThrow();
  } finally {
    held.release();
    clock.restore();
    await f.stop();
  }
});

test("no authoritative terminal receipt preserves the original cleanup debt", async () => {
  const channel = new ResidentChannel(`absent-${crypto.randomUUID()}`);
  const clock = transportClock();
  try {
    const pending = channel.call("workspace", {});
    const failed = rejectsErrno(pending, 6);
    clock.expire();
    await failed;

    const joined = channel.joinSettled();
    void joined.catch(() => {});
    await remainsPending(joined);
    clock.expire();
    await remainsPending(joined);
    expect(() => channel.assertSettled()).toThrow();
  } finally {
    clock.restore();
    channel.close();
  }
});

test("owner drain accepts only the original close after its first refusal", async () => {
  const f = await fixture();
  const clock = transportClock();
  try {
    await rejectsErrno(f.server.drainForOwner(), 6);

    const closing = f.channel.finish("closeConnection", null);
    let settled = false;
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Bun.sleep(10);
    expect(settled).toBe(true);
    await closing;
    await f.server.drainForOwner();
  } finally {
    clock.expire();
    clock.restore();
    f.channel.close();
    await f.server.stop().catch(() => {});
    f.root.dispose();
    f.service.dispose();
  }
});

test("unresolved timeout identities keep the original sixteen-call admission bound", async () => {
  const channel = new ResidentChannel(`absent-${crypto.randomUUID()}`);
  const clock = transportClock();
  try {
    const failed = Array.from({ length: 16 }, () => rejectsErrno(channel.call("workspace", {}), 6));
    clock.expire();
    await Promise.all(failed);
    const refused = channel.call("workspace", {});
    const failure = refused.catch((error: unknown) => error);
    let rejected = false;
    void refused.catch(() => {
      rejected = true;
    });
    await Bun.sleep(10);
    expect(rejected).toBe(true);
    expect(await failure).toMatchObject({ errno: 6 });
  } finally {
    clock.restore();
    channel.close();
  }
});

test("original bridge stop joins unknown cancellation and actual service preparation", async () => {
  const backend = new PausedBackend();
  const f = await fixture(backend);
  const connection = createResidentConnection(f.session.descriptor);
  const client = new FilesystemClient({ ...connection, residentPublication: undefined });
  const clock = transportClock();
  let stopping: Promise<void> | undefined;
  let held: ReturnType<typeof holdTransportReplies> | undefined;
  try {
    await client.asyncCall("workspaceBind", [f.session]);
    await client.asyncCall("preopen", ["/"]);
    const id = await f.channel.call("workspaceNext", { token: f.session.token });
    held = holdTransportReplies();
    backend.pause = true;
    const writing = client.asyncCall(
      "workspaceMutation",
      [id, "writeFile", ["/dir/timeout"]],
      new Uint8Array([9]),
    );
    const failed = rejectsErrno(writing, 6);
    await backend.started.promise;
    clock.expire();
    await failed;
    while (!held.held.length) await Bun.sleep(0);
    stopping = stopWorkspaceBridge(connection);
    void stopping.catch(() => {});
    await remainsPending(stopping);
    const repeated = stopWorkspaceBridge(connection);
    await remainsPending(repeated);
    clock.expire();
    await remainsPending(stopping);
    held.release();
    await Promise.all([stopping, repeated]);
    expect(await f.channel.call("workspaceReceipt", { token: f.session.token, id })).toEqual({
      kind: "retired",
    });
    const close = f.channel.call("close", { token: f.session.token });
    await remainsPending(close);
    backend.released.resolve();
    await close;
    expect(backend.fs.lookup("/dir/timeout")).toBeUndefined();
  } finally {
    backend.released.resolve();
    held?.release();
    clock.restore();
    await stopping?.catch(() => {});
    client.dispose();
    await f.stop();
  }
});

test("original resident stop consumes a late close reply once without releasing its guard early", async () => {
  const f = await fixture();
  const channel = new ResidentChannel(f.session.descriptor.workspace);
  const session = residentSession(await channel.call("open", f.session.descriptor));
  let released = 0;
  const client = new ResidentGrantClient(session, channel, {
    async release() {
      released++;
    },
  });
  const held = holdTransportReplies(channel.id);
  const clock = transportClock();
  let stopped: Promise<void> | undefined;
  try {
    stopped = client.stop();
    expect(client.stop()).toBe(stopped);
    while (!held.held.length) await Bun.sleep(0);
    clock.expire();
    await remainsPending(stopped);
    expect(released).toBe(0);
    held.release();
    await stopped;
    expect(released).toBe(1);
    expect(client.stop()).toBe(stopped);
    await stopped;
    expect(released).toBe(1);
  } finally {
    held.release();
    clock.restore();
    await stopped?.catch(() => {});
    channel.close();
    await f.stop();
  }
});

test("a claimed grant is not retired by a timeout reply or an original close attempt", async () => {
  const f = await fixture();
  const channel = new ResidentChannel(f.session.descriptor.workspace);
  const session = residentSession(await channel.call("open", f.session.descriptor));
  let released = 0;
  const client = new ResidentGrantClient(session, channel, {
    async release() {
      released++;
    },
  });
  let cell: ResidentGrantCell | undefined;
  let held: ReturnType<typeof holdTransportReplies> | undefined;
  const clock = transportClock();
  try {
    await call(f, "preopen", ["/"]);
    await call(f, "resolve", [f.directory, "dir/a"]);
    await f.channel.call("workspaceAdopt", {
      token: session.token,
      source: f.session.token,
      handles: [f.file],
    });
    const grant = residentGrant(
      await channel.call("prepare", {
        token: session.token,
        handle: f.file,
        request: { kind: "read", offset: 0, maxBytes: 1 },
      }),
    );
    cell = new ResidentGrantCell(grant);
    Atomics.store(cell.state, 0, 1);
    channel.status = () => cell?.snapshot();
    held = holdTransportReplies(channel.id);
    const settling = channel.call("settle", {
      token: session.token,
      outcome: encodeResidentOutcome(cell.snapshot()),
    });
    const failure = rejectsErrno(settling, 6);
    while (!held.held.length) await Bun.sleep(0);
    clock.expire();
    await failure;
    expect(() => channel.assertSettled()).toThrow();
    held.release();
    await channel.joinSettled();
    const stopped = client.stop();
    await rejectsErrno(stopped, 6);
    expect(client.stop()).toBe(stopped);
    expect(released).toBe(0);
    expect(cell.snapshot()).toEqual({ kind: "claimed", grant: grant.key });
    Atomics.store(cell.state, 0, 0);
    cell.cancel();
    await channel.finish("settle", {
      token: session.token,
      outcome: encodeResidentOutcome(cell.snapshot()),
    });
    await channel.finish("close", { token: session.token });
    await rejectsErrno(stopped, 6);
    expect(released).toBe(0);
  } finally {
    held?.release();
    clock.restore();
    channel.close();
    await f.stop();
  }
});

test("late prepared grant is cancelled and settled by the original stop without a write", async () => {
  const f = await fixture();
  const channel = new ResidentChannel(f.session.descriptor.workspace);
  const session = residentSession(await channel.call("open", f.session.descriptor));
  let released = 0;
  const client = new ResidentGrantClient(session, channel, {
    async release() {
      released++;
    },
  });
  await call(f, "preopen", ["/"]);
  await call(f, "resolve", [f.directory, "dir/a"]);
  await f.channel.call("workspaceAdopt", {
    token: session.token,
    source: f.session.token,
    handles: [f.file],
  });
  const held = holdTransportReplies(channel.id);
  const clock = transportClock();
  let stopped: Promise<void> | undefined;
  try {
    const before = f.backend.shared.publication!.cut();
    const preparing = client.prepare({ kind: "append", maxBytes: 1 }, f.file);
    const failed = rejectsErrno(preparing, 6);
    while (!held.held.length) await Bun.sleep(0);
    clock.expire();
    await failed;
    expect(client.tryAppend(f.file, [new Uint8Array([9])])).toBe(-6);
    stopped = client.stop();
    void stopped.catch(() => {});
    await remainsPending(stopped);
    expect(released).toBe(0);
    held.release();
    await stopped;
    expect(released).toBe(1);
    expect(f.backend.shared.publication!.cut()).toEqual(before);
    expect(client.stop()).toBe(stopped);
  } finally {
    held.release();
    clock.restore();
    await stopped?.catch(() => {});
    // A failed implementation leaves the actual issued grant for fixture teardown.
    const late = held.held[0];
    if (late && released === 0) {
      const grant = residentGrant(record(late.message).value);
      const cell = new ResidentGrantCell(grant);
      cell.cancel();
      await channel.finish("settle", {
        token: session.token,
        outcome: encodeResidentOutcome(cell.snapshot()),
      });
      await channel.finish("close", { token: session.token });
    }
    channel.close();
    await f.stop();
  }
});

for (const operation of ["stat", "missing-operation"]) {
  test(`workspace cleanup joins a timed-out ${operation} terminal reply without inventing cleanup failure`, async () => {
    const f = await fixture();
    const connection = createResidentConnection(f.session.descriptor);
    const client = new FilesystemClient({ ...connection, residentPublication: undefined });
    const clock = transportClock();
    let held: ReturnType<typeof holdTransportReplies> | undefined;
    let stopping: Promise<void> | undefined;
    const terminal: string[] = [];
    try {
      await client.asyncCall("workspaceBind", [f.session]);
      await client.asyncCall("preopen", ["/"]);
      held = holdTransportReplies();
      const pending = client.asyncCall(operation, [f.file]);
      const failed = rejectsErrno(pending, 6);
      while (!held.held.length) await Bun.sleep(0);
      clock.expire();
      await failed;
      stopping = stopWorkspaceBridge(connection);
      void stopping.then(
        () => terminal.push("stopped"),
        () => terminal.push("cleanup-error"),
      );
      clock.expire();
      await remainsPending(stopping);
      expect(terminal).toEqual([]);
      const repeated = stopWorkspaceBridge(connection);
      await remainsPending(repeated);
      expect(terminal).toEqual([]);
      held.release();
      await Promise.all([stopping, repeated]);
      expect(terminal).toEqual(["stopped"]);
      expect(() => f.channel.assertSettled()).not.toThrow();
    } finally {
      held?.release();
      clock.restore();
      await stopping?.catch(() => {});
      client.dispose();
      await f.stop();
    }
  });
}

test("public snapshot/change projection includes resident namespace authority writes", async () => {
  const f = await fixture();
  const workspace = createWorkspaceVfs(f.root);
  try {
    const cursor = workspace.snapshot();
    let page = await cursor.next();
    while (page.kind === "entries") page = await cursor.next();
    if (page.kind !== "complete") throw new Error(`unexpected snapshot ${page.kind}`);
    const id = await f.channel.call("workspaceNext", { token: f.session.token });
    const result = await call(f, "writeFile", ["/dir/resident"], new Uint8Array([17]), id);
    await f.root.asyncCall("move", ["/dir/resident", "/dir/later"]);
    const changes = await workspace.changes(page.cut.watermark);
    if (changes.kind !== "changes") throw new Error(`unexpected changes ${changes.kind}`);
    expect(changes.batches).toHaveLength(2);
    const sequence = record(record(result.receipt).id).sequence;
    if (typeof sequence !== "number") throw new Error("missing resident sequence");
    expect(changes.batches[0]?.transaction.sequence).toBe(sequence);
    expect(changes.batches[0]?.changes).toContainEqual(
      expect.objectContaining({ kind: "write", paths: ["/dir/resident"], size: 1 }),
    );
    expect(changes.batches[1]?.changes).toContainEqual(
      expect.objectContaining({ kind: "entry", beforePath: "/dir/resident", afterPath: null }),
    );
  } finally {
    await workspace.close();
    await f.stop();
  }
});

test("cleanup reconciliation cancels only the exact original client and request pair", async () => {
  const f = await fixture();
  const observer = new BroadcastChannel(`waffle:resident:${f.session.descriptor.workspace}`);
  const held = holdTransportReplies(f.channel.id, false);
  const clock = transportClock();
  const requests: Record<string, unknown>[] = [];
  const cancellations: Record<string, unknown>[] = [];
  observer.onmessage = ({ data }: MessageEvent<unknown>) => {
    const message = record(data);
    if (message.client !== f.channel.id) return;
    if (message.kind === "request") requests.push(message);
    if (message.kind === "cancel") cancellations.push(message);
  };
  try {
    const before = f.backend.shared.publication!.cut();
    const pending = call(f, "writeFile", ["/dir/exact-cancellation"], new Uint8Array([9]));
    const failed = rejectsErrno(pending, 6);
    while (!held.held.length || !requests.length) await Bun.sleep(0);
    const original = requests[0]!;
    observer.postMessage({ kind: "cancel", client: "foreign", id: original.id });
    observer.postMessage({ kind: "cancel", client: original.client, id: "foreign" });
    clock.expire();
    await failed;
    while (!cancellations.length) await Bun.sleep(0);
    expect(cancellations).toContainEqual({
      kind: "cancel",
      client: original.client,
      id: original.id,
    });
    observer.postMessage(original);
    while (held.held.length < 2) await Bun.sleep(0);
    await f.channel.joinSettled();
    expect(f.backend.shared.publication!.cut().generation).toBe(before.generation + 1);
    expect(held.held[1]!.message).toEqual(held.held[0]!.message);
  } finally {
    held.release();
    clock.restore();
    observer.close();
    await f.stop();
  }
});

test("cleanup reconciliation keeps an unknown original request and its guard owned", async () => {
  const workspace = `unknown-${crypto.randomUUID()}`;
  const channel = new ResidentChannel(workspace);
  const observer = new BroadcastChannel(`waffle:resident:${workspace}`);
  const clock = transportClock();
  const session = {
    token: "original",
    descriptor: {
      ...residentDescriptor({
        kind: "workspace",
        workspace,
        instance: "original",
        epoch: 1,
        description: "original",
        handle: 1,
      }),
    },
    session: { slot: 1, serial: 1 },
  };
  let released = 0;
  const client = new ResidentGrantClient(session, channel, {
    async release() {
      released++;
    },
  });
  const received = Promise.withResolvers<Record<string, unknown>>();
  const probed = Promise.withResolvers<void>();
  observer.onmessage = ({ data }: MessageEvent<unknown>) => {
    const message = record(data);
    if (message.kind === "request") received.resolve(message);
    if (message.kind !== "reconcile") return;
    observer.postMessage({ ...message, kind: "reconcileReply", state: "unknown" });
    probed.resolve();
  };
  let stopped: Promise<void> | undefined;
  try {
    const pending = channel.call("workspace", {});
    const failed = rejectsErrno(pending, 6);
    const original = await received.promise;
    clock.expire();
    await failed;
    stopped = client.stop();
    void stopped.catch(() => {});
    await probed.promise;
    await remainsPending(stopped);
    expect(client.stop()).toBe(stopped);
    expect(() => channel.assertSettled()).toThrow();
    expect(released).toBe(0);
    observer.postMessage({ kind: "reply", client: "foreign", id: original.id, value: null });
    await remainsPending(stopped);
    expect(released).toBe(0);
  } finally {
    clock.restore();
    channel.close();
    await stopped?.catch(() => {});
    observer.close();
  }
});

test("cleanup reconciliation replays the original close failure without releasing its guard", async () => {
  const f = await fixture();
  const channel = new ResidentChannel(f.session.descriptor.workspace);
  const session = residentSession(await channel.call("open", f.session.descriptor));
  let released = 0;
  let closes = 0;
  const native = f.server.authority.close.bind(f.server.authority);
  f.server.authority.close = (value) => {
    if (value.token !== session.token) return native(value);
    closes++;
    throw new Error("original cleanup failure");
  };
  const client = new ResidentGrantClient(session, channel, {
    async release() {
      released++;
    },
  });
  const held = holdTransportReplies(channel.id, false);
  const clock = transportClock();
  let stopped: Promise<void> | undefined;
  try {
    stopped = client.stop();
    void stopped.catch(() => {});
    while (!held.held.length) await Bun.sleep(0);
    clock.expire();
    await rejectsErrno(stopped, 29);
    expect(client.stop()).toBe(stopped);
    await rejectsErrno(client.stop(), 29);
    expect(closes).toBe(1);
    expect(released).toBe(0);
    await rejectsErrno(f.server.drainForOwner(), 6);
  } finally {
    f.server.authority.close = native;
    held.release();
    clock.restore();
    await channel.finish("closeConnection", null);
    channel.close();
    await f.stop();
  }
});
