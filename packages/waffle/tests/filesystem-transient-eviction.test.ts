import { expect, test } from "bun:test";
import { FilesystemClient, FilesystemService, MemoryBackend, type FilesystemBackend } from "../fs";
import {
  CAPABILITY_HEADER,
  CAPABILITY_LENGTH,
  CAPABILITY_WORDS,
  TRANSIENT_HANDLES,
  connectFilesystemIdentity,
  createFilesystemIdentity,
} from "../fs/protocol";

test("resolving past the transient bound evicts a batch under one epoch change", async () => {
  const service = new FilesystemService(new MemoryBackend());
  const pair = connectFilesystemIdentity(createFilesystemIdentity(undefined, 16 * 1024 * 1024));
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  try {
    const count = TRANSIENT_HANDLES + 60;
    await client.asyncCall("mkdirp", ["/many"]);
    for (let index = 0; index < count; index++)
      await client.asyncCall("writeFile", [`/many/${index}`], new Uint8Array([index & 255]));
    const root = await client.asyncCall("preopen", ["/"]);
    const epoch = new Int32Array(pair.client.epoch);
    const capabilities = new Int32Array(pair.client.capabilities);
    const before = Atomics.load(epoch, 0);
    const handles: number[] = [];
    for (let index = 0; index < count; index++)
      handles.push((await client.asyncCall("resolve", [root, `many/${index}`])).node);
    // One mutation (begin and end) dropped the least recently used half, not one per resolve.
    expect(Atomics.load(epoch, 0) - before).toBe(2);
    expect(Atomics.load(capabilities, 0)).toBeLessThanOrEqual(TRANSIENT_HANDLES);
    expect(Atomics.load(capabilities, 0)).toBeGreaterThan(TRANSIENT_HANDLES / 2);
    // The newest answer still names a live capability; the oldest was evicted.
    expect((await client.asyncCall("stat", [handles[count - 1]])).size).toBe(1);
    expect(
      await client.asyncCall("stat", [handles[0]]).then(
        () => 0,
        (error) => error.errno,
      ),
    ).toBe(8);
  } finally {
    client.dispose();
    await service.drainForOwner();
    service.dispose();
    pair.client.port.close();
    pair.server.port.close();
  }
});

test("a custom backend's evictions inside a creating request keep the epoch odd throughout", async () => {
  const memory = new MemoryBackend();
  let epoch: Int32Array | undefined;
  const releasedAt: number[] = [];
  // No shared state: the service marks mutations on the epoch alone.
  const backend: FilesystemBackend = {
    execute: memory.execute.bind(memory),
    retain: memory.retain.bind(memory),
    release(handle) {
      if (epoch) releasedAt.push(Atomics.load(epoch, 0));
      memory.release(handle);
    },
  };
  const service = new FilesystemService(backend);
  const pair = connectFilesystemIdentity(createFilesystemIdentity(undefined, 16 * 1024 * 1024));
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  try {
    await client.asyncCall("mkdirp", ["/many"]);
    for (let index = 0; index < TRANSIENT_HANDLES; index++)
      await client.asyncCall("writeFile", [`/many/${index}`], new Uint8Array([index & 255]));
    const root = await client.asyncCall("preopen", ["/"]);
    epoch = new Int32Array(pair.client.epoch);
    // Fill the bound without an eviction yet. The directory and the latest answer stay
    // response-held, so the idle count shown here stops two short of the bound.
    const missing = await client.asyncCall("resolve", [root, "many/created"]);
    for (
      let index = 0;
      index < TRANSIENT_HANDLES && service.resources().transient < TRANSIENT_HANDLES - 2;
      index++
    )
      await client.asyncCall("resolve", [root, `many/${index}`]);
    expect(releasedAt).toEqual([]);
    const before = Atomics.load(epoch, 0);
    expect(before & 1).toBe(0);
    // Creating pins one more transient capability, so its own trim evicts inside the request.
    await client.asyncCall("create", [missing, "file", true]);
    expect(releasedAt.length).toBeGreaterThan(TRANSIENT_HANDLES / 2);
    expect(releasedAt.filter((value) => (value & 1) === 0)).toEqual([]);
    // One mutation: odd for the whole request, even again after it.
    expect(new Set(releasedAt)).toEqual(new Set([before + 1]));
    expect(Atomics.load(epoch, 0)).toBe(before + 2);
  } finally {
    client.dispose();
    await service.drainForOwner();
    service.dispose();
    pair.client.port.close();
    pair.server.port.close();
  }
});

function trackedBackend() {
  const memory = new MemoryBackend();
  const state = { epoch: undefined as Int32Array | undefined, releasedAt: [] as number[] };
  const backend: FilesystemBackend = {
    execute: memory.execute.bind(memory),
    retain: memory.retain.bind(memory),
    release(handle) {
      if (state.epoch) state.releasedAt.push(Atomics.load(state.epoch, 0));
      memory.release(handle);
    },
  };
  return { backend, state };
}

test("a peer's evictions join the open mutation through a cloned view of the same epoch", async () => {
  const { backend, state } = trackedBackend();
  const service = new FilesystemService(backend);
  const identity = createFilesystemIdentity(undefined, 16 * 1024 * 1024);
  const pair = connectFilesystemIdentity(identity);
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  // A peer sharing the tree's epoch memory through a distinct structured-cloned wrapper.
  const peerIdentity = createFilesystemIdentity(identity);
  peerIdentity.epoch = structuredClone(peerIdentity.epoch);
  expect(peerIdentity.epoch).not.toBe(identity.epoch);
  const peerPair = connectFilesystemIdentity(peerIdentity);
  service.connect(peerPair.server);
  const peer = new FilesystemClient(peerPair.client);
  try {
    const count = TRANSIENT_HANDLES + 44;
    await client.asyncCall("mkdirp", ["/many"]);
    for (let index = 0; index < count; index++)
      await client.asyncCall("writeFile", [`/many/${index}`], new Uint8Array([index & 255]));
    const root = await peer.asyncCall("preopen", ["/"]);
    const held = new Set<number>();
    for (let index = 0; index < count; index++) {
      const node: number = (await peer.asyncCall("resolve", [root, `many/${index}`])).node;
      peer.retain(node);
      held.add(node);
    }
    // A discarded response trims its session, so let every discard arrive first.
    for (let wait = 0; service.resources().responses && wait < 500; wait++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(service.resources().responses).toBe(0);
    // Drop the peer's references directly, as a guest's release would, before its own trim
    // hint arrives. Only the next mutation's trim of every session can now evict them.
    const entries = new Int32Array(peerPair.client.capabilities, 0, CAPABILITY_LENGTH);
    for (let key = CAPABILITY_HEADER; key < entries.length; key += CAPABILITY_WORDS)
      if (held.has(Atomics.load(entries, key)) && Atomics.load(entries, key + 1) === 1)
        Atomics.store(entries, key + 1, 0);
    state.epoch = new Int32Array(pair.client.epoch);
    const before = Atomics.load(state.epoch, 0);
    expect(before & 1).toBe(0);
    await client.asyncCall("mkdirp", ["/other"]);
    expect(state.releasedAt.length).toBeGreaterThan(TRANSIENT_HANDLES / 2);
    // Every peer eviction ran inside the request's one odd epoch, the only mutation.
    expect(new Set(state.releasedAt)).toEqual(new Set([before + 1]));
    expect(Atomics.load(state.epoch, 0)).toBe(before + 2);
  } finally {
    peer.dispose();
    client.dispose();
    await service.drainForOwner();
    service.dispose();
    for (const port of [
      pair.client.port,
      pair.server.port,
      peerPair.client.port,
      peerPair.server.port,
    ])
      port.close();
  }
});

test("a failed segment offer after a mutation fails the request and closes its epoch", async () => {
  const { backend } = trackedBackend();
  // Each request offers segments twice; fail only the offer in its final cleanup.
  let calls = 0,
    failAt = 0;
  backend.takeSharedSegments = () => {
    calls++;
    if (calls === failAt) throw new Error("segment offer failed");
    return [];
  };
  const service = new FilesystemService(backend);
  const pair = connectFilesystemIdentity(createFilesystemIdentity(undefined, 16 * 1024 * 1024));
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  const epoch = new Int32Array(pair.client.epoch);
  try {
    await client.asyncCall("mkdirp", ["/first"]);
    const before = Atomics.load(epoch, 0);
    failAt = calls + 2;
    const outcome = await client.asyncCall("mkdirp", ["/second"]).then(
      () => "completed",
      (error) => String(error),
    );
    expect(outcome).not.toBe("completed");
    expect(calls).toBe(failAt);
    expect(Atomics.load(epoch, 0)).toBe(before + 2);
    // The next mutation opens and closes normally.
    await client.asyncCall("mkdirp", ["/third"]);
    expect(Atomics.load(epoch, 0)).toBe(before + 4);
    expect(await client.asyncCall("lookup", ["/third"])).toMatchObject({ kind: "dir" });
  } finally {
    client.dispose();
    await service.drainForOwner();
    service.dispose();
    pair.client.port.close();
    pair.server.port.close();
  }
});
