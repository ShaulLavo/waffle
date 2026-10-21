import { expect, test } from "bun:test";
import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
} from "../fs";
import { ResidentAuthorityServer } from "../browser/publication-authority";
import {
  ResidentChannel,
  ResidentGrantClient,
  createResidentConnection,
  residentDescriptor,
  residentSession,
} from "../fs/publication-attachment";
import {
  CAPABILITY_HEADER,
  CAPABILITY_LENGTH,
  CAPABILITY_SLOTS,
  CAPABILITY_WORDS,
  CONNECTION_SHARED_BYTES,
  MAX_CONNECTION_OWNERS,
  SHARED_SEGMENT_BYTES,
  connectFilesystemIdentity,
  createFilesystemIdentity,
  createProcessFilesystemIdentity,
  isRevoked,
} from "../fs/protocol";
import { sameWorkspaceBacking } from "../fs/publication-workspace";
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
    session,
    root,
    backend,
    directory,
    file: file.node,
    async stop() {
      await channel.call("close", { token: session.token });
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
  await expect(action).rejects.toMatchObject({ errno });
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
    Atomics.store = new Proxy(originalStore, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args);
        if (isRevoked(connection)) changed.push("service revocation");
        if (Atomics.load(new Int32Array(connection.capabilities), 0) !== sourceCount)
          changed.push("source capability header");
        if (Atomics.load(new Int32Array(childIdentity.capabilities), 0) !== targetCount)
          changed.push("target capability header");
        return result;
      },
    });
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
    if (childBound) await child.asyncCall("workspaceBridgeStop");
    await parent.asyncCall("workspaceBridgeStop");
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
