import { afterEach, expect, test } from "bun:test";
import { FilesystemClient, FilesystemService, MemoryBackend, type FilesystemBackend } from "../fs";
import { createFilesystemConnection } from "../fs/protocol";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0).reverse()) await stop();
});

function fixture(wrap?: (memory: MemoryBackend) => FilesystemBackend) {
  const memory = new MemoryBackend();
  const service = new FilesystemService(wrap ? wrap(memory) : memory);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  cleanups.push(async () => {
    client.dispose();
    await service.drainForOwner();
    service.dispose();
  });
  const sessions = Reflect.get(service, "sessions") as Set<{ transient: Map<number, true> }>;
  const transient = () => Array.from(sessions)[0]!.transient;
  return { memory, client, transient };
}

/** Polls an outcome, with a generous cap that only catches a hang. */
async function eventually(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition never held");
    await new Promise((done) => setTimeout(done, 1));
  }
}

test("trims skip their scan while nothing is unlinked and collect a removed file at once", async () => {
  const { memory, client, transient } = fixture();
  await client.asyncCall("writeFile", ["/a"], new Uint8Array([1]));
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "a"]);
  const handle = path.node as number;
  expect(transient().has(handle)).toBe(true);
  let scans = 0;
  const isUnlinked = memory.shared.isUnlinked.bind(memory.shared);
  memory.shared.isUnlinked = (target) => {
    scans++;
    return isUnlinked(target);
  };
  for (let index = 0; index < 20; index++)
    expect((await client.asyncCall("stat", [handle])).size).toBe(1);
  expect(scans).toBe(0);
  await client.asyncCall("removePath", [path, false]);
  expect(scans).toBeGreaterThan(0);
  expect(transient().has(handle)).toBe(false);
});

test("a file unlinked while referenced is collected when its last reference goes", async () => {
  const { client, transient } = fixture();
  await client.asyncCall("writeFile", ["/b"], new Uint8Array([2]));
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "b"]);
  const handle = path.node as number;
  client.retain(handle);
  await client.asyncCall("removePath", [path, false]);
  // Still referenced, so the trim after the removal keeps it.
  expect(transient().has(handle)).toBe(true);
  // Later trims see nothing new unlinked, yet must not forget the referenced one.
  await client.asyncCall("stat", [root]);
  client.release(handle);
  await eventually(() => !transient().has(handle));
});

test("a backend that reports unlinks without a generation is rescanned on every trim", async () => {
  let scans = 0;
  const { client } = fixture((memory) => ({
    execute: memory.execute.bind(memory),
    retain: memory.retain.bind(memory),
    release: memory.release.bind(memory),
    isUnlinked(handle) {
      scans++;
      return memory.shared.isUnlinked(handle);
    },
  }));
  await client.asyncCall("writeFile", ["/c"], new Uint8Array([3]));
  const root = await client.asyncCall("preopen", ["/"]);
  const handle = (await client.asyncCall("resolve", [root, "c"])).node as number;
  const before = scans;
  for (let index = 0; index < 5; index++) await client.asyncCall("stat", [handle]);
  expect(scans - before).toBeGreaterThanOrEqual(5);
});

test("an unlink through a backend wrapper over the same table is seen by the next trim", async () => {
  const { memory, client, transient } = fixture();
  await client.asyncCall("writeFile", ["/w"], new Uint8Array([4]));
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "w"]);
  const handle = path.node as number;
  client.retain(handle);
  // A trim scan with nothing unlinked records the generation.
  await client.asyncCall("stat", [root]);
  const wrapper = new MemoryBackend(undefined, undefined, memory);
  await wrapper.execute("removePath", [path, false], new Uint8Array(), () => false);
  expect(memory.shared.isUnlinked(handle)).toBe(true);
  client.release(handle);
  await client.asyncCall("stat", [root]);
  await eventually(() => !transient().has(handle));
});
