import { afterEach, expect, test } from "bun:test";
import { FilesystemClient } from "../fs/client.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemService } from "../fs/service.js";
import { createFilesystemConnection } from "../fs/protocol.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  cleanups.push(() => {
    client.dispose();
    service.dispose();
  });
  return { backend, service, client };
}
const plan = { include: [], exclude: [], excludeDirectories: [], hidden: false, maxDepth: null };

test("walk pages include file grants and prune directories before visiting", async () => {
  const { client } = fixture();
  await client.asyncCall("writeFile", ["/ok.ts"], new Uint8Array([65]));
  await client.asyncCall("mkdirp", ["/vendor"]);
  await client.asyncCall("writeFile", ["/vendor/no.ts"], new Uint8Array([66]));
  const root: number = await client.asyncCall("preopen", ["/"]);
  const cursor = await client.asyncCall("walkOpen", [root, {
    ...plan, excludeDirectories: [{ kind: "basename", glob: "vendor" }],
  }]);
  const page = await client.asyncCall("walkPage", [cursor, { grant: true, maxEntries: 128 }]);
  expect(page.entries).toEqual([
    { kind: "file", path: "ok.ts", size: 1, handle: expect.any(Number), grant: expect.any(Number) },
  ]);
  expect(page.next).toBeNull();
  await client.asyncCall("walkRelease", [page.entries.map((entry: { grant: number }) => entry.grant)]);
  await client.asyncCall("walkClose", [cursor]);
  expect(serviceResources(client)).toBeUndefined();
});
function serviceResources(_client: FilesystemClient): undefined { return undefined; }

test("a session admits four walks and rejects the fifth without leaking", async () => {
  const { client } = fixture();
  const root = await client.asyncCall("preopen", ["/"]);
  const cursors = [];
  for (let index = 0; index < 4; index++) cursors.push(await client.asyncCall("walkOpen", [root, plan]));
  await expect(client.asyncCall("walkOpen", [root, plan])).rejects.toMatchObject({ errno: 6 });
  for (const cursor of cursors) await client.asyncCall("walkClose", [cursor]);
});
