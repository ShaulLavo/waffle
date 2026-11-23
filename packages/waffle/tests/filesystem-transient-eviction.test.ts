import { expect, test } from "bun:test";
import { FilesystemClient, FilesystemService, MemoryBackend, type FilesystemBackend } from "../fs";
import {
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
